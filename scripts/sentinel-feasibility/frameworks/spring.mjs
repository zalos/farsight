#!/usr/bin/env node
// PR 01 E2 framework prototype only. Not a production framework adapter or support claim.
import { BASE_IMAGES } from './runtime.mjs';

export const CASE_ID = 'spring-chains';

export function dockerfile() {
  return `FROM ${BASE_IMAGES.maven}
RUN apk add --no-cache curl
WORKDIR /app
COPY pom.xml ./
COPY src ./src
RUN mvn -q -B -DskipTests package
RUN mvn -q -B dependency:tree -DoutputFile=/app/dependency-tree.txt
COPY probe.sh ./
RUN chmod +x probe.sh
RUN chown -R 65534:65534 /app
ENTRYPOINT ["/app/probe.sh"]
`;
}

export function probeScript() {
  return `#!/bin/sh
set -eu
cleanup() { kill "$APP_PID" 2>/dev/null || true; }
trap cleanup EXIT

java -jar target/spring-chains-fixture.jar --server.port=3000 --server.address=127.0.0.1 &
APP_PID=$!

i=0
until curl -sf -o /dev/null http://127.0.0.1:3000/healthz; do
  i=$((i+1))
  if [ "$i" -ge 90 ]; then printf 'SENTINEL_FIXTURE_PROBE_RESULT={"status":"health-timeout"}\\n'; exit 0; fi
  sleep 1
done

FIXTURE_BASIC_CREDENTIALS="fixture-user:NOT_A_SECRET_DO_NOT_USE"
open_noauth=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/secure/public/info)
secure_noauth=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/secure/data)
secure_auth=$(curl -s -o /dev/null -w '%{http_code}' -u "$FIXTURE_BASIC_CREDENTIALS" http://127.0.0.1:3000/api/secure/data)
other_noauth=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/other/thing)

printf 'SENTINEL_FIXTURE_PROBE_RESULT={"status":"ok","observations":{"overlapping-open-chain":{"withoutCredentials":%s},"later-authenticated-chain":{"withoutCredentials":%s,"withCredentials":%s},"unmatched-no-chain-applies":{"withoutCredentials":%s}}}\\n' "$open_noauth" "$secure_noauth" "$secure_auth" "$other_noauth"
`;
}

// Every scenario here, including unmatched-no-chain-applies, carries a fixed expectedRuntime frozen
// in cases.json before this file's measurement; none is exploratory or exempt from the match check.
export function assess(caseEntry, observations) {
  const results = [];
  for (const scenario of caseEntry.scenarios) {
    const observed = observations?.[scenario.id] ?? null;
    let matches = null;
    if (observed) {
      matches = scenario.id === 'later-authenticated-chain'
        ? observed.withoutCredentials === scenario.expectedRuntime.withoutCredentials && observed.withCredentials === scenario.expectedRuntime.withCredentials
        : observed.withoutCredentials === scenario.expectedRuntime.withoutCredentials;
    }
    results.push({ scenario: scenario.id, staticLabel: scenario.staticLabel, expectedRuntime: scenario.expectedRuntime, observed, matchesExpected: matches });
  }
  return results;
}
