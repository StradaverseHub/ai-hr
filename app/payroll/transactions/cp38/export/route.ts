/**
 * 038c304b rev 2 (also card 5084d02e rev 2) — Payroll > Transaction Entry > CP38 Deduction "Export to Excel".
 *
 * GET with the page's own filters (?company, ?status, ?employmentId). Each is parsed exactly as page.tsx parses it:
 * a company outside the switcher scope or not administered, an unknown status or an employee outside the scope is
 * IGNORED (the export then covers what the page would show), never widened. With no filter: every company in scope.
 *
 * WHAT: one row per current CP38 record (deleted / superseded records excluded, leavers included), every page of the
 * list, in the list's order, through core/cp38.ts readCp38Export (the list's population, an exact count, then keyset
 * batches under one read-only snapshot — no per-row or per-company statement, never every row in memory). Amounts are
 * numbers shown with two decimals, Start Date and End Date (Last Date to Pay) real Excel dates; End Date is the last
 * month deducted (empty when open-ended), as on the screen.
 *
 * WHO: scopedAdmin + the Payroll module, as the page; the reader keeps only companies the session administers for
 * payroll (app.can_admin_payroll_for), so another company's records can never be in the file.
 *
 * AUDIT: each export appends `cp38.exported` (actor, company ids, filters, row count — no row values), in its own
 * short transaction after the read; the file is returned only once that event is written.
 */
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { readEmployeeChoices } from '@/core/employee-choice';
import { CP38_STATUSES, readCp38Export, recordCp38Export, type Cp38ListRow, type Cp38Status } from '@/packs/payroll/service';
import { transactionXlsxStream, type TransactionCell } from '@/lib/transaction-xlsx-stream';
import { todayInKualaLumpur } from '@/lib/hr-date';

export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request) {
  const { s, scopeIds } = await scopedAdmin();
  await requireModule('payroll', s);
  const t = await getTranslations('payroll.transactions.cp38');
  const sp = new URL(req.url).searchParams;
  const today = todayInKualaLumpur();

  // ── The page's filters, parsed the page's way (page.tsx): out of scope or malformed → ignored, never widened ──
  const rawCompany = sp.get('company') ?? '';
  const companies = rawCompany ? (await listCompanies(s, { adminOnly: true })).filter((c) => scopeIds.includes(c.id)) : [];
  const companyId = rawCompany && companies.some((c) => c.id === rawCompany) ? rawCompany : null;
  const rawStatus = sp.get('status') ?? '';
  const status = (CP38_STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as Cp38Status) : null;
  const rawEmployment = sp.get('employmentId') ?? '';
  const employmentId = UUID.test(rawEmployment)
    ? ((await readEmployeeChoices(s, { companyIds: scopeIds, labelMode: 'names', limit: 1, selectedId: rawEmployment })).selected?.employmentId ?? null)
    : null;
  const companyIds = companyId ? [companyId] : scopeIds;

  const headers = [
    t('exportColumns.employeeId'), t('exportColumns.employeeName'), t('exportColumns.company'), t('exportColumns.ref'),
    t('exportColumns.amount'), t('exportColumns.startDate'), t('exportColumns.endDate'), t('exportColumns.lastMonthAmount'),
    t('exportColumns.status'), t('exportColumns.remarks'),
  ];
  const statusLabel: Record<Cp38Status, string> = { active: t('statusActive'), upcoming: t('statusUpcoming'), ended: t('statusEnded') };
  const cells = (r: Cp38ListRow): TransactionCell[] => [
    r.employeeCode ?? null,
    r.employeeName,
    r.company,
    r.cp38Ref,
    { money: Number(r.amount) },
    { date: r.validFrom },
    r.validTo ? { date: r.validTo } : null,
    r.lastMonthAmount == null ? null : { money: Number(r.lastMonthAmount) },
    statusLabel[r.status],
    r.remarks ?? null,
  ];

  const { file, rowCount } = await readCp38Export(s, { companyIds, employmentId, status, today }, async (total, rows) => {
    async function* source() {
      for await (const row of rows) yield cells(row);
    }
    const chunks: Buffer[] = [];
    await pipeline(
      transactionXlsxStream(headers, source(), total, t('exportSheet')),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
    );
    return { file: Buffer.concat(chunks), rowCount: total };
  });
  await recordCp38Export(s, { companyIds, company: companyId, status, employmentId, rowCount });

  return new Response(new Uint8Array(file), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="cp38-deductions_${today}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
}
