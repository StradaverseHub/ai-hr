#!/usr/bin/env bash
# Job-owned disposable containers only: no Homebrew, shared PGDATA or production access.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true ]] || { echo 'GitHub CI only' >&2; exit 2; }
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ && "${AIHR_CI_UNIT:-}" =~ ^db-([1-4]|[0-9a-f]{16})$ ]] || exit 2
[[ "${1:-}" == reset || "${1:-}" == stop || "${1:-}" == stats ]] || exit 2
memory_gib="${AIHR_CI_PG_MEMORY_GIB:-1}"
[[ "$memory_gib" == 1 || "$memory_gib" == 2 ]] || exit 2
name="aihr-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${AIHR_CI_UNIT}"
if docker container inspect "$name" >/dev/null 2>&1; then
  [[ "$(docker inspect --format '{{index .Config.Labels "aihr-owner"}}' "$name")" == "$name" ]] || { echo 'Container ownership mismatch' >&2; exit 2; }
  if [[ "${1:-}" == stats ]]; then docker stats --no-stream --format '{{json .}}' "$name"; exit 0; fi
  docker rm -fv "$name" >/dev/null
fi
[[ "${1:-}" == stats ]] && { echo 'Missing owned container' >&2; exit 2; }
[[ "${1:-}" == stop ]] && exit 0
[[ "${1:-}" == reset ]] || exit 2
# Data lives on the disposable runner disk, not a RAM disk. Removal also removes its anonymous volume.
docker run -d --name "$name" --label "aihr-owner=$name" --network host \
  --memory="${memory_gib}g" --memory-swap="${memory_gib}g" --shm-size=128m \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e TZ=Asia/Kuala_Lumpur postgres:16@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97 \
  -c listen_addresses=127.0.0.1 -c port=5433 -c fsync=off -c synchronous_commit=off \
  -c full_page_writes=off -c wal_level=minimal -c max_wal_senders=0 \
  -c shared_buffers=128MB -c max_connections=100 -c max_locks_per_transaction=256 >/dev/null
ready=0
for attempt in $(seq 1 60); do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -p 5433 >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { docker logs "$name"; exit 1; }
docker exec "$name" psql -U postgres -p 5433 -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE ai_hr_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;' \
  -c 'CREATE DATABASE ai_hr_dev OWNER ai_hr_app;' \
  -c 'CREATE DATABASE ai_hr_test OWNER ai_hr_app;'
