#!/usr/bin/env bash
set -euo pipefail

: "${CANDIDATE_IMAGE:?CANDIDATE_IMAGE is required}"
: "${EXPECTED_ARCH:?EXPECTED_ARCH is required}"
: "${EXPECTED_REVISION:?EXPECTED_REVISION is required}"

test "$(docker image inspect --format '{{.Architecture}}' "$CANDIDATE_IMAGE")" = "$EXPECTED_ARCH"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$CANDIDATE_IMAGE")" = "$EXPECTED_REVISION"
docker run --rm -e EXPECTED_REVISION="$EXPECTED_REVISION" --entrypoint node "$CANDIDATE_IMAGE" -e '
  const assert = require("node:assert/strict");
  assert.equal(process.env.NODECAST_REVISION, process.env.EXPECTED_REVISION);
  const db = new (require("better-sqlite3"))(":memory:");
  assert.equal(db.prepare("SELECT 1 AS value").get().value, 1);
  db.close();
'
docker run --rm --entrypoint node "$CANDIDATE_IMAGE" scripts/container-runtime-test.js

jwt_secret="$(openssl rand -hex 48)"
session_secret="$(openssl rand -hex 48)"
container_id="$(docker run -d \
  -e NODE_ENV=production -e JWT_SECRET="$jwt_secret" -e SESSION_SECRET="$session_secret" \
  -p 127.0.0.1::3000 "$CANDIDATE_IMAGE")"
trap 'docker rm -f "$container_id" >/dev/null 2>&1 || true' EXIT

for attempt in {1..40}; do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$container_id")"
  if [ "$status" = "healthy" ]; then break; fi
  if [ "$status" = "unhealthy" ]; then exit 1; fi
  sleep 2
done
test "$(docker inspect --format '{{.State.Health.Status}}' "$container_id")" = "healthy"
host_port="$(docker port "$container_id" 3000/tcp | awk -F: '{print $NF}')"
curl -fsS "http://127.0.0.1:${host_port}/api/health" | grep -q '"status":"ok"'
curl -fsS "http://127.0.0.1:${host_port}/api/version" \
  | node -e '
      let text = "";
      process.stdin.on("data", chunk => text += chunk);
      process.stdin.on("end", () => {
        const assert = require("node:assert/strict");
        const result = JSON.parse(text);
        assert.equal(result.version, require("./package.json").version);
      });
    '
echo "Verified native candidate architecture, revision, runtime and health."
