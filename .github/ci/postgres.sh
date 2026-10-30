#!/usr/bin/env bash
# Job-owned disposable containers only: no Homebrew, shared PGDATA or production access.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true ]] || { echo 'GitHub CI only' >&2; exit 2; }
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ && "${AIHR_CI_UNIT:-}" =~ ^db-([1-4]|[0-9a-f]{16})$ ]] || exit 2
[[ "${1:-}" == reset || "${1:-}" == stop || "${1:-}" == stats ]] || exit 2
memory_gib="${AIHR_CI_PG_MEMORY_GIB:-1}"
[[ "$memory_gib" == 1 || "$memory_gib" == 2 ]] || exit 2
jit_args=()
if [[ -n "${AIHR_CI_PG_JIT:-}" ]]; then
  [[ "$AIHR_CI_PG_JIT" == on || "$AIHR_CI_PG_JIT" == off ]] || exit 2
  jit_args=(-c "jit=$AIHR_CI_PG_JIT")
fi
statement_args=()
[[ "${AIHR_CI_PG_STATEMENTS:-0}" == 0 || "${AIHR_CI_PG_STATEMENTS:-0}" == 1 ]] || exit 2
if [[ "${AIHR_CI_PG_STATEMENTS:-0}" == 1 ]]; then
  [[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && ( "${AIHR_CI_PG_STATEMENTS_OWNER:-}" == attendance-sql-profile || "${AIHR_CI_PG_STATEMENTS_OWNER:-}" == visibility-plan-benchmark || "${AIHR_CI_PG_STATEMENTS_OWNER:-}" == system-http-profile ) ]] || exit 2
  statement_args=(-c shared_preload_libraries=pg_stat_statements -c compute_query_id=on
    -c pg_stat_statements.track=all -c pg_stat_statements.track_utility=off
    -c pg_stat_statements.track_planning=on -c pg_stat_statements.max=10000 -c track_io_timing=on)
fi
durability_args=(-c fsync=off -c synchronous_commit=off -c full_page_writes=off -c wal_level=minimal)
if [[ "${AIHR_CI_PG_DURABLE:-0}" == 1 ]]; then
  [[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${AIHR_CI_PG_STATEMENTS_OWNER:-}" == system-http-profile ]] || exit 2
  durability_args=(-c fsync=on -c synchronous_commit=on -c full_page_writes=on -c wal_level=replica)
else
  [[ "${AIHR_CI_PG_DURABLE:-0}" == 0 ]] || exit 2
fi
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
  -c listen_addresses=127.0.0.1 -c port=5433 -c max_wal_senders=0 \
  "${durability_args[@]}" \
  ${jit_args[@]+"${jit_args[@]}"} \
  ${statement_args[@]+"${statement_args[@]}"} \
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
