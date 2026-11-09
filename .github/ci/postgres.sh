#!/usr/bin/env bash
# Job-owned disposable containers only: no Homebrew, shared PGDATA or production access.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true ]] || { echo 'GitHub CI only' >&2; exit 2; }
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ && "${AIHR_CI_UNIT:-}" =~ ^db-([1-4]|[0-9a-f]{16})$ ]] || exit 2
operation=${1:-}
[[ "$operation" == reset || "$operation" == stop || "$operation" == stats || "$operation" == reset-native-workload ]] || exit 2
# A named profile is mandatory even for historical diagnostic-only configurations.
case "${AIHR_CI_PG_PROFILE:-}" in
  2)
    [[ ! ${AIHR_CI_PG_MEMORY_GIB+x} && "${AIHR_CI_PG_CONFIGURED_CAP_BYTES:-}" == 2113929216 && "${AIHR_CI_PG_PEAK_BUDGET_BYTES:-}" == 2147483648 && "${AIHR_CI_PG_JIT:-}" == on ]] || exit 2
    memory_bytes=2113929216 ;;
  legacy-1g|legacy-2g)
    [[ ! ${AIHR_CI_PG_CONFIGURED_CAP_BYTES+x} && ! ${AIHR_CI_PG_PEAK_BUDGET_BYTES+x} ]] || exit 2
    memory_gib="${AIHR_CI_PG_MEMORY_GIB:-}"
    [[ ( "$AIHR_CI_PG_PROFILE" == legacy-1g && "$memory_gib" == 1 ) || ( "$AIHR_CI_PG_PROFILE" == legacy-2g && "$memory_gib" == 2 ) ]] || exit 2
    [[ "${AIHR_CI_PG_JIT:-}" == on || "${AIHR_CI_PG_JIT:-}" == off ]] || exit 2
    memory_bytes=$((memory_gib * 1073741824)) ;;
  *) exit 2 ;;
esac
jit_args=(-c "jit=$AIHR_CI_PG_JIT")
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
auth_args=(-e POSTGRES_HOST_AUTH_METHOD=trust)
workload_args=()
development_log_args=()
case "${AIHR_CI_PG_DEVELOPMENT_LOCK_LOG:-0}" in
  0) ;;
  1)
    [[ "$operation" == reset && "${GITHUB_JOB:-}" == selected-tests && "${GITHUB_EVENT_NAME:-}" == workflow_dispatch &&
      "${GITHUB_RUN_ATTEMPT:-}" == 1 && "$AIHR_CI_UNIT" == db-1 && "$AIHR_CI_PG_PROFILE" == 2 &&
      "${AIHR_CI_PG_DURABLE:-}" == 1 && "${AIHR_CI_PG_STATEMENTS_OWNER:-}" == system-http-profile ]] || exit 2
    development_log_args=(--log-driver json-file --log-opt mode=blocking --log-opt max-size=16m --log-opt max-file=1)
    workload_args=(-c log_lock_waits=on -c deadlock_timeout=100ms -c log_destination=stderr -c logging_collector=off
      -c 'log_line_prefix=%m [%p] %c %u@%d ' -c log_statement=none -c log_min_error_statement=panic
      -c log_parameter_max_length_on_error=0)
    ;;
  *) exit 2 ;;
esac
if [[ "$operation" == reset-native-workload ]]; then
  # This operation belongs to the protected native run-unit and its exact source plan.
  [[ "$#" == 3 && "${GITHUB_JOB:-}" == native-test && "${GITHUB_RUN_ATTEMPT:-}" == 1 && "$AIHR_CI_PG_PROFILE" == 2 && "$AIHR_CI_UNIT" =~ ^db-[a-f0-9]{16}$ ]] || exit 2
  [[ "$(readlink -f -- "$0")" == "/var/lib/aihr-native-controller/$GITHUB_RUN_ID/automation/.github/ci/postgres.sh" ]] || exit 2
  [[ "$2" == "${RUNNER_TEMP:?}/aihr-native-workload-pg-$AIHR_CI_UNIT."* && "$(readlink -f -- "$2")" == "$2" && "$3" =~ ^[a-f0-9]{64}$ ]] || exit 2
  [[ "$(stat -c '%u:%a' -- "$2")" == "$(id -u):700" && "$(stat -c '%u:%a' -- "$2/bootstrap-password")" == "$(id -u):400" && "$(stat -c '%u:%a' -- "$2/pg_hba.conf")" == "$(id -u):444" ]] || exit 2
  [[ ! -L "$2/bootstrap-password" && ! -L "$2/pg_hba.conf" ]] || exit 2
  auth_args=(-e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 -e 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust'
    -e POSTGRES_PASSWORD_FILE=/run/aihr-workload-pg/bootstrap-password
    --mount "type=bind,source=$2/bootstrap-password,target=/run/aihr-workload-pg/bootstrap-password,readonly"
    --mount "type=bind,source=$2/pg_hba.conf,target=/run/aihr-workload-pg/pg_hba.conf,readonly"
    --label "aihr-workload-custody=$3")
  durability_args=(-c fsync=on -c synchronous_commit=on -c full_page_writes=on -c wal_level=replica)
  statement_args=(-c shared_preload_libraries=pg_stat_statements -c compute_query_id=on
    -c pg_stat_statements.track=all -c pg_stat_statements.track_utility=off
    -c pg_stat_statements.track_planning=on -c pg_stat_statements.max=10000 -c track_io_timing=on)
  workload_args=(-c hba_file=/run/aihr-workload-pg/pg_hba.conf -c log_lock_waits=on -c deadlock_timeout=1s
    -c 'log_line_prefix=%m [%p] %c %u@%d ' -c log_statement=none -c log_min_error_statement=panic
    -c log_parameter_max_length_on_error=0)
fi
if docker container inspect "$name" >/dev/null 2>&1; then
  [[ "$operation" != reset-native-workload ]] || exit 2
  [[ "$(docker inspect --format '{{index .Config.Labels "aihr-owner"}}' "$name")" == "$name" ]] || { echo 'Container ownership mismatch' >&2; exit 2; }
  if [[ "${1:-}" == stats ]]; then docker stats --no-stream --format '{{json .}}' "$name"; exit 0; fi
  docker rm -fv "$name" >/dev/null
fi
[[ "${1:-}" == stats ]] && { echo 'Missing owned container' >&2; exit 2; }
[[ "${1:-}" == stop ]] && exit 0
[[ "$operation" == reset || "$operation" == reset-native-workload ]] || exit 2
# Data lives on the disposable runner disk, not a RAM disk. Removal also removes its anonymous volume.
docker run -d --name "$name" --label "aihr-owner=$name" --network host \
  --memory="$memory_bytes" --memory-swap="$memory_bytes" --shm-size=128m \
  "${auth_args[@]}" "${development_log_args[@]}" -e TZ=Asia/Kuala_Lumpur postgres:16@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97 \
  -c listen_addresses=127.0.0.1 -c port=5433 -c max_wal_senders=0 \
  "${durability_args[@]}" \
  ${jit_args[@]+"${jit_args[@]}"} \
  ${statement_args[@]+"${statement_args[@]}"} \
  ${workload_args[@]+"${workload_args[@]}"} \
  -c shared_buffers=128MB -c max_connections=100 -c max_locks_per_transaction=256 >/dev/null
ready=0
for attempt in $(seq 1 60); do
  # The readiness packet goes through TCP, so it cannot be satisfied by the image's temporary bootstrap socket.
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -p 5433 >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { docker logs "$name"; exit 1; }
docker exec "$name" psql -U postgres -p 5433 -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE ai_hr_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;' \
  -c 'CREATE DATABASE ai_hr_dev OWNER ai_hr_app;' \
  -c 'CREATE DATABASE ai_hr_test OWNER ai_hr_app;'
