/**
 * ADR-0077 slice 10 — the usage dashboard, as a report.
 *
 *   node --env-file=.env.production --import tsx scripts/platform-usage-report.ts
 *   node --env-file=.env.production --import tsx scripts/platform-usage-report.ts --as-of 2026-08-03 --window 30
 *
 * READ-ONLY. Runs on the PLATFORM pool (ai_hr_platform, BYPASSRLS and nothing else — slice 7), so a
 * reporting surface cannot rewrite the database the way the owner connection could.
 *
 * ── WHY THIS IS A SCRIPT AND NOT A /platform PAGE (yet) ───────────────────────────────────────────
 * The web dashboard needs its own authentication boundary: `platform_user` is deliberately NOT
 * `app_user` (ADR-0077 D5), so a `/platform` route group cannot reuse the tenant session at all — it
 * needs a platform identity, a deny-by-default route guard, and every view appended to DomainEvent
 * because Stradaverse looking at a customer's data is itself an audit event. A route group that is
 * deny-by-default in intention but not in fact is a cross-tenant data leak, which is the one failure
 * this whole slice exists to prevent. So the READ MODEL ships first, tested and on the right pool, and
 * the page is built deliberately on top of it rather than improvised alongside it.
 *
 * ── WHAT TO LOOK AT FIRST ─────────────────────────────────────────────────────────────────────────
 * Not the totals. `missing capture days`. Usage cannot be backfilled, so a missing day is revenue that
 * is gone permanently, and there are no `aihr` timers installed on the host — see deploy/systemd/.
 */
import { platformUsageSummary } from '../core/platform-usage';
import { platformPlaneConfigured } from '../db/platform';

const argOf = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

async function main() {
  if (!platformPlaneConfigured()) {
    console.error(
      'The platform plane is not configured. Set PLATFORM_DATABASE_URL to the ai_hr_platform\n' +
        'credentials (see deploy/bootstrap-db.sql). It must NOT be the app or owner URL — db/platform.ts\n' +
        'refuses those, because borrowing either defeats the privilege boundary the plane rests on.',
    );
    process.exit(2);
  }

  const asOf = argOf('--as-of') ?? new Date().toISOString().slice(0, 10);
  const windowDays = Number(argOf('--window') ?? 30);
  const s = await platformUsageSummary({ asOf, windowDays });

  console.log(`Platform usage as at ${s.asOf}  (trailing ${s.windowDays} days)\n`);

  const pad = (v: string | number, n: number) => String(v).padEnd(n);
  const num = (v: number | string, n: number) => String(v).padStart(n);
  console.log(
    pad('tenant', 26) + pad('status', 11) + pad('last capture', 14) + num('empl', 6) + num('users', 7) + num('payslips', 10),
  );
  console.log('-'.repeat(74));
  for (const t of s.tenants) {
    // The staleness marker travels WITH the row. A figure captured five weeks ago printed beside one
    // captured yesterday, with nothing to tell them apart, is the mistake this column exists to stop.
    const stale =
      t.lastCapturedOn == null
        ? 'NEVER'
        : t.daysSinceCapture === 0
          ? t.lastCapturedOn
          : `${t.lastCapturedOn} (${t.daysSinceCapture}d)`;
    console.log(
      pad(t.tenantName.slice(0, 25), 26) +
        pad(t.tenantStatus, 11) +
        pad(stale, 14) +
        num(t.activeEmployments, 6) +
        num(t.activeUsers, 7) +
        num(t.payslipsGenerated, 10),
    );
  }

  console.log('');
  if (s.neverCaptured > 0) {
    console.log(`⚠ ${s.neverCaptured} tenant(s) have NEVER been metered.`);
  }
  if (s.missingDays > 0) {
    console.log(
      `⚠ ${s.missingDays} of the last ${s.windowDays} days have NO capture for any tenant.\n` +
        `  Usage cannot be backfilled — those days are permanently unbillable.\n` +
        `  Fix: sudo systemctl enable --now aihr-usage-capture.timer  (see deploy/systemd/README.md)`,
    );
  } else {
    console.log(`✓ every one of the last ${s.windowDays} days has a capture.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
