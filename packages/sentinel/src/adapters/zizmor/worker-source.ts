// The zizmor adapter's in-container worker: an original POSIX shell shim that speaks the sentinel-worker protocol for
// zizmor inside its unmodified official image (Wolfi based: sh and coreutils). It runs as `/bin/sh /input/<its own
// digest>` under PR 07's container controls; inputs are read-only and sealed 0444, so nothing supplied as an input is
// executed.
//
// It reads only values the coordinator constrains: protocol ids and digests (fixed character sets), integer target
// indexes and relative paths limited to [A-Za-z0-9._/-] with no empty, `.` or `..` segment. Files are copied under
// those paths so zizmor collects them by its own layout rules. No token is present: the GitHub variables zizmor reads
// are unset and it runs with --offline. The engine log never leaves the container: only the job's own paths, audit
// identifiers ([a-z-]) and the engine's version digits are extracted from it.
export const ZIZMOR_WORKER_SOURCE = `# Sentinel zizmor worker (sentinel-zizmor-worker/1). Original; POSIX sh only.
set -u
P='sentinel-worker/draft-1'
MAX_OUT=[MAX_OUT]
ENGINE_ARGS='[ENGINE_ARGS]'
say() { printf '%s\\n' "$1"; }
case "\${SENTINEL_ADAPTER_ID:-}:\${SENTINEL_ADAPTER_DIGEST:-}" in
  *[!A-Za-z0-9._:-]*) exit 2 ;;
esac
say "{\\"protocol\\":\\"$P\\",\\"type\\":\\"hello\\",\\"supported\\":[\\"$P\\"],\\"adapterId\\":\\"$SENTINEL_ADAPTER_ID\\",\\"adapterDigest\\":\\"$SENTINEL_ADAPTER_DIGEST\\"}"
IFS= read -r welcome || exit 2
case "$welcome" in *'"type":"welcome"'*) ;; *) exit 2 ;; esac
IFS= read -r start || exit 2
case "$start" in *'"type":"start"'*) ;; *) exit 2 ;; esac
field() { printf '%s' "$start" | sed -n "s/.*\\"$1\\":\\"\\([A-Za-z0-9._:-]*\\)\\".*/\\1/p"; }
ATT=$(field attemptId); EPOCH=$(field coordinatorEpoch); FP=$(field inputFingerprint)
WID=$(printf '%s' "$start" | sed -n 's/.*"work":{"id":"\\([A-Za-z0-9._:-]*\\)","revision":\\([0-9]*\\)}.*/\\1/p')
WREV=$(printf '%s' "$start" | sed -n 's/.*"work":{"id":"[A-Za-z0-9._:-]*","revision":\\([0-9]*\\)}.*/\\1/p')
[ -n "$ATT" ] && [ -n "$EPOCH" ] && [ -n "$FP" ] && [ -n "$WID" ] && [ -n "$WREV" ] || exit 2
INPUTS=$(printf '%s' "$start" | sed -n 's/.*"inputs":\\[\\([^]]*\\)\\].*/\\1/p' | tr ',' '\\n' | sed -n 's/^"sha256:\\([0-9a-f]\\{64\\}\\)"$/\\1/p')
SEQ=0
# The frame's binding, with the next sequence number. Set in this shell, never in a command substitution (a subshell
# would not advance SEQ, and a repeated sequence number is a protocol violation).
bound() { BOUND=$(printf '"attemptId":"%s","work":{"id":"%s","revision":%s},"coordinatorEpoch":"%s","seq":%s' "$ATT" "$WID" "$WREV" "$EPOCH" "$SEQ"); SEQ=$((SEQ + 1)); }
diag() { bound; say "{\\"protocol\\":\\"$P\\",\\"type\\":\\"diagnostic\\",$BOUND,\\"code\\":\\"$1\\"}"; }
fail() { diag "$1"; exit 3; }

JOB=''
COUNT=0
for h in $INPUTS; do
  if [ "$(head -c 22 "/input/$h" 2>/dev/null)" = 'sentinel-zizmor-job/1' ]; then JOB=$h; COUNT=$((COUNT + 1)); fi
done
[ "$COUNT" -eq 1 ] || fail 'sentinel.zizmor.jobAmbiguous'

W=/tmp/sentinel-zizmor
mkdir -p "$W/src" "$W/run" || exit 2
: > "$W/allowed"
SECS=100
TARGETS=0
while IFS=' ' read -r kind a b c; do
  case "$kind" in
    sentinel-zizmor-job/1) ;;
    S) case "$a" in ''|*[!0-9]*) fail 'sentinel.zizmor.jobInvalid' ;; esac; SECS=$a ;;
    T)
      case "$a" in ''|*[!0-9]*) fail 'sentinel.zizmor.jobInvalid' ;; esac
      case "$b" in *[!0-9a-f]*|'') fail 'sentinel.zizmor.jobInvalid' ;; esac
      case "$c" in
        ''|/*|*/|*//*|.|..|./*|../*|*/.|*/..|*/./*|*/../*|*[!A-Za-z0-9._/-]*) fail 'sentinel.zizmor.jobInvalid' ;;
      esac
      [ -f "/input/$b" ] || fail 'sentinel.zizmor.targetMissing'
      case "$c" in */*) mkdir -p "$W/src/\${c%/*}" || exit 2 ;; esac
      cp "/input/$b" "$W/src/$c" || exit 2
      printf '%s\\n' "$c" >> "$W/allowed"
      TARGETS=$((TARGETS + 1)) ;;
    '') ;;
    *) fail 'sentinel.zizmor.jobInvalid' ;;
  esac
done < "/input/$JOB"
[ "$TARGETS" -gt 0 ] || fail 'sentinel.zizmor.jobInvalid'

BEGAN=$(date +%s)
cd "$W/run" || exit 2
unset GH_TOKEN GITHUB_TOKEN ZIZMOR_GITHUB_TOKEN ZIZMOR_CONFIG GH_HOST
# shellcheck disable=SC2086 # ENGINE_ARGS are fixed plain tokens
HOME=/tmp timeout -s KILL "$SECS" zizmor $ENGINE_ARGS "$W/src" > "$W/out.json" 2> "$W/err.txt"
CODE=$?
ELAPSED=$(( $(date +%s) - BEGAN ))
TIMED=false
CATEGORY=''
case "$CODE" in
  0|3|11|12|13|14) ;;
  137) if [ "$ELAPSED" -ge "$SECS" ]; then TIMED=true; fi; CATEGORY=killed ;;
  1) CATEGORY=engineError ;;
  2) CATEGORY=usage ;;
  *) CATEGORY=unknown ;;
esac
SIZE=$(wc -c < "$W/out.json" | tr -d ' ')
TRUNC=false
if [ "$SIZE" -gt "$MAX_OUT" ]; then TRUNC=true; fi
# An over-long report is not published: an empty file is, and the record names those bytes, the original size and
# the truncation, so what the coordinator reads is exactly what the record describes.
if [ "$TRUNC" = true ]; then : > "$W/out.json"; fi
# Positive evidence from the engine's own log, as the job's own paths and audit identifiers only.
paths() { sed -n "$1" "$W/err.txt" | grep -Fx -f "$W/allowed" | sort -u | sed 's/.*/"&"/' | tr '\\n' ',' | sed 's/,$//'; }
REGISTERED=$(paths "s/.* input as with key file:\\/\\/\\/tmp\\/sentinel-zizmor\\/src\\/\\([A-Za-z0-9._/-]*\\)$/\\1/p")
COMPLETED=$(paths "s/.* completed \\/tmp\\/sentinel-zizmor\\/src\\/\\([A-Za-z0-9._/-]*\\)$/\\1/p")
SKIPPED=$(sed -n 's/.*zizmor::registry: skipping \\([a-z][a-z0-9-]*\\): .*/\\1/p' "$W/err.txt" | sort -u | sed 's/.*/"&"/' | tr '\\n' ',' | sed 's/,$//')
VERSION=$(sed -n 's/.* zizmor v\\([0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\)$/\\1/p' "$W/err.txt" | head -n 1)
OUT=$(sha256sum "$W/out.json" | cut -c1-64)
ERRD=$(sha256sum "$W/err.txt" | cut -c1-64)
if [ -n "$CATEGORY" ]; then
  diag "sentinel.zizmor.engine.$CATEGORY"
  FAILURE="{\\"category\\":\\"$CATEGORY\\",\\"exitCode\\":$CODE}"
  printf 'sentinel.zizmor.engine.%s exit %s\\n' "$CATEGORY" "$CODE" >&2
else
  FAILURE=null
fi
printf '{"schema":"sentinel-zizmor-run/draft-1","job":"sha256:%s","exitCode":%s,"timedOut":%s,"stdoutBytes":%s,"stdoutTruncated":%s,"engineOutput":"sha256:%s","stderrDigest":"sha256:%s","failure":%s,"version":"%s","registered":[%s],"completed":[%s],"skippedAudits":[%s]}' \\
  "$JOB" "$CODE" "$TIMED" "$SIZE" "$TRUNC" "$OUT" "$ERRD" "$FAILURE" "$VERSION" "$REGISTERED" "$COMPLETED" "$SKIPPED" > "$W/record.json"
REC=$(sha256sum "$W/record.json" | cut -c1-64)
RSIZE=$(wc -c < "$W/record.json" | tr -d ' ')
cp "$W/out.json" "/output/$OUT" && cp "$W/record.json" "/output/$REC" || exit 2
OSIZE=$(wc -c < "/output/$OUT" | tr -d ' ')
bound
say "{\\"protocol\\":\\"$P\\",\\"type\\":\\"result\\",$BOUND,\\"inputFingerprint\\":\\"$FP\\",\\"granularity\\":\\"per-file\\",\\"artifacts\\":[{\\"id\\":\\"sha256:$OUT\\",\\"mediaType\\":\\"application/vnd.zizmor.findings+json\\",\\"bytes\\":$OSIZE},{\\"id\\":\\"sha256:$REC\\",\\"mediaType\\":\\"application/vnd.sentinel.zizmor-run+json\\",\\"bytes\\":$RSIZE}],\\"observations\\":[],\\"coveredChecks\\":[],\\"scannedSet\\":[],\\"skipped\\":[],\\"actualReadSet\\":[],\\"unresolvedFrontiers\\":[],\\"diagnostics\\":[]}"
exit 0
`;
