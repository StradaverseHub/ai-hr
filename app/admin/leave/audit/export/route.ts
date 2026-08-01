/**
 * Leave Audit export (4ec5a940). Admin-only; downloads the filtered leave-config change history as
 * CSV / XLSX / PDF. Re-runs `auditEvents` with the SAME filter params the Audit tab uses (validated
 * here too), scoped to the leave-module aggregates, capped at MAX_ROWS. Read-only — appends NO
 * DomainEvent (deliberate, documented skip: a download mutates nothing).
 *
 * Column headers stay ENGLISH (resolved from constants, not getTranslations) to keep the export
 * byte-stable for external consumers, mirroring ADR-0047. Every value flows through describePayload, so
 * the PII/financial masking on screen is identical in the file.
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { auditEvents } from '@/core/read';
import { serializeReport, type ReportFormat } from '@/lib/report-export';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  actionOf,
  aggregateLabel,
  describePayload,
  moduleKeyOf,
  MODULE_LABEL_EN,
  ACTOR_LABEL,
} from '@/lib/audit-format';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const FORMATS: ReportFormat[] = ['csv', 'xlsx', 'pdf'];
const MAX_ROWS = 5000;

const LEAVE_AGGREGATES = [
  'leave-type',
  'leave-policy',
  'leave-approval-policy',
  'leave-year',
  'leave-encashment-policy',
  'leave-grant',
  'job-grade',
  'leave-ledger-import',
];
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

  const type = LEAVE_AGGREGATES.includes(g('type')) ? g('type') : undefined;
  const action = ACTION_OPTIONS.includes(g('action')) ? g('action') : undefined;
  const user = UUID_RE.test(g('user')) ? g('user') : undefined;
  const company = UUID_RE.test(g('company')) ? g('company') : undefined;
  const leaveType = UUID_RE.test(g('leaveType')) ? g('leaveType') : undefined;

  try {
    const rows = await auditEvents(s, {
      aggregateType: type,
      aggregateTypes: type ? undefined : LEAVE_AGGREGATES,
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
    const data = {
      filename: `leave-audit-${stamp}`,
      title: 'Leave configuration audit trail',
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
    console.error('leave audit export failed', e);
    return new Response('Could not generate the export — please try again.', { status: 500 });
  }
}
