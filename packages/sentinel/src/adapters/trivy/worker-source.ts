// The Trivy adapter's in-container worker: an original POSIX shell shim that speaks the sentinel-worker protocol for
// Trivy inside its unmodified official image (Alpine based: busybox sh). It runs as `/bin/sh /input/<its own digest>`
// under PR 07's container controls; inputs are read-only and sealed 0444, so nothing supplied as an input is executed.
//
// It reads only values the coordinator constrains: protocol ids and digests (fixed character sets), integer target
// indexes and relative paths limited to [A-Za-z0-9._/-] with no empty, `.` or `..` segment. The captured files are
// copied under those paths so Terraform modules keep their folders; the coordinator maps every reported path back to
// its captured artifact. The pinned checks bundle is unpacked into Trivy's cache layout and updates are skipped. Trivy
// silently falls back to the checks embedded in its binary when that cache is missing, so the worker reports the
// engine's own "loaded from disk" evidence and the coordinator refuses a run without it. The engine log never leaves
// the container: only fixed words, digits and paths from the job's own list are extracted from it.
export const TRIVY_WORKER_SOURCE = `# Sentinel Trivy worker (sentinel-trivy-worker/1). Original; POSIX sh and busybox applets only.
set -u
P='sentinel-worker/draft-1'
MAX_OUT=[MAX_OUT]
ENGINE_ARGS='[ENGINE_ARGS]'
BUNDLE_LAYER='[BUNDLE_LAYER]'
TAB=$(printf '\\t')
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
  if [ "$(head -c 21 "/input/$h" 2>/dev/null)" = 'sentinel-trivy-job/1' ]; then JOB=$h; COUNT=$((COUNT + 1)); fi
done
[ "$COUNT" -eq 1 ] || fail 'sentinel.trivy.jobAmbiguous'

W=/tmp/sentinel-trivy
mkdir -p "$W/src" "$W/run" "$W/c/policy/content" || exit 2
printf '.\\n' > "$W/allowed"
SECS=100
BUNDLE=''
TARGETS=0
while IFS=' ' read -r kind a b c; do
  case "$kind" in
    sentinel-trivy-job/1) ;;
    S) case "$a" in ''|*[!0-9]*) fail 'sentinel.trivy.jobInvalid' ;; esac; SECS=$a ;;
    B)
      case "$a" in *[!0-9a-f]*|'') fail 'sentinel.trivy.jobInvalid' ;; esac
      [ "sha256:$a" = "$BUNDLE_LAYER" ] || fail 'sentinel.trivy.bundleUnsupported'
      [ -f "/input/$a" ] || fail 'sentinel.trivy.bundleMissing'
      [ "$(sha256sum "/input/$a" | cut -c1-64)" = "$a" ] || fail 'sentinel.trivy.bundleUnsupported'
      BUNDLE=$a ;;
    T)
      case "$a" in ''|*[!0-9]*) fail 'sentinel.trivy.jobInvalid' ;; esac
      case "$b" in *[!0-9a-f]*|'') fail 'sentinel.trivy.jobInvalid' ;; esac
      case "$c" in
        ''|/*|*/|*//*|.|..|./*|../*|*/.|*/..|*/./*|*/../*|*[!A-Za-z0-9._/-]*) fail 'sentinel.trivy.jobInvalid' ;;
      esac
      [ -f "/input/$b" ] || fail 'sentinel.trivy.targetMissing'
      case "$c" in */*) mkdir -p "$W/src/\${c%/*}" || exit 2 ;; esac
      cp "/input/$b" "$W/src/$c" || exit 2
      printf '%s\\n' "$c" >> "$W/allowed"
      d=$c
      while case "$d" in */*) true ;; *) false ;; esac; do d=\${d%/*}; printf '%s\\n' "$d" >> "$W/allowed"; done
      TARGETS=$((TARGETS + 1)) ;;
    '') ;;
    *) fail 'sentinel.trivy.jobInvalid' ;;
  esac
done < "/input/$JOB"
[ "$TARGETS" -gt 0 ] || fail 'sentinel.trivy.jobInvalid'
[ -n "$BUNDLE" ] || fail 'sentinel.trivy.bundleMissing'
tar xzf "/input/$BUNDLE" -C "$W/c/policy/content" || fail 'sentinel.trivy.bundleUnreadable'
printf '{"Digest":"sha256:%s","DownloadedAt":"2026-10-14T08:54:43Z"}' "$BUNDLE" > "$W/c/policy/metadata.json" || exit 2

BEGAN=$(date +%s)
cd "$W/run" || exit 2
# shellcheck disable=SC2086 # ENGINE_ARGS are fixed plain tokens
HOME=/tmp timeout -s KILL "$SECS" trivy --cache-dir "$W/c" $ENGINE_ARGS --timeout "\${SECS}s" "$W/src" > "$W/out.json" 2> "$W/err.txt"
CODE=$?
ELAPSED=$(( $(date +%s) - BEGAN ))
TIMED=false
CATEGORY=''
case "$CODE" in
  0) ;;
  137) if [ "$ELAPSED" -ge "$SECS" ]; then TIMED=true; fi; CATEGORY=killed ;;
  1) CATEGORY=engineError ;;
  *) CATEGORY=unknown ;;
esac
SIZE=$(wc -c < "$W/out.json" | tr -d ' ')
TRUNC=false
if [ "$SIZE" -gt "$MAX_OUT" ]; then TRUNC=true; fi
# Positive evidence from the engine's own log, as fixed words, digits and the job's own paths only.
DISK=false; grep -q "Checks successfully loaded from disk" "$W/err.txt" && DISK=true
FALLBACK=false; grep -q "Falling back to embedded checks" "$W/err.txt" && FALLBACK=true
CHECKS=$(sed -n "s/.*Checks from disk are loaded\${TAB}count=\\([0-9][0-9]*\\)$/\\1/p" "$W/err.txt" | head -n 1)
DETECTED=$(sed -n "s/.*Detected config files\${TAB}num=\\([0-9][0-9]*\\)$/\\1/p" "$W/err.txt" | head -n 1)
paths() { sed -n "$1" "$W/err.txt" | grep -Fx -f "$W/allowed" | sort -u | sed 's/.*/"&"/' | tr '\\n' ',' | sed 's/,$//'; }
SCANNED=$(paths "s/.*Scanned config file\${TAB}file_path=\\"\\([A-Za-z0-9._/-]*\\)\\"$/\\1/p")
UNPARSED=$(paths "s/.*Failed to parse file\${TAB}file_path=\\"\\([A-Za-z0-9._/-]*\\)\\".*/\\1/p")
MODULES=$(paths "s/.*Failed to load module.*loc=\\"\\([A-Za-z0-9._/-]*\\):[0-9][0-9-]*\\".*/\\1/p")
OUT=$(sha256sum "$W/out.json" | cut -c1-64)
ERRD=$(sha256sum "$W/err.txt" | cut -c1-64)
if [ -n "$CATEGORY" ]; then
  diag "sentinel.trivy.engine.$CATEGORY"
  FAILURE="{\\"category\\":\\"$CATEGORY\\",\\"exitCode\\":$CODE}"
  printf 'sentinel.trivy.engine.%s exit %s\\n' "$CATEGORY" "$CODE" >&2
else
  FAILURE=null
fi
printf '{"schema":"sentinel-trivy-run/draft-1","job":"sha256:%s","exitCode":%s,"timedOut":%s,"stdoutBytes":%s,"stdoutTruncated":%s,"engineOutput":"sha256:%s","stderrDigest":"sha256:%s","failure":%s,"bundle":{"layer":"sha256:%s","fromDisk":%s,"fellBack":%s,"checks":%s},"detected":%s,"scanned":[%s],"unparsed":[%s],"moduleFailed":[%s]}' \\
  "$JOB" "$CODE" "$TIMED" "$SIZE" "$TRUNC" "$OUT" "$ERRD" "$FAILURE" "$BUNDLE" "$DISK" "$FALLBACK" "\${CHECKS:-null}" "\${DETECTED:-null}" "$SCANNED" "$UNPARSED" "$MODULES" > "$W/record.json"
REC=$(sha256sum "$W/record.json" | cut -c1-64)
RSIZE=$(wc -c < "$W/record.json" | tr -d ' ')
if [ "$TRUNC" = true ]; then : > "$W/out.json"; OUT=$(sha256sum "$W/out.json" | cut -c1-64); fi
cp "$W/out.json" "/output/$OUT" && cp "$W/record.json" "/output/$REC" || exit 2
OSIZE=$(wc -c < "/output/$OUT" | tr -d ' ')
bound
say "{\\"protocol\\":\\"$P\\",\\"type\\":\\"result\\",$BOUND,\\"inputFingerprint\\":\\"$FP\\",\\"granularity\\":\\"per-file\\",\\"artifacts\\":[{\\"id\\":\\"sha256:$OUT\\",\\"mediaType\\":\\"application/vnd.trivy.report+json\\",\\"bytes\\":$OSIZE},{\\"id\\":\\"sha256:$REC\\",\\"mediaType\\":\\"application/vnd.sentinel.trivy-run+json\\",\\"bytes\\":$RSIZE}],\\"observations\\":[],\\"coveredChecks\\":[],\\"scannedSet\\":[],\\"skipped\\":[],\\"actualReadSet\\":[],\\"unresolvedFrontiers\\":[],\\"diagnostics\\":[]}"
exit 0
`;
