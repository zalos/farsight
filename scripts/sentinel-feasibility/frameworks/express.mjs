#!/usr/bin/env node
// PR 01 E2 framework prototype only. Not a production framework adapter or support claim.
import { BASE_IMAGES } from './runtime.mjs';

export const CASE_ID = 'express-order';

export function dockerfile() {
  return `FROM ${BASE_IMAGES.node}
RUN apk add --no-cache curl
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.js ./
COPY probe.sh ./
RUN chmod +x probe.sh
RUN chown -R 65534:65534 /app
ENV SENTINEL_FIXTURE_OPAQUE_MODE=deny
ENTRYPOINT ["/app/probe.sh"]
`;
}

export function probeScript() {
  return `#!/bin/sh
set -eu
cleanup() { kill "$APP_PID" 2>/dev/null || true; }
trap cleanup EXIT

node server.js &
APP_PID=$!

i=0
until curl -sf -o /dev/null http://127.0.0.1:3000/healthz; do
  i=$((i+1))
  if [ "$i" -ge 40 ]; then printf 'SENTINEL_FIXTURE_PROBE_RESULT={"status":"health-timeout"}\\n'; exit 0; fi
  sleep 1
done

AUTH_HEADER="Authorization: Bearer FIXTURE_CANARY_ONLY"
early_noauth=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/admin/early)
early_auth=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH_HEADER" http://127.0.0.1:3000/admin/early)
late_noauth=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/admin/late)
late_auth=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH_HEADER" http://127.0.0.1:3000/admin/late)
opaque=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/admin/opaque)

printf 'SENTINEL_FIXTURE_PROBE_RESULT={"status":"ok","observations":{"auth-before-route":{"withoutToken":%s,"withToken":%s},"auth-after-route":{"withoutToken":%s,"withToken":%s},"unknown-custom-middleware":{"anyRequest":%s}}}\\n' "$early_noauth" "$early_auth" "$late_noauth" "$late_auth" "$opaque"
`;
}

// Compares real container observations against each scenario's expectedRuntime from cases.json.
// Never upgrades a static label from the corpus; only reports whether runtime agreed with it.
export function assess(caseEntry, observations) {
  const results = [];
  for (const scenario of caseEntry.scenarios) {
    const observed = observations?.[scenario.id] ?? null;
    let matches = null;
    if (observed) {
      if (scenario.id === 'unknown-custom-middleware') matches = observed.anyRequest === scenario.expectedRuntime.anyRequest;
      else matches = observed.withoutToken === scenario.expectedRuntime.withoutToken && observed.withToken === scenario.expectedRuntime.withToken;
    }
    results.push({ scenario: scenario.id, staticLabel: scenario.staticLabel, expectedRuntime: scenario.expectedRuntime, observed, matchesExpected: matches });
  }
  return results;
}
