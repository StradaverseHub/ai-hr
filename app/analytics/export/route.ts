/**
 * Analytics CSV export (Wave 4C). Admin-only; company-scoped via the active company context.
 * Compensation columns appear only for the master-data report with comp=1 (admin-gated in the read
 * layer, Wave 1 #5). Read-only — downloading mutates nothing.
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { allowedCompanies } from '@/core/read';
import { getScopeIds } from '@/lib/scope';
import { toCsv } from '@/lib/csv';
import { masterDataExport, newHires, terminations } from '@/core/analytics';

const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

export async function GET(req: Request) {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });

  const url = new URL(req.url);
  const report = url.searchParams.get('report') ?? 'master-data';
  const today = new Date().toISOString().slice(0, 10);
  const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from')! : `${today.slice(0, 4)}-01-01`;
  const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to')! : today;

  const allowed = await allowedCompanies(s);
  const scopeIds = await getScopeIds(allowed.map((c) => c.id));

  let rows: (string | number | null | undefined)[][];
  let filename: string;

  try {
    if (report === 'new-hires') {
      const data = await newHires(s, scopeIds, { from, to });
      rows = [
        ['Name', 'Company', 'Department', 'Position', 'Hired on'],
        ...data.map((r) => [r.name, r.company, r.department, r.position, r.hiredOn]),
      ];
      filename = `new-hires_${from}_${to}.csv`;
    } else if (report === 'terminations') {
      const data = await terminations(s, scopeIds, { from, to });
      rows = [
        ['Name', 'Company', 'Department', 'Terminated on', 'Type', 'Reason'],
        ...data.map((r) => [r.name, r.company, r.department, r.terminatedOn, r.terminationType, r.terminationReason]),
      ];
      filename = `terminations_${from}_${to}.csv`;
    } else {
      // master-data
      const comp = url.searchParams.get('comp') === '1';
      const includeTerminated = url.searchParams.get('all') === '1';
      const data = await masterDataExport(s, scopeIds, { includeComp: comp, includeTerminated });
      const header = [
        'Employee code', 'Name', 'Email', 'Company', 'Department', 'Position', 'Status', 'Employment type', 'Hired on', 'Terminated on',
        ...(comp ? ['Basic salary', 'Monthly allowance', 'Currency'] : []),
      ];
      rows = [
        header,
        ...data.map((r) => [
          r.employeeCode, r.name, r.email, r.company, r.department, r.position, r.status, r.employmentType, r.hiredOn, r.terminatedOn,
          ...(comp ? [r.basicSalary ?? '', r.monthlyAllowance ?? '', r.currency ?? ''] : []),
        ]),
      ];
      filename = `master-data_${today}.csv`;
    }
    return new Response(toCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    console.error('analytics CSV export failed', e);
    return new Response('Could not generate the report — please try again.', { status: 500 });
  }
}
