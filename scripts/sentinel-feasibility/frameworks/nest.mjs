#!/usr/bin/env node
// PR 01 E2 framework prototype only. Not a production framework adapter or support claim.
import { BASE_IMAGES } from './runtime.mjs';

export const CASE_ID = 'nest-validation';

export function dockerfile() {
  return `FROM ${BASE_IMAGES.node}
RUN apk add --no-cache curl
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY create-user.dto.ts app.controller.ts app.module.ts main.ts ./
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

node -r ts-node/register main.ts &
APP_PID=$!

i=0
until curl -sf -o /dev/null http://127.0.0.1:3000/healthz; do
  i=$((i+1))
  if [ "$i" -ge 60 ]; then printf 'SENTINEL_FIXTURE_PROBE_RESULT={"status":"health-timeout"}\\n'; exit 0; fi
  sleep 1
done

validated=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3000/users/validated)
unvalidated=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3000/users/unvalidated)

printf 'SENTINEL_FIXTURE_PROBE_RESULT={"status":"ok","observations":{"validator-with-pipe":{"invalidBody":%s},"validator-without-pipe":{"invalidBody":%s}}}\\n' "$validated" "$unvalidated"
`;
}

export function assess(caseEntry, observations) {
  const results = [];
  for (const scenario of caseEntry.scenarios) {
    const observed = observations?.[scenario.id] ?? null;
    const matches = observed ? observed.invalidBody === scenario.expectedRuntime.invalidBody : null;
    results.push({ scenario: scenario.id, staticLabel: scenario.staticLabel, expectedRuntime: scenario.expectedRuntime, observed, matchesExpected: matches });
  }
  return results;
}
