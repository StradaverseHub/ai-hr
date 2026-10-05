/**
 * Personnel employee-listing export (feedback 579255c3, points 9 & 10) — the currently filtered list as
 * an Excel workbook.
 *
 * Two promises, and both are kept by CONSTRUCTION rather than by care:
 *   • "the export should respect the selected filters" — the params are parsed by the SAME
 *     parsePersonnelListQuery the screen uses, and fed to the SAME listEmployeesPage. There is no second
 *     reading of the query string to drift out of step.
 *   • "the export should follow the same selected columns and order" — the column list arrives on the
 *     Export link the screen built from its own resolved columns (`cols=`), and each cell is produced by
 *     the shared employeeColumnText the table renders from. Two switch statements is how a file comes to
 *     print a different Position from the screen it was exported off.
 *
 * Admin-gated and READ-ONLY: downloading a report mutates nothing, so no DomainEvent (the
 * app/leave/employee-records/export/route.ts precedent). Not registered in lib/permissions.ts — the
 * reverse-completeness scan reads page.tsx files only and a route handler has no screen column to
 * describe (the /admin/leave/entitlements/ledger-archive/export precedent).
 */
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { listEmployeesPage } from '@/core/read';
import { getEmployeeListColumns } from '@/core/employee-list-prefs';
import { listEmployeeDrafts } from '@/core/employee-draft';
import { deriveEmploymentStatus } from '@/core/employment-status';
import { columnsFromParam, employeeColumnText, type EmployeeColumnKey } from '@/lib/employee-columns';
import { toCsvReport, toXlsxReport, type ReportData } from '@/lib/report-export';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { draftListScope, draftMatchesQuery, parsePersonnelListQuery, type PersonnelSearchParams } from '../list-query';

/** Header key per column — the SAME people.list.col* keys the table's <th> row resolves. */
const HEADER_KEY: Record<EmployeeColumnKey, string> = {
  code: 'colCode',
  name: 'colName',
  company: 'colCompany',
  department: 'colDepartment',
  position: 'colPosition',
  status: 'colStatus',
  jobGrade: 'colJobGrade',
  employmentType: 'colEmploymentType',
  reportingTo: 'colReportingTo',
  businessUnit: 'colBusinessUnit',
  costCenter: 'colCostCenter',
  workLocation: 'colWorkLocation',
  groupJoinDate: 'colHired',
  joinDate: 'colJoinDate',
  confirmationDate: 'colConfirmationDate',
  email: 'colEmail',
};

const EMPLOYMENT_TYPE_KEY: Record<string, string> = {
  full_time: 'employmentFullTime',
  part_time: 'employmentPartTime',
  contract: 'employmentContract',
  intern: 'employmentIntern',
};

/** An explicit cap rather than the screen's page size (25): the file is the whole filtered set, but one
 *  download must still be bounded. 10_000 is the same ceiling the leave-record export uses. */
const ROW_CAP = 10_000;

export async function GET(req: Request) {
  const { s: session, scopeIds, allowedCount } = await scopedSession();
  if (!isAdmin(session)) return new Response('Forbidden', { status: 403 });

  const url = new URL(req.url);
  const sp = url.searchParams;
  const one = (k: string) => sp.get(k)?.trim() || undefined;
  const params: PersonnelSearchParams = {
    q: one('q'),
    company: one('company'),
    dept: one('dept'),
    status: one('status'),
    type: one('type'),
    bucket: one('bucket'),
    cols: one('cols'),
  };
  const query = parsePersonnelListQuery(params);
  // xlsx is this item's default — the reporter asked for Excel by name. `format=csv` stays available
  // because the neutral report shape gets it for free and some downstream tools prefer it.
  const format = sp.get('format') === 'csv' ? 'csv' : 'xlsx';

  const t = await getTranslations('people.list');
  const tStatus = await getTranslations('people.employeeStatus');
  const today = todayInKualaLumpur();

  const columns = columnsFromParam(params.cols, await getEmployeeListColumns(session));

  // Draft-only is not an employment query at all — the same suppression the screen applies. Exporting
  // the drafts under it keeps "what is on screen" literally true for the one selection where the rows
  // come from a different table.
  const { rows } = query.draftOnly
    ? { rows: [] }
    : await listEmployeesPage(session, {
        companyIds: scopeIds,
        ...query.filters,
        limit: ROW_CAP,
        offset: 0,
      });
  // b1b1879d — the SAME top-bar scope the employees above are read under, built by the same function the
  // screen uses. Without it a file exported while viewing one company carried every company's drafts.
  const drafts = query.draftOnly
    ? (await listEmployeeDrafts(session, draftListScope(scopeIds, allowedCount))).filter((d) =>
        draftMatchesQuery(d, query),
      )
    : [];

  const cell = (v: string | null): string => v ?? '';
  const data: ReportData = {
    // ascii-safe base, dated in the TENANT's timezone: a bare toISOString().slice(0,10) reads as
    // yesterday between 00:00 and 08:00 MYT (r85's class of bug).
    filename: `employees-${today}`,
    title: t('exportTitle'),
    columns: columns.map((k) => t(HEADER_KEY[k])),
    rows: [
      // Drafts first, exactly as the screen pins them, and only when the Draft selection is on.
      ...drafts.map((d) =>
        columns.map((k) =>
          cell(
            k === 'code'
              ? d.reservedEmployeeCode
              : k === 'name'
                ? (d.label ?? t('draftUntitled'))
                : k === 'company'
                  ? d.companyName
                  : k === 'status'
                    ? t('statusDraft')
                    : null,
          ),
        ),
      ),
      ...rows.map((r) =>
        columns.map((k) =>
          cell(
            employeeColumnText(r, k, {
              status: tStatus(deriveEmploymentStatus(r, today)),
              employmentType: r.employmentType ? t(EMPLOYMENT_TYPE_KEY[r.employmentType] ?? 'employmentType') : null,
            }),
          ),
        ),
      ),
    ],
  };

  const file = format === 'csv' ? toCsvReport(data) : toXlsxReport(data);
  return new Response(Buffer.from(file.bytes), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${data.filename}.${file.ext}"`,
    },
  });
}
