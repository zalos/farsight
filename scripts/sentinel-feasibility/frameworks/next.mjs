#!/usr/bin/env node
// PR 01 E2 framework prototype only. Not a production framework adapter or support claim.
import { BASE_IMAGES } from './runtime.mjs';

export const CASE_ID = 'next-matcher';
// `next start` has been observed writing small runtime trace files even after a prior `next build`;
// this candidate therefore runs without --read-only, unlike the other three. Documented limitation,
// not a silent weakening: see framework-feasibility.md.
export const READ_ONLY = false;

export function dockerfile() {
  return `FROM ${BASE_IMAGES.node}
RUN apk add --no-cache curl
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts --no-audit --no-fund
COPY next.config.js middleware.js ./
COPY pages ./pages
RUN npm run build
COPY probe.sh ./
RUN chmod +x probe.sh
ENTRYPOINT ["/app/probe.sh"]
`;
}

export function probeScript() {
  return `#!/bin/sh
set -eu
cleanup() { kill "$APP_PID" 2>/dev/null || true; }
trap cleanup EXIT

npm run start >/tmp/next.log 2>&1 &
APP_PID=$!

i=0
until curl -sf -o /dev/null http://127.0.0.1:3000/api/healthz; do
  i=$((i+1))
  if [ "$i" -ge 60 ]; then printf 'SENTINEL_FIXTURE_PROBE_RESULT={"status":"health-timeout"}\\n'; exit 0; fi
  sleep 1
done

secret=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/dashboard/secret)
open=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/dashboard/open)
info=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/public/info)

printf 'SENTINEL_FIXTURE_PROBE_RESULT={"status":"ok","observations":{"matched-and-blocked":{"status":%s},"matched-but-exempted":{"status":%s},"excluded-by-matcher":{"status":%s}}}\\n' "$secret" "$open" "$info"
`;
}

export function assess(caseEntry, observations) {
  const results = [];
  for (const scenario of caseEntry.scenarios) {
    const observed = observations?.[scenario.id] ?? null;
    const matches = observed ? observed.status === scenario.expectedRuntime.status : null;
    results.push({ scenario: scenario.id, staticLabel: scenario.staticLabel, expectedRuntime: scenario.expectedRuntime, observed, matchesExpected: matches });
  }
  return results;
}
