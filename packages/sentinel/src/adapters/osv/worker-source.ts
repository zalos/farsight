// The OSV adapter's in-container worker: an original POSIX shell shim that speaks the sentinel-worker protocol for
// OSV-Scanner inside its unmodified official image (golang:alpine based: busybox sh, no Python). It runs as
// `/bin/sh /input/<its own digest>` under PR 07's container controls; inputs are read-only and sealed 0444, so nothing
// supplied as an input is ever executed.
//
// It reads only values the coordinator constrains: protocol ids and digests (fixed character sets), integer target
// indexes, ecosystem names and dependency-file basenames from fixed lists. Real relative paths never enter the
// container; the coordinator maps each index back. The scan is fully offline (`--offline`): databases are the job's
// pinned snapshot zips, linked read-only into the layout OSV-Scanner 2.7 expects. Engine stderr is never forwarded or
// stored; only its digest, the exit code and a fixed category are reported.
export const OSV_WORKER_SOURCE = `# Sentinel OSV worker (sentinel-osv-worker/1). Original; POSIX sh and busybox applets only.
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
bound() { printf '"attemptId":"%s","work":{"id":"%s","revision":%s},"coordinatorEpoch":"%s","seq":%s' "$ATT" "$WID" "$WREV" "$EPOCH" "$SEQ"; SEQ=$((SEQ + 1)); }
diag() { say "{\\"protocol\\":\\"$P\\",\\"type\\":\\"diagnostic\\",$(bound),\\"code\\":\\"$1\\"}"; }
fail() { diag "$1"; exit 3; }

JOB=''
COUNT=0
for h in $INPUTS; do
  if [ "$(head -c 19 "/input/$h" 2>/dev/null)" = 'sentinel-osv-job/1' ]; then JOB=$h; COUNT=$((COUNT + 1)); fi
done
[ "$COUNT" -eq 1 ] || fail 'sentinel.osv.jobAmbiguous'

W=/tmp/sentinel-osv
mkdir -p "$W/db/osv-scalibr" || exit 2
ARGS=''
SECS=100
while IFS=' ' read -r kind a b c; do
  case "$kind" in
    sentinel-osv-job/1) ;;
    S) case "$a" in ''|*[!0-9]*) fail 'sentinel.osv.jobInvalid' ;; esac; SECS=$a ;;
    D)
      case "$a" in npm|Maven) ;; *) fail 'sentinel.osv.jobInvalid' ;; esac
      case "$b" in *[!0-9a-f]*|'') fail 'sentinel.osv.jobInvalid' ;; esac
      [ -f "/input/$b" ] || fail 'sentinel.osv.databaseMissing'
      mkdir -p "$W/db/osv-scalibr/$a" && ln -s "/input/$b" "$W/db/osv-scalibr/$a/all.zip" || exit 2 ;;
    T)
      case "$a" in ''|*[!0-9]*) fail 'sentinel.osv.jobInvalid' ;; esac
      case "$b" in package-lock.json|pnpm-lock.yaml|pom.xml|sentinel.cdx.json) ;; *) fail 'sentinel.osv.jobInvalid' ;; esac
      case "$c" in *[!0-9a-f]*|'') fail 'sentinel.osv.jobInvalid' ;; esac
      [ -f "/input/$c" ] || fail 'sentinel.osv.targetMissing'
      mkdir -p "$W/t/$a" && cp "/input/$c" "$W/t/$a/$b" || exit 2
      ARGS="$ARGS -L $W/t/$a/$b" ;;
    '') ;;
    *) fail 'sentinel.osv.jobInvalid' ;;
  esac
done < "/input/$JOB"
[ -n "$ARGS" ] || fail 'sentinel.osv.jobInvalid'

BEGAN=$(date +%s)
# shellcheck disable=SC2086 # ENGINE_ARGS and ARGS are fixed tokens and checked paths
OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY="$W/db" HOME=/tmp timeout -s KILL "$SECS" /osv-scanner $ENGINE_ARGS $ARGS > "$W/out.json" 2> "$W/err.txt"
CODE=$?
ELAPSED=$(( $(date +%s) - BEGAN ))
TIMED=false
CATEGORY=''
case "$CODE" in
  0|1) ;;
  137) if [ "$ELAPSED" -ge "$SECS" ]; then TIMED=true; fi; CATEGORY=killed ;;
  127) CATEGORY=engineError ;;
  128) CATEGORY=noPackages ;;
  *) CATEGORY=unknown ;;
esac
SIZE=$(wc -c < "$W/out.json" | tr -d ' ')
TRUNC=false
if [ "$SIZE" -gt "$MAX_OUT" ]; then TRUNC=true; fi
# Which databases the engine actually loaded: fixed ecosystem words from its own "Loaded <ecosystem> local db" lines.
# A database that failed to load does not change the exit code when another ecosystem matched, so this positive
# evidence is what the coordinator requires. Nothing else from stderr leaves the container.
LOADED=''
for e in npm Maven; do
  if grep -q "^Loaded $e local db from $W/db/osv-scalibr/$e/all.zip" "$W/err.txt"; then LOADED="$LOADED\\\"$e\\\","; fi
done
LOADED="[\${LOADED%,}]"
# How many packages the engine itself dropped from matching as local or unscannable: digits only.
FILTERED=$(sed -n 's/^Filtered \\([0-9][0-9]*\\) local\\/unscannable package.*/\\1/p' "$W/err.txt" | head -n 1)
FILTERED=\${FILTERED:-0}
OUT=$(sha256sum "$W/out.json" | cut -c1-64)
ERRD=$(sha256sum "$W/err.txt" | cut -c1-64)
if [ -n "$CATEGORY" ]; then
  diag "sentinel.osv.engine.$CATEGORY"
  FAILURE="{\\"category\\":\\"$CATEGORY\\",\\"exitCode\\":$CODE}"
  printf 'sentinel.osv.engine.%s exit %s\\n' "$CATEGORY" "$CODE" >&2
else
  FAILURE=null
fi
printf '{"schema":"sentinel-osv-run/draft-1","job":"sha256:%s","exitCode":%s,"timedOut":%s,"stdoutBytes":%s,"stdoutTruncated":%s,"engineOutput":"sha256:%s","stderrDigest":"sha256:%s","failure":%s,"loaded":%s,"filtered":%s}' \\
  "$JOB" "$CODE" "$TIMED" "$SIZE" "$TRUNC" "$OUT" "$ERRD" "$FAILURE" "$LOADED" "$FILTERED" > "$W/record.json"
REC=$(sha256sum "$W/record.json" | cut -c1-64)
RSIZE=$(wc -c < "$W/record.json" | tr -d ' ')
cp "$W/out.json" "/output/$OUT" && cp "$W/record.json" "/output/$REC" || exit 2
say "{\\"protocol\\":\\"$P\\",\\"type\\":\\"result\\",$(bound),\\"inputFingerprint\\":\\"$FP\\",\\"granularity\\":\\"per-file\\",\\"artifacts\\":[{\\"id\\":\\"sha256:$OUT\\",\\"mediaType\\":\\"application/vnd.osv.scan+json\\",\\"bytes\\":$SIZE},{\\"id\\":\\"sha256:$REC\\",\\"mediaType\\":\\"application/vnd.sentinel.osv-run+json\\",\\"bytes\\":$RSIZE}],\\"observations\\":[],\\"coveredChecks\\":[],\\"scannedSet\\":[],\\"skipped\\":[],\\"actualReadSet\\":[],\\"unresolvedFrontiers\\":[],\\"diagnostics\\":[]}"
exit 0
`;
