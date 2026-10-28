// The Gitleaks adapter's in-container worker: an original POSIX shell shim that speaks the sentinel-worker protocol for
// Gitleaks inside its unmodified official image (alpine based: busybox sh and applets, no Node, no Python). It runs as
// `/bin/sh /input/<its own digest>` under PR 07's container controls; inputs are read-only and sealed 0444, so nothing
// supplied as an input is executed, and the shim itself is pinned by the adapter digest.
//
// Inputs, in any order: this shim, the job file, each captured content once, and (from the canonical coordinator) its
// own job record. The shim finds its job by exclusion (see below), never by position. The job
// names each file as `F <index> <content hex> <source-relative path>`; the shim rebuilds the tree in the tmpfs one folder
// below the scan root (so a captured root `.gitleaksignore` is an ordinary scanned file, never an ignore list), writes
// the pinned configuration and report template itself, and runs Gitleaks once with fixed arguments: an empty ignore
// folder, `--ignore-gitleaks-allow`, full redaction, no baseline.
//
// Names: the shim also writes every name the job lists (sent files, then `N` names) to `scan/paths.txt`, beside
// the tree, so the same engine screens the names themselves.
//
// What leaves the container: a report naming only the rule, the lines and a reference — `F … <index>` for a sent
// file, `P …` for a line of the names file, `U` for anything else — never a path, the match, the secret or the line
// text (the pinned template renders the engine's findings; an awk pass inside the container maps each path to its
// job index and the raw rendering is deleted), and a run record with the exit code, a fixed failure category and
// digests. Gitleaks' stdout is discarded; its stderr stays in the tmpfs and only its digest is reported,
// because a tool message can quote input. A fatal shim error writes one catalog code to stderr and exits 3.
/**
 * The worker's source text; `[MAX_REPORT]`, `[SECS]`, `[MAX_MB]` and `[ENGINE_ARGS]` are filled by
 * buildGitleaksAdapter.
 */
export const GITLEAKS_WORKER_SOURCE = `# Sentinel Gitleaks worker (sentinel-gitleaks-worker/1). Original; POSIX sh and busybox applets only.
set -u
P='sentinel-worker/draft-1'
MAX_REPORT=[MAX_REPORT]
SECS=[SECS]
MAX_MB=[MAX_MB]
ENGINE_ARGS='[ENGINE_ARGS]'
W=/tmp/sentinel-gitleaks
say() { printf '%s\\n' "$1"; }
die() { printf 'sentinel-gitleaks-worker/1 %s\\n' "$1" >&2; rm -rf "$W"; exit 3; }
case "\${SENTINEL_ADAPTER_ID:-}:\${SENTINEL_ADAPTER_DIGEST:-}" in
  :*|*:|*[!A-Za-z0-9._:-]*) exit 2 ;;
esac
say "{\\"protocol\\":\\"$P\\",\\"type\\":\\"hello\\",\\"supported\\":[\\"$P\\"],\\"adapterId\\":\\"$SENTINEL_ADAPTER_ID\\",\\"adapterDigest\\":\\"$SENTINEL_ADAPTER_DIGEST\\"}"
IFS= read -r welcome || exit 2
case "$welcome" in *'"type":"welcome"'*) ;; *) die 'sentinel.secrets.protocolInvalid' ;; esac
IFS= read -r start || exit 2
case "$start" in *'"type":"start"'*) ;; *) die 'sentinel.secrets.protocolInvalid' ;; esac
field() { printf '%s' "$start" | sed -n "s/.*\\"$1\\":\\"\\([A-Za-z0-9._:-]*\\)\\".*/\\1/p"; }
ATT=$(field attemptId); EPOCH=$(field coordinatorEpoch); FP=$(field inputFingerprint)
WID=$(printf '%s' "$start" | sed -n 's/.*"work":{"id":"\\([A-Za-z0-9._:-]*\\)","revision":\\([0-9]*\\)}.*/\\1/p')
WREV=$(printf '%s' "$start" | sed -n 's/.*"work":{"id":"[A-Za-z0-9._:-]*","revision":\\([0-9]*\\)}.*/\\1/p')
[ -n "$ATT" ] && [ -n "$EPOCH" ] && [ -n "$FP" ] && [ -n "$WID" ] && [ -n "$WREV" ] || die 'sentinel.secrets.protocolInvalid'
INPUTS=$(printf '%s' "$start" | sed -n 's/.*"inputs":\\[\\([^]]*\\)\\].*/\\1/p' | tr ',' '\\n' | sed -n 's/^"sha256:\\([0-9a-f]\\{64\\}\\)"$/\\1/p')
SEQ=0
bound() { printf '"attemptId":"%s","work":{"id":"%s","revision":%s},"coordinatorEpoch":"%s","seq":%s' "$ATT" "$WID" "$WREV" "$EPOCH" "$SEQ"; SEQ=$((SEQ + 1)); }

# The job is the one input that is neither this shim nor a captured source the coordinator names in inputScopes, and
# whose first line says so. Order is not authority: a captured file that looks like a job is a source, never the job,
# and without inputScopes two job-shaped inputs are refused, not guessed. The run record names the job's digest, which
# the coordinator checks against the job it sealed.
SELF=\${0##*/}
SOURCES=" $(printf '%s' "$start" | grep -o '"input":"sha256:[0-9a-f]\\{64\\}"' | sed 's/.*sha256:\\([0-9a-f]*\\)"$/\\1/' | tr '\\n' ' ')"
JOB=''
COUNT=0
for h in $INPUTS; do
  [ "$h" = "$SELF" ] && continue
  case "$SOURCES" in *" $h "*) continue ;; esac
  if [ "$(head -n 1 "/input/$h" 2>/dev/null)" = 'sentinel-gitleaks-job/1' ]; then JOB=$h; COUNT=$((COUNT + 1)); fi
done
[ "$COUNT" -eq 1 ] || die 'sentinel.secrets.inputInvalid'

rm -rf "$W"
mkdir -p "$W/scan/tree" "$W/no-ignores" || die 'sentinel.secrets.workerError'
: > "$W/scan/paths.txt" || die 'sentinel.secrets.workerError'
printf '%s' '[CONFIG]' > "$W/gitleaks.toml" || die 'sentinel.secrets.workerError'
printf '%s' '[TEMPLATE]' > "$W/report.tmpl" || die 'sentinel.secrets.workerError'
FIRST=1
while IFS= read -r line; do
  if [ "$FIRST" = 1 ]; then FIRST=0; continue; fi
  case "$line" in
    'F '*)
      rest=\${line#F }
      idx=\${rest%% *}; rest=\${rest#"$idx "}
      hex=\${rest%% *}; path=\${rest#"$hex "}
      case "$idx" in ''|*[!0-9]*) die 'sentinel.secrets.inputInvalid' ;; esac
      case "$hex" in *[!0-9a-f]*) die 'sentinel.secrets.inputInvalid' ;; esac
      [ \${#hex} -eq 64 ] && [ -n "$path" ] && [ "$path" != "$hex" ] || die 'sentinel.secrets.inputInvalid'
      case "/$path/" in *'/../'*|*'/./'*|*'//'*) die 'sentinel.secrets.inputInvalid' ;; esac
      [ -f "/input/$hex" ] || die 'sentinel.secrets.inputInvalid'
      target="$W/scan/tree/$path"
      [ -e "$target" ] && die 'sentinel.secrets.inputInvalid'
      mkdir -p "$(dirname "$target")" && cp "/input/$hex" "$target" || die 'sentinel.secrets.inputInvalid'
      printf '%s\n' "$path" >> "$W/scan/paths.txt" || die 'sentinel.secrets.workerError'
      ;;
    'N '*)
      path=\${line#N }
      [ -n "$path" ] || die 'sentinel.secrets.inputInvalid'
      printf '%s\n' "$path" >> "$W/scan/paths.txt" || die 'sentinel.secrets.workerError'
      ;;
    *) die 'sentinel.secrets.inputInvalid' ;;
  esac
done < "/input/$JOB"

cd "$W" || die 'sentinel.secrets.workerError'
# shellcheck disable=SC2086 # ENGINE_ARGS are fixed plain tokens
HOME=/tmp timeout -s KILL "$SECS" gitleaks dir scan --config "$W/gitleaks.toml" --gitleaks-ignore-path "$W/no-ignores" \\
  --ignore-gitleaks-allow --redact=100 --report-format template --report-template "$W/report.tmpl" --report-path "$W/raw.txt" \\
  --exit-code 2 --max-target-megabytes "$MAX_MB" --no-banner --no-color --log-level error $ENGINE_ARGS > /dev/null 2> "$W/err.txt"
CODE=$?
FAILURE=null
case "$CODE" in
  0|2) [ -f "$W/raw.txt" ] || FAILURE='"reportMissing"' ;;
  137) FAILURE='"killed"' ;;
  *) FAILURE='"engineError"' ;;
esac
# Paths never leave the container: each reported file becomes its job index (F), the names file becomes P, and
# anything else U. The raw rendering is removed before any output is written.
if [ "$FAILURE" = null ]; then
  cat > "$W/map.awk" <<'AWK'
BEGIN { FS = "\t"; OFS = "\t" }
FNR == NR {
  if (substr($0, 1, 2) == "F ") {
    rest = substr($0, 3); sp = index(rest, " "); idx = substr(rest, 1, sp - 1); rest = substr(rest, sp + 1)
    sp = index(rest, " "); byPath[substr(rest, sp + 1)] = idx
  }
  next
}
{
  file = $5
  for (i = 6; i <= NF; i++) file = file "\t" $i
  if ($1 != "F" || NF < 5) { print "U"; next }
  if (file == "scan/paths.txt") { print "P", $2, $3, $4; next }
  rel = substr(file, 11)
  if (substr(file, 1, 10) == "scan/tree/" && (rel in byPath)) { print "F", $2, $3, $4, byPath[rel]; next }
  print "U"
}
AWK
  awk -f "$W/map.awk" "/input/$JOB" "$W/raw.txt" > "$W/report.txt" || FAILURE='"engineError"'
fi
rm -f "$W/raw.txt"
SIZE=0
REPORT=''
if [ "$FAILURE" = null ]; then
  SIZE=$(wc -c < "$W/report.txt" | tr -d ' ')
  if [ "$SIZE" -gt "$MAX_REPORT" ]; then FAILURE='"reportTooLarge"'; else REPORT=$(sha256sum "$W/report.txt" | cut -c1-64); fi
fi
ERRD=$(sha256sum "$W/err.txt" | cut -c1-64)
if [ -n "$REPORT" ]; then RJSON="\\"sha256:$REPORT\\""; else RJSON=null; fi
printf '{"schema":"sentinel-gitleaks-run/draft-1","job":"sha256:%s","exitCode":%s,"failure":%s,"report":%s,"reportBytes":%s,"stderrDigest":"sha256:%s"}' \\
  "$JOB" "$CODE" "$FAILURE" "$RJSON" "$SIZE" "$ERRD" > "$W/record.json" || die 'sentinel.secrets.workerError'
REC=$(sha256sum "$W/record.json" | cut -c1-64)
RSIZE=$(wc -c < "$W/record.json" | tr -d ' ')
cp "$W/record.json" "/output/$REC" || die 'sentinel.secrets.workerError'
ARTS="{\\"id\\":\\"sha256:$REC\\",\\"mediaType\\":\\"application/vnd.sentinel.gitleaks-run+json\\",\\"bytes\\":$RSIZE}"
if [ -n "$REPORT" ]; then
  if [ "$REPORT" != "$REC" ]; then cp "$W/report.txt" "/output/$REPORT" || die 'sentinel.secrets.workerError'; fi
  ARTS="$ARTS,{\\"id\\":\\"sha256:$REPORT\\",\\"mediaType\\":\\"application/vnd.sentinel.gitleaks-report\\",\\"bytes\\":$SIZE}"
fi
rm -rf "$W"
say "{\\"protocol\\":\\"$P\\",\\"type\\":\\"result\\",$(bound),\\"inputFingerprint\\":\\"$FP\\",\\"granularity\\":\\"per-file\\",\\"artifacts\\":[$ARTS],\\"observations\\":[],\\"coveredChecks\\":[],\\"scannedSet\\":[],\\"skipped\\":[],\\"actualReadSet\\":[],\\"unresolvedFrontiers\\":[],\\"diagnostics\\":[]}"
exit 0
`;
