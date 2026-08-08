/**
 * Audit Trail export (4ec5a940, promoted from /admin/leave/audit/export by f1b994e3). Admin-only;
 * downloads the filtered change history as CSV / XLSX / PDF. Re-runs `auditEvents` with the SAME filter
 * params the page uses (validated here too), capped at MAX_ROWS. Read-only — appends NO DomainEvent
 * (deliberate, documented skip: a download mutates nothing).
 *
 * f1b994e3 replaced the hardcoded LEAVE_AGGREGATES list with the Area (module) resolution the page and
 * `auditWhere` share, so `?module=leave` here returns exactly the rows `?module=leave` shows on screen.
 * The old route survives as a redirect stub carrying module=leave, so saved download links still work.
 *
 * Column headers stay ENGLISH (resolved from constants, not getTranslations) to keep the export
 * byte-stable for external consumers, mirroring ADR-0047 — the eight columns and the describePayload
 * masking are UNCHANGED from the leave export, byte for byte. Every value flows through describePayload,
 * so the PII/financial masking on screen is identical in the file.
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { auditEvents } from '@/core/read';
import { serializeReport, type ReportFormat } from '@/lib/report-export';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  actionOf,
  aggregateLabel,
  aggregateTypesForModule,
  describePayload,
  isModuleKey,
  moduleKeyOf,
  MODULE_LABEL_EN,
  ACTOR_LABEL,
} from '@/lib/audit-format';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const FORMATS: ReportFormat[] = ['csv', 'xlsx', 'pdf'];
const MAX_ROWS = 5000;

const ACTION_OPTIONS = ['created', 'updated', 'deleted', 'archived', 'unarchived', 'superseded'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** RFC 5987 Content-Disposition: an ASCII-safe fallback plus a UTF-8 `filename*`. */
function contentDisposition(base: string, ext: string): string {
  const full = `${base}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const actionTitle = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);

export async function GET(req: Request) {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });

  const url = new URL(req.url);
  const g = (k: string) => url.searchParams.get(k) ?? '';
  const fmtRaw = g('format');
  const format: ReportFormat = FORMATS.includes(fmtRaw as ReportFormat) ? (fmtRaw as ReportFormat) : 'csv';

  const moduleRaw = g('module');
  const moduleKey = isModuleKey(moduleRaw) ? moduleRaw : undefined;
  // Inside a named area the record type must belong to it, exactly as the on-screen dropdown offers only
  // that area's types; with no area chosen the ledger's type list is open-ended, so the value passes
  // through as a bound equality param (never interpolated).
  const inArea = moduleKey && moduleKey !== 'other' ? aggregateTypesForModule(moduleKey) : undefined;
  const type = inArea ? (inArea.includes(g('type')) ? g('type') : undefined) : g('type') || undefined;
  const action = ACTION_OPTIONS.includes(g('action')) ? g('action') : undefined;
  const user = UUID_RE.test(g('user')) ? g('user') : undefined;
  const company = UUID_RE.test(g('company')) ? g('company') : undefined;
  // Leave type is a leave question — it only binds in the leave area, mirroring the page's control.
  const leaveType = moduleKey === 'leave' && UUID_RE.test(g('leaveType')) ? g('leaveType') : undefined;

  try {
    const rows = await auditEvents(s, {
      module: moduleKey,
      aggregateType: type,
      eventQuery: g('q') || undefined,
      action,
      actorId: user,
      companyId: company,
      leaveTypeId: leaveType,
      from: DATE_RE.test(g('from')) ? g('from') : undefined,
      to: DATE_RE.test(g('to')) ? g('to') : undefined,
      limit: MAX_ROWS,
      offset: 0,
    });

    const columns = ['When (MYT)', 'Module', 'Record type', 'Action', 'Event', 'Who', 'Record ID', 'Changes'];
    const dataRows = rows.map((r) => {
      const when = new Date(r.occurredAt).toLocaleString('en-CA', {
        timeZone: 'Asia/Kuala_Lumpur',
        hour12: false,
      });
      const who = r.actorName ?? ACTOR_LABEL[r.actorType] ?? r.actorType;
      const changes = describePayload(r.payload)
        .map((d) => `${d.key}: ${d.value}`)
        .join(' | ');
      return [
        when,
        MODULE_LABEL_EN[moduleKeyOf(r.aggregateType)],
        aggregateLabel(r.aggregateType),
        actionTitle(actionOf(r.eventType)),
        r.eventType,
        who,
        r.aggregateId,
        changes,
      ];
    });

    const stamp = todayInKualaLumpur();
    // The area names the file, so an operator with four downloads in a folder can tell them apart. The
    // COLUMNS are what ADR-0047 keeps byte-stable, and they are unchanged.
    const data = {
      filename: moduleKey ? `audit-${moduleKey}-${stamp}` : `audit-${stamp}`,
      title: moduleKey ? `${MODULE_LABEL_EN[moduleKey]} audit trail` : 'Audit trail',
      columns,
      rows: dataRows,
    };
    const { bytes, contentType, ext } = await serializeReport(data, format);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': contentDisposition(data.filename, ext),
      },
    });
  } catch (e) {
    console.error('audit export failed', e);
    return new Response('Could not generate the export — please try again.', { status: 500 });
  }
}
