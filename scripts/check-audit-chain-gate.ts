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
// deploy/deploy.sh runs it after `db:migrate` and before `systemctl restart`.
import postgres from 'postgres';

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('✗ check:audit-chain-gate needs MIGRATION_DATABASE_URL (or DATABASE_URL) — load .env.production.');
    process.exit(2);
  }
  const raw = process.env.AUDIT_HASH_CHAIN_ENABLED;
  const armed = process.env.AUDIT_HASH_CHAIN_ENABLED === 'true';

  const sql = postgres(url, { max: 1 });
  let chained = 0;
  try {
    // The column may not exist yet on a database that predates 0074 — treat that as "no chain", not an
    // error, so this preflight cannot itself become the thing that blocks a first-time deploy.
    const [col] = await sql`
      SELECT 1 AS ok FROM information_schema.columns
       WHERE table_name = 'domain_event' AND column_name = 'chain_seq'`;
    if (col) {
      const [row] = await sql`SELECT count(*)::int AS n FROM domain_event WHERE chain_seq IS NOT NULL`;
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
