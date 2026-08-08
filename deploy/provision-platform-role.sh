#!/usr/bin/env bash
#
# ADR-0077 slice 7 — provision the PLATFORM PLANE on this host.
#
# Run ON THE SERVER as `ubuntu`. Prompts once for your sudo password (creating a role and granting
# BYPASSRLS both require a superuser connection; ai_hr_owner is NOSUPERUSER/NOCREATEROLE by design).
#
# WHY THIS EXISTS RATHER THAN "just re-run deploy/bootstrap-db.sql":
#
#   Migration 0351 ALREADY RAN on this database, and its entire grant block is wrapped in
#   `IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_hr_platform') THEN RAISE NOTICE; RETURN`.
#   The role did not exist, so every GRANT was SKIPPED — and drizzle has recorded 0351 as applied, so it
#   will never run again. Creating the role alone therefore produces a role that can log in and read
#   NOTHING. The grants have to be replayed by hand, which is what step 3 does.
#
#   bootstrap-db.sql would also work for the role, but it wants all three passwords and rewrites
#   default privileges for roles that are already correct. This touches only what is missing.
#
# IDEMPOTENT. Re-running is safe: it refuses if the role already exists, and GRANTs are idempotent.
# REVERSIBLE. To undo: `sudo -u postgres psql -d ai_hr -c 'DROP OWNED BY ai_hr_platform; DROP ROLE ai_hr_platform;'`
# and remove the PLATFORM_DATABASE_URL line from .env.production.

set -euo pipefail
cd /opt/ai-hr

NODE=/opt/node20/bin/node
ENV_FILE=.env.production

echo "== ADR-0077 slice 7 — platform plane provisioning =="

# Cache the sudo credential up front, so the later psql calls (whose stdin is a heredoc) never have to
# negotiate a password prompt.
sudo -v

# ── 0. Refuse to run twice ────────────────────────────────────────────────────────────────────────
if sudo -u postgres psql -d ai_hr -At -c "select 1 from pg_roles where rolname='ai_hr_platform'" | grep -q 1; then
  echo "ai_hr_platform already exists. Nothing to create."
  echo "If you need to re-grant, run step 3's SQL by hand. Exiting without changes."
  exit 0
fi
if grep -q '^PLATFORM_DATABASE_URL' "$ENV_FILE"; then
  echo "REFUSING: $ENV_FILE already has a PLATFORM_DATABASE_URL line but the role does not exist."
  echo "That combination needs a human — resolve it before running this."
  exit 1
fi

# ── 1. Generate the password ON THIS HOST ─────────────────────────────────────────────────────────
# hex, not base64: the value goes into a URL, and +/= would need percent-encoding to survive parsing.
PW="$(openssl rand -hex 24)"

# ── 2. Create the role (superuser required for BYPASSRLS) ─────────────────────────────────────────
#
# THE SECRET GOES IN ON STDIN, NEVER IN argv. The obvious form — `psql -v pw="$PW"` with `:'pw'` in a
# heredoc — is SQL-injection-safe but NOT secret-safe, and the difference costs you the credential:
#
#   - sudo logs the full resolved command line of everything it runs to authpriv, so
#     `COMMAND=/usr/bin/psql ... -v pw=<the password>` lands in /var/log/auth.log in cleartext,
#     retained for weeks and shipped to whatever collects auth logs.
#   - /proc/<pid>/cmdline is mode 0444 — world-readable, unlike /proc/<pid>/environ — so for as long
#     as psql runs, ANY local account can read the password out of the process table.
#
# `printf` is a shell builtin, so its arguments never enter the process table, and sudo neither logs
# nor inspects stdin. openssl rand -hex output cannot contain a quote or backslash, so single-quoting
# it into the statement is safe. pipefail (set above) keeps psql's exit status rather than printf's.
#
# NOTE: deploy/DEPLOY.md section 2 still documents the argv form for the owner and app passwords, and
# additionally echoes them to the terminal. Same defect, more powerful credentials — fixed there too.
echo "-- creating role ai_hr_platform (BYPASSRLS, NOSUPERUSER)"
printf "CREATE ROLE ai_hr_platform LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;\n" "$PW" \
  | sudo -u postgres psql -q -d ai_hr -v ON_ERROR_STOP=1 -f -

# ── 3. Replay migration 0351's grant block, which was skipped ─────────────────────────────────────
# This list is copied VERBATIM from db/migrations/0351_platform_plane.sql. It is enumerated, never
# "ALL TABLES": the control plane gets the tenancy and commercial surface, not every table a future
# migration happens to add. `tenant` is SELECT-only on purpose — suspension belongs to dunning (r105)
# and closure is dual-controlled with a retention check (0350); neither may become a support-console click.
echo "-- replaying 0351's grants (skipped when it ran, because the role was absent)"
sudo -u postgres psql -q -d ai_hr -v ON_ERROR_STOP=1 <<'SQL'
GRANT CONNECT ON DATABASE ai_hr TO ai_hr_platform;
GRANT USAGE ON SCHEMA public TO ai_hr_platform;
GRANT SELECT ON tenant, module, domain_event TO ai_hr_platform;
GRANT SELECT, INSERT, UPDATE ON tenant_module, subscription, usage_snapshot TO ai_hr_platform;
GRANT SELECT, INSERT, UPDATE ON platform_user TO ai_hr_platform;
SQL

# ── 4. Write PLATFORM_DATABASE_URL, derived from DATABASE_URL so host/port/db cannot drift ────────
echo "-- writing PLATFORM_DATABASE_URL to $ENV_FILE (backup first)"
cp -a "$ENV_FILE" "$ENV_FILE.bak-slice7-$(date +%Y%m%d%H%M%S)"

PLATFORM_URL="$(PLATFORM_PW="$PW" "$NODE" --env-file="$ENV_FILE" -e '
  const u = new URL(process.env.DATABASE_URL);
  u.username = "ai_hr_platform";
  u.password = process.env.PLATFORM_PW;
  process.stdout.write(u.toString());
')"

printf '\n# ADR-0077 slice 7 — the control-plane pool (ai_hr_platform, BYPASSRLS, NOSUPERUSER).\n' >> "$ENV_FILE"
printf '# db/platform.ts REFUSES to fall back to DATABASE_URL or MIGRATION_DATABASE_URL, and refuses a\n' >> "$ENV_FILE"
printf '# value identical to either — a fallback would be silently powerless or silently over-privileged.\n' >> "$ENV_FILE"
printf 'PLATFORM_DATABASE_URL=%s\n' "$PLATFORM_URL" >> "$ENV_FILE"

unset PW PLATFORM_URL

# ── 5. Verify — the boundary, not just the connection ─────────────────────────────────────────────
echo
echo "== verification =="
"$NODE" --env-file="$ENV_FILE" --input-type=module -e '
import postgres from "/opt/ai-hr/node_modules/postgres/src/index.js";
const sql = postgres(process.env.PLATFORM_DATABASE_URL, { max: 1 });
const fail = [];
const line = (ok, msg) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) fail.push(msg); };

const who = await sql.unsafe("select current_user cu, (select rolbypassrls from pg_roles where rolname=current_user) brls");
line(who[0].cu === "ai_hr_platform", `connects as ai_hr_platform (got ${who[0].cu})`);
line(who[0].brls === true, "role carries BYPASSRLS");

const t = await sql.unsafe("select count(*)::int n from tenant");
line(t[0].n > 0, `reads tenant across RLS (${t[0].n} row(s))`);

const u = await sql.unsafe("select count(*)::int n, count(distinct captured_on)::int d from usage_snapshot");
line(u[0].n > 0, `reads usage_snapshot (${u[0].n} row(s), ${u[0].d} distinct day(s))`);

// The boundary: tenant is SELECT-only, and the schema must be untouchable.
//
// ASSERT WHY IT FAILED, NOT MERELY THAT IT DID. A probe that errors for an unrelated reason (a renamed
// column, a missing table) would read as "refused" and paint a boundary that is not there — the same
// trap as rejects.toThrow() passing on the wrong throw. Postgres reports 42501 for insufficient
// privilege; anything else means the probe itself was wrong.
const probe = async (label, stmt, cleanup) => {
  try {
    await sql.unsafe(stmt);
    if (cleanup) await sql.unsafe(cleanup);
    line(false, `${label} — the statement SUCCEEDED, so the boundary is not there`);
  } catch (e) {
    const denied = e.code === "42501";
    line(denied, denied ? label : `${label} — failed with ${e.code || "?"} (${e.message}), NOT a permission error`);
  }
};

await probe(
  "REFUSED write to tenant (suspension/closure are not a console click)",
  "update tenant set name = name where false",
);
await probe(
  "REFUSED to create a table (NOSUPERUSER, no schema rights)",
  "create table _slice7_probe(x int)",
  "drop table _slice7_probe",
);

await sql.end();
console.log(fail.length ? `\n${fail.length} CHECK(S) FAILED` : "\nAll checks passed.");
process.exit(fail.length ? 1 : 0);
'

echo
echo "== platform:usage report =="
"$NODE" --env-file="$ENV_FILE" --import tsx scripts/platform-usage-report.ts || true

echo
echo "Done. No service restart needed — db/platform.ts is imported only by scripts/platform-usage-report.ts."
