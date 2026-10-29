// One-shot operator CLI (board item b6dbadc5) — convert every stored pre-additive Top-up election
// (`voluntary_excess` with an employer rate, i.e. TOTAL rates paid as max(total, statutory)) to the additive
// `topup_percentage` mode, with increment = max(0, stored − the statutory rate of that side on the employee's
// latest processed regular payslip, or for the current salary when there is none). Each employee keeps paying
// exactly what that payslip's wage band pays today. Employee-only rows (Semi-Auto) and rows with no rates are
// never touched. See localization/my/epf-topup-conversion.ts and the ADR-0158 b6dbadc5 addendum.
//
// Writes go through the MY pack's existing statutory writer (event `statutory.my.updated` with the EPF
// election before/after). It also LISTS open new-hire drafts whose Top-up boxes still hold full rates; those
// are not changed (a draft has no payslip to derive the normal rate from) and HR re-enters them as top-ups.
//
// Read-only unless --apply is passed; idempotent (a converted row is no longer a candidate). Writes the
// old/new review file for HR to --csv=<path> (default ./epf-topup-conversion-<mode>.csv).
//   node --env-file=.env.production --import tsx scripts/convert-epf-topup-percentage.ts          # dry run
//   node --env-file=.env.production --import tsx scripts/convert-epf-topup-percentage.ts --apply  # convert
//
// Requires the 0697 migration. NOT run against staging or production by the change that added it: running it
// is a separate, owner-authorised release step after the release gate and a populated rehearsal.
import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { tenant } from '../db/schema';
// Jurisdiction resolves through the registry (ADR-0080 D1/D7), never a direct localization/my import.
import { packFor, type CountryPack } from '../localization/registry';

type LegacyTopupReportRow = Awaited<ReturnType<NonNullable<CountryPack['statutory']['convertLegacyEpfTopups']>>>['rows'][number];

/** Open drafts whose Top-up rate boxes were filled before b6dbadc5 hold full rates; they are listed, never converted. */
export function draftTopupReviewRows(drafts: readonly { id: string; label: string | null; data: unknown }[]): LegacyTopupReportRow[] {
  const out: LegacyTopupReportRow[] = [];
  for (const d of drafts) {
    const s = ((d.data as { statutory?: Record<string, unknown> } | null)?.statutory ?? {}) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    if (text(s.epfMode) !== 'voluntary_percentage' || (!text(s.epfEmployeeRate) && !text(s.epfEmployerRate))) continue;
    const fraction = (v: unknown) => (text(v) === '' || !Number.isFinite(Number(text(v))) ? null : Number(text(v)) / 100);
    out.push({ status: 'draft_review', employeeCode: null, name: d.label || null, personId: null, draftId: d.id, basis: null,
      oldEmployeeRate: fraction(s.epfEmployeeRate), oldEmployerRate: fraction(s.epfEmployerRate), plan: null });
  }
  return out;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const csvPath = process.argv.find(a => a.startsWith('--csv='))?.slice('--csv='.length) ?? `epf-topup-conversion-${apply ? 'applied' : 'dry-run'}.csv`;
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('convert-epf-topup-percentage requires MIGRATION_DATABASE_URL (owner role) to enumerate tenants.');
    process.exit(1);
  }
  const pack = packFor('MY');
  if (!pack?.statutory.convertLegacyEpfTopups || !pack.statutory.legacyEpfTopupCsv) {
    console.error('convert-epf-topup-percentage: no MY localization pack with the Top-up conversion registered.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`convert-epf-topup-percentage — ${tenants.length} tenant(s), mode=${apply ? 'APPLY' : 'dry-run'}`);
  const report: (LegacyTopupReportRow & { tenant: string })[] = [];
  let failures = 0;
  for (const t of tenants) {
    try {
      // SYSTEM context (hr_admin authorises the statutory write and the payroll reads; no userId → actor `system`).
      const r = await pack.statutory.convertLegacyEpfTopups({ tenantId: t.id, roles: ['hr_admin'], entitlementsExempt: 'sweeps' }, { apply });
      // Drafts are author-scoped under RLS, so the read-only listing uses the owner connection.
      const drafts = await owner.db.execute<{ id: string; label: string | null; data: unknown }>(
        sql`select id, label, data from employee_draft where tenant_id = ${t.id} and data->'statutory'->>'epfMode' = 'voluntary_percentage'`);
      const draftRows = draftTopupReviewRows([...drafts]);
      for (const row of [...r.rows, ...draftRows]) report.push({ ...row, tenant: t.name });
      if (r.scanned > 0 || draftRows.length > 0) {
        const count = (s: string) => r.rows.filter(row => row.status === s).length;
        console.log(`  ${t.name}: ${r.scanned} legacy Top-up row(s) — ${apply ? 'converted' : 'would convert'} ${count(apply ? 'converted' : 'would_convert')}, ` +
          `skipped ${count('skipped')}, changed since read ${count('changed_since_read')}; ${draftRows.length} draft(s) to re-enter`);
      }
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name}: ${(e as Error).message}`);
    }
  }
  const csv = pack.statutory.legacyEpfTopupCsv(report);
  const withTenantColumn = csv.split('\n').map((line, i) => (line === '' ? line : `${i === 0 ? 'tenant' : JSON.stringify(report[i - 1].tenant)},${line}`)).join('\n');
  writeFileSync(csvPath, withTenantColumn);
  console.log(`convert-epf-topup-percentage done — ${report.length} row(s) written to ${csvPath}, ${failures} failure(s).${apply ? '' : ' Re-run with --apply to write.'}`);
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
