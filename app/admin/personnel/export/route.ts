import { withTenant } from '@/db/client';
import {workforceViewScope} from '@/core/workforce-access';
import {getSession} from '@/lib/session';
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
 * Effective Workforce-view gated and READ-ONLY: downloading a report mutates nothing, so no DomainEvent (the
 * app/leave/employee-records/export/route.ts precedent). Not registered in lib/permissions.ts — the
 * reverse-completeness scan reads page.tsx files only and a route handler has no screen column to
 * describe (the /admin/leave/entitlements/ledger-archive/export precedent).
 */
import { getTranslations } from 'next-intl/server';
import { getScopeIds } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { listEmployeesPage, listWorkforcePersonnelPresentationPageTx } from '@/core/read';
import { getEmployeeListColumns } from '@/core/employee-list-prefs';
import { listEmployeeDrafts } from '@/core/employee-draft';
import { deriveEmploymentStatus } from '@/core/employment-status';
import { columnsFromParam, employeeColumnText, EMPLOYEE_COLUMN_KEYS, type EmployeeColumnKey } from '@/lib/employee-columns';
import { toCsvReport, toXlsxReport, type ReportData } from '@/lib/report-export';
import { parsePageQuery } from '@/lib/pagination';
import { isCalendarDate } from '@/lib/calendar-date';
import { personnelFieldLabel } from '@/lib/personnel-field-label';
import { PERSONNEL_DATE_COLUMNS } from '@/lib/personnel-list-controls';
import { PersonnelExportSizeError, readPersonnelListExportDetails } from '@/core/personnel-list-export-details';
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
  try {
    return await exportPersonnel(req);
  } catch (error) {
    if (error instanceof PersonnelExportSizeError) {
      return new Response('Too many details. Narrow the filters before exporting.', {
        status: 413, headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    throw error;
  }
}

async function exportPersonnel(req: Request) {
  const session=await getSession();
  const allowed=await workforceViewScope(session, { personnelList: true });
  if(!allowed.canOpen||allowed.companyIds.length===0)return new Response('Forbidden',{status:403});
  const scopeIds=await getScopeIds(allowed.companyIds),allowedCount=allowed.companyIds.length;

  const url = new URL(req.url);
  const sp = url.searchParams;
  const mode = sp.get('mode');
  const pagination = parsePageQuery({ page: sp.get('page') ?? undefined, size: sp.get('size') ?? undefined });
  const params: PersonnelSearchParams = {};
  for(const key of ['q','company','companies','dept','status','type','bucket','cols','bu','parent','group','grade','position','quality','confirmation','joinedFrom','joinedTo','probationFrom','probationTo','search','sort','direction'] as const){const values=sp.getAll(key).map(value=>value.trim()).filter(Boolean);if(values.length)Object.assign(params,{[key]:['companies','bu','parent','group','grade','position','quality'].includes(key)&&values.length>1?values:values[0]});}
  const query = parsePersonnelListQuery(params);
  // xlsx is this item's default — the reporter asked for Excel by name. `format=csv` stays available
  // because the neutral report shape gets it for free and some downstream tools prefer it.
  const format = sp.get('format') === 'csv' ? 'csv' : 'xlsx';

  const t = await getTranslations('people.list');
  const tStatus = await getTranslations('people.employeeStatus');
  const today = todayInKualaLumpur();

  const columns = mode === 'all'
    ? [...EMPLOYEE_COLUMN_KEYS]
    : columnsFromParam(params.cols, await getEmployeeListColumns(session));

  // Draft-only is not an employment query at all — the same suppression the screen applies. Exporting
  // the drafts under it keeps "what is on screen" literally true for the one selection where the rows
  // come from a different table.
  const listInput = {
    companyIds: scopeIds,
    ...query.filters,
    limit: mode === 'page' ? pagination.limit : ROW_CAP,
    offset: mode === 'page' ? pagination.offset : 0,
  };
  const { rows, total, details } = query.draftOnly
    ? { rows: [], total: 0, details: null }
    : mode === 'all'
      ? await withTenant(session, async tx => {
          const matching = await listWorkforcePersonnelPresentationPageTx(session, listInput, today, tx);
          const details = matching.total > ROW_CAP ? null
            : await readPersonnelListExportDetails(session, matching.rows, today, tx);
          return { ...matching, details };
        }, { readOnlySnapshot: true })
      : { ...await listEmployeesPage(session, listInput, 'workforce'), details: null };
  if(mode !== 'page' && total>ROW_CAP)return new Response('Too many matching employees. Narrow the filters before exporting.',{status:413,headers:{'Cache-Control':'private, no-store','Vary':'Cookie'}});
  // b1b1879d — the SAME top-bar scope the employees above are read under, built by the same function the
  // screen uses. Without it a file exported while viewing one company carried every company's drafts.
  const includeDrafts = mode === 'page' ? pagination.offset === 0 : mode !== 'all' && query.draftOnly;
  const drafts = includeDrafts && isAdmin(session)
    ? (await listEmployeeDrafts(session, draftListScope(scopeIds, allowedCount))).filter((d) =>
        draftMatchesQuery(d, query),
      )
    : [];

  if(drafts.length>ROW_CAP)return new Response('Too many matching drafts. Narrow the filters before exporting.',{status:413,headers:{'Cache-Control':'private, no-store','Vary':'Cookie'}});

  if ((mode === 'page' || mode === 'all') && rows.length + drafts.length === 0) {
    return new Response(t('exportEmpty'), { status: 422, headers: { 'Cache-Control': 'private, no-store' } });
  }

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
                  ? mode === 'page' ? d.companyName ?? t('draftNoCompany') : d.companyName
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

  const file = mode === 'page' || mode === 'all'
    ? await personnelWorkbook(data, columns, rows, drafts.length, details)
    : format === 'csv' ? toCsvReport(data) : toXlsxReport(data);
  return new Response(Buffer.from(file.bytes), {
    headers: {
      'Cache-Control':'private, no-store','Vary':'Cookie','Referrer-Policy':'no-referrer',
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${data.filename}.${file.ext}"`,
    },
  });
}

async function personnelWorkbook(
  data: ReportData,
  columns: EmployeeColumnKey[],
  rows: Awaited<ReturnType<typeof listEmployeesPage>>['rows'],
  draftCount: number,
  details: Awaited<ReturnType<typeof readPersonnelListExportDetails>> | null,
) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const messages = details ? await getTranslations() : null;
  const labels = new Set(data.columns);
  const detailColumns = details?.fields.flatMap((field, index) => {
    const label = personnelFieldLabel(field, (key, fallback) => messages?.has(key) ? messages(key) : fallback);
    if (labels.has(label)) return [];
    labels.add(label);
    return [{ field, index, label }];
  }) ?? [];
  const asDate = (value: string | number | null) =>
    typeof value === 'string' && isCalendarDate(value) ? new Date(value + 'T00:00:00Z') : value;
  const cells = data.rows.map((row, index) => {
    const base = row.map((value, col) => PERSONNEL_DATE_COLUMNS.has(columns[col]) ? asDate(value) : value);
    const extra = index >= draftCount ? details?.cells.get(rows[index - draftCount]?.employmentId) : undefined;
    return [...base, ...detailColumns.map(({ field, index: col }) => {
      const value = extra?.[col];
      if (value?.unavailable || value?.value == null) return null;
      if (field.type === 'date' && typeof value.value === 'string') return asDate(value.value);
      if (['number', 'currency'].includes(field.type) && /^-?\d+(\.\d+)?$/.test(String(value.value))) {
        return Number(value.value);
      }
      return value.display ?? value.value;
    })];
  });
  // AOA strings become text cells, including any value starting with =, +, - or @.
  const sheet = XLSX.utils.aoa_to_sheet([[...data.columns, ...detailColumns.map(column => column.label)], ...cells], {
    dateNF: 'dd/mm/yyyy',
  });
  XLSX.utils.book_append_sheet(workbook, sheet, 'Personnel');
  return {
    bytes: new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true })),
    ext: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}
