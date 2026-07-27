// DEPLOY PREFLIGHT — refuse to restart the service into a silently unprotected audit log (ADR-0030).
//
// WHY THIS IS A SCRIPT AND NOT A LINE IN THE RUNBOOK. `AUDIT_HASH_CHAIN_ENABLED` is the one gate
// ADR-0077 slice 3 leaves in env (DEFERRED_ENV_GATES — slice 8 owns migrating it), and slice 3 changed
// how it is READ: `db/client.ts` compared it truthily, and `.env.example` shipped the ACTIVE line
// `AUDIT_HASH_CHAIN_ENABLED=false`. The string 'false' is truthy, so every deployment built from that
// template has been chaining `domain_event` rows while every document recorded the chain as OFF. The
// read is `=== 'true'` now, which is correct — and which DISARMS the chain on exactly those boxes.
//
// THE FAILURE THAT MAKES THIS BLOCKING RATHER THAN ADVISORY. Disarming is not a break the verifier can
// report. `core/audit-chain.ts` only inspects rows with `chain_seq IS NOT NULL`, and the trigger takes
// the chain head from `max(chain_seq)` over those same rows, so events written while the gate is off
// are absent from the chain rather than a broken link in it — and re-arming later links contiguously
// across the hole. `verifyTenantChain()` therefore answers `valid: true` over a log with an
// unverifiable window in the middle, and the DPO surface renders "intact". There is no automatic
// remedy: the ADR-0030 §3 historical backfill that could heal the window is not built. So the moment to
// catch it is BEFORE the restart, by comparing the env value against what the database already holds —
// which is the one question a grep of the env file structurally cannot answer.
//
// EXIT CODES: 0 = safe to restart; 1 = the operator must decide (see the message); 2 = could not check.
// deploy/deploy.sh runs it BEFORE `pnpm build` — see the ordering note there: this needs only an env
// file and a database connection, so a refusal must cost nothing and leave the box untouched.
import postgres from 'postgres';

async function main() {
  // THE OWNER URL, WITH NO FALLBACK TO DATABASE_URL, and the fallback was not a convenience — it was a
  // fail-open (review r3). `domain_event_read` (0037) is
  // `USING (tenant_id = app.current_tenant_id() AND (app.is_admin() OR …))`. This script sets no
  // `app.tenant_id` GUC, so on the `ai_hr_app` connection `tenant_id = NULL` is NULL — not true — and
  // `app.is_admin()` is false: the count below returns ZERO on a database with a fully armed chain, the
  // `chained === 0` branch prints "safe to restart", and the deploy proceeds into exactly the silently
  // disarmed chain this preflight exists to refuse. Verified: the same database and the same env value
  // gave opposite verdicts through the two URLs. Same fail-open class as the resolver defect round 1
  // fixed in core/entitlements.ts, reintroduced in the control. scripts/reconcile-entitlement-parity.ts
  // already hard-requires the owner role for the mirror-image reason.
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('✗ check:audit-chain-gate needs MIGRATION_DATABASE_URL (the OWNER role) — load .env.production.');
    console.error('  DATABASE_URL is deliberately NOT accepted: domain_event is RLS-bound for ai_hr_app,');
    console.error('  and this check would read zero chained rows on a database whose chain is armed.');
    process.exit(2);
  }
  const raw = process.env.AUDIT_HASH_CHAIN_ENABLED;
  const armed = process.env.AUDIT_HASH_CHAIN_ENABLED === 'true';

  const sql = postgres(url, { max: 1 });
  let chained = 0;
  try {
    // …AND PROVE THE CONNECTION IS NOT RLS-FILTERED BEFORE TRUSTING A ZERO. Requiring the owner URL is a
    // rule about a variable's NAME; this is a rule about what the connection can actually see, and only
    // the second one is checkable. A zero-row answer from a role that RLS applies to means "nothing
    // visible", never "no chain", so if the role neither owns the table nor bypasses RLS while RLS is
    // enabled on it, the honest answer is "could not check" (exit 2), not "safe".
    //
    // OWNERSHIP EXEMPTS ONLY WHILE `FORCE ROW LEVEL SECURITY` IS OFF (review r3). Postgres applies RLS
    // to the table OWNER too once a table is FORCEd, and this codebase already does that — 0059 set it
    // on `ai_provider_config`, describing it as "the FIRST forced table in this codebase, deliberately",
    // so a later hardening migration reaching `domain_event` is plausible rather than exotic. Reading
    // only `relrowsecurity` would then short-circuit on `owns`, take an RLS-filtered zero, and print
    // "safe to restart" over a fully armed chain — reinstating the exact fail-open this check exists to
    // remove. `relforcerowsecurity` is therefore part of the probe: owning the table is an exemption
    // only when FORCE is off.
    const [vis] = await sql`
      SELECT c.relrowsecurity AS rls,
             c.relforcerowsecurity AS forced,
             pg_catalog.pg_get_userbyid(c.relowner) = current_user AS owns,
             COALESCE((SELECT r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) AS bypass
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'domain_event'`;
    if (vis && vis.rls && (!vis.owns || vis.forced) && !vis.bypass) {
      console.error('✗ check:audit-chain-gate is connected as a role that row-level security applies to.');
      console.error('  Every count it could take would be filtered, and a filtered zero is indistinguishable');
      console.error('  from "this database has no hash chain" — the one answer that lets the deploy proceed.');
      console.error('  Re-run with MIGRATION_DATABASE_URL pointing at ai_hr_owner.');
      await sql.end();
      process.exit(2);
    }
    // The column may not exist yet on a database that predates 0074 — treat that as "no chain", not an
    // error, so this preflight cannot itself become the thing that blocks a first-time deploy. Schema
    // qualified (`table_schema`, and `public.domain_event` below), matching the house convention 0313's
    // policies and trigger functions already follow: an unqualified probe can be satisfied by a
    // domain_event in some other visible schema — a staging copy, a pre-migration backup — while the
    // count that follows resolves through search_path to a different table entirely.
    const [col] = await sql`
      SELECT 1 AS ok FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'domain_event' AND column_name = 'chain_seq'`;
    if (col) {
      const [row] = await sql`SELECT count(*)::int AS n FROM public.domain_event WHERE chain_seq IS NOT NULL`;
      chained = Number(row?.n ?? 0);
    }
  } catch (e) {
    console.error(`✗ check:audit-chain-gate could not read domain_event: ${(e as Error).message}`);
    await sql.end();
    process.exit(2);
  }
  await sql.end();

  console.log(`check:audit-chain-gate — AUDIT_HASH_CHAIN_ENABLED=${raw === undefined ? '(unset)' : `'${raw}'`}, ` +
    `${chained} chained event(s) in the database.`);

  if (armed || chained === 0) {
    // Armed: the chain continues, nothing to decide. Not armed and nothing chained: the chain has never
    // run on this database, so switching the read from truthy to `=== 'true'` changes nothing at all.
    console.log('✓ safe to restart.');
    process.exit(0);
  }
  if (process.env.AUDIT_CHAIN_STOP_ACKNOWLEDGED === 'true') {
    console.warn('⚠ the chain is armed in the database but OFF in this env, and the stop is ACKNOWLEDGED.');
    console.warn('  Events from this deploy carry no chain columns. The admin Privacy page reports them as');
    console.warn('  unchained; verifyTenantChain() cannot verify them, now or later.');
    process.exit(0);
  }

  console.error('');
  console.error('✗ REFUSING TO CONTINUE — this database HAS a hash chain, and this env would run without it.');
  console.error('');
  console.error(`  ${chained} domain_event row(s) carry chain columns, so the ADR-0030 chain has been armed here —`);
  console.error("  almost certainly by the truthiness bug: an active `AUDIT_HASH_CHAIN_ENABLED=false` line reads as");
  console.error("  ON under the old test and OFF under the new one. Restarting now would append events with NO chain");
  console.error('  columns. That is invisible to verifyTenantChain() — it only inspects chained rows — so the log');
  console.error('  would keep reporting "intact" while the new events sit outside the chain, and ADR-0030 §3\'s');
  console.error('  historical backfill (the only thing that could heal the window) is not built.');
  console.error('');
  console.error('  Pick one in .env.production, then re-run the deploy:');
  console.error('    • KEEP THE CHAIN — what this box is actually doing today, and the default answer:');
  console.error('        AUDIT_HASH_CHAIN_ENABLED=true');
  console.error('    • STOP IT DELIBERATELY, accepting an unverifiable window from this deploy onward:');
  console.error('        leave the gate off and add  AUDIT_CHAIN_STOP_ACKNOWLEDGED=true');
  console.error('      The acknowledgement exists so the stop is a recorded decision rather than a default,');
  console.error('      and so this preflight cannot be silenced by deleting a line from a runbook.');
  console.error('');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
