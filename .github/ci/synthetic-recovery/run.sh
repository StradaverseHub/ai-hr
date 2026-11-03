set -euo pipefail
test "$(uname -sm)" = "Linux x86_64"
fixture=$(mktemp -d "$RUNNER_TEMP/replan-synthetic.XXXXXX")
unit=aihr-recovery-fixture-ci.service
db=''
trap 'sudo systemctl stop "$unit" || true; if [[ -n "$db" ]]; then docker rm -fv "$db"; fi; rm -rf "$fixture"' EXIT
tools="$PWD/.github/ci/synthetic-recovery"
verifier="$PWD/.github/ci/staging-migration-ledger.mjs"
source="$fixture/install"
node "$tools/generate-ledger.mjs" "$source" "$verifier"
mkdir "$source/.next"
printf 'synthetic-recovery\n' > "$source/.next/BUILD_ID"
db=$(docker run -d -p 127.0.0.1::5432 -e POSTGRES_DB=aihr_recovery_fixture -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16)
for n in {1..30}; do
 if docker exec "$db" pg_isready -h 127.0.0.1 -U postgres; then break; fi
 sleep 1
done
docker exec -i "$db" psql -U postgres -d aihr_recovery_fixture -X -q -v ON_ERROR_STOP=1 < "$source/seed-ledger.sql"
port=$(docker port "$db" 5432/tcp | cut -d: -f2)
export MIGRATION_DATABASE_URL="postgresql://postgres@127.0.0.1:$port/aihr_recovery_fixture"
export FIXTURE_ACTIVATION_MONOTONIC_US
FIXTURE_ACTIVATION_MONOTONIC_US=$(python3 -c 'import time; print(time.monotonic_ns() // 1000)')
sudo systemd-run --quiet --unit="$unit" --uid="$(id -u)" --property="WorkingDirectory=$source" "$(command -v node)" "$tools/runtime-service.mjs"
curl -fsS --retry 5 --retry-connrefused http://127.0.0.1:3107/health
node "$tools/verify-fixture-runtime.mjs" "$source" "$verifier" "$unit"
rsync --version | sed -n '1p'
PYTHONDONTWRITEBYTECODE=1 python3 scripts/staging/test_coordinator.py
PYTHONDONTWRITEBYTECODE=1 python3 .github/ci/cleanup-install.test.py
node --test .github/ci/normal-cleanup-io.test.mjs .github/ci/normal-cleanup-session.test.mjs
