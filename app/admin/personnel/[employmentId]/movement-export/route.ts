/**
 * e6a144d4 — Download Excel on the Movement tab. The Employment History card had exactly one control
 * (New Event) and no way to get the record out; this is the way out.
 *
 * NOT A FOURTH SERIALIZER. It builds a neutral `ReportData` and hands it to `toXlsxReport`, exactly like
 * app/payroll/transaction-view/grid-export/route.ts, app/leave/employee-records/export/route.ts and
 * app/leave/employee-balances/export/route.ts. The workbook is the shared SpreadsheetML `.xls` (ADR-0047
 * §6) — Excel, Numbers and Sheets all open it by double-click; the plan tells the reporter in plain words
 * that it is not the newer .xlsx package, so the extension stays `.xls`.
 *
 * Read-only: NO DomainEvent. Downloading a report mutates nothing — the same posture as all three
 * precedents.
 *
 * SCOPE — MATCHES THE PAGE THIS BUTTON HANGS OFF, exactly: `scopedAdmin()`, then the page's own UUID shape
 * check, then `employeeDetail(s, employmentId)` and a 404 when it returns nothing. Be precise about what
 * that is: `employeeDetail` runs under `withTenant`, so RLS scopes it to the TENANT. It is NOT a company
 * fence, and page.tsx does not apply one either (its `scopeIds` is used once, to filter the superior
 * dropdown). Matching the page is the standard here — the file can then never expose more than the screen
 * it was launched from. Do not add a comment claiming a company-level check that neither surface performs.
 */
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { employeeDetail } from '@/core/read';
import { movementHistory } from '@/core/movement';
import { listMovementEventTypes } from '@/core/movement-type';
import { buildMovementExport, movementExportFilename } from '@/lib/movement-export';
import { movementKindLabel } from '@/lib/movement-kind-label';
import { employeeLabel } from '@/lib/employee-code';
import { toXlsxReport, type ReportData } from '@/lib/report-export';

/** The page's own shape check (page.tsx): a malformed segment reaches the query verbatim otherwise and
 *  comes back as a Postgres `invalid input syntax for type uuid` 500 instead of the 404 it means. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 5987 Content-Disposition: an ASCII-safe fallback plus a UTF-8 `filename*`. Copied verbatim from
 *  grid-export/route.ts. The filename embeds an employee NAME, which can be CJK or Tamil, and a raw
 *  non-Latin-1 value makes the Response constructor THROW — the download 500s instead of arriving. */
function contentDisposition(base: string, ext: string): string {
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ employmentId: string }> }) {
  const { s } = await scopedAdmin();
  const { employmentId } = await params;
  if (!UUID_RE.test(employmentId)) return new Response('Not found', { status: 404 });

  const emp = await employeeDetail(s, employmentId);
  if (!emp) return new Response('Not found', { status: 404 });

  const t = await getTranslations('people.detail');

  // UNFILTERED, on purpose. `partitionMovementRows` (95d17761) is a VIEW filter that keeps the reversed,
  // cancelled, corrected and superseded entries off the profile behind a Show link. The reporter asked for
  // the COMPLETE history, so this path never applies it and every row states its status instead.
  const rows = await movementHistory(s, employmentId);

  // 476f23ed — the tenant's own names for their event types win over the shipped captions, resolved
  // through the SAME helper the page uses so the file and the screen cannot drift.
  const typeByCode = new Map((await listMovementEventTypes(s)).map((r) => [r.code, r]));
  const kindLabel = (kind: string) => movementKindLabel(kind, typeByCode.get(kind)?.label, t);

  const built = buildMovementExport(rows, { t, kindLabel });
  const data: ReportData = {
    filename: movementExportFilename(emp.employeeCode, emp.name),
    title: t('movement.title'),
    columns: built.columns,
    rows: built.rows,
    layout: {
      orientation: 'landscape',
      // Event Type + Event Status stay in view as the reader scrolls the fourteen columns sideways.
      freeze: 2,
      subtitle: employeeLabel(emp.employeeCode, emp.name),
      description: emp.company ?? undefined,
    },
  };

  const file = toXlsxReport(data);
  return new Response(Buffer.from(file.bytes), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': contentDisposition(data.filename, file.ext),
    },
  });
}
