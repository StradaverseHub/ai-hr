/**
 * AI v2 P2-2b — the audit pack download: GET ?company=<id>&period=YYYY-MM -> one ZIP (core/payroll-audit/pack.ts).
 *
 * WHO. A group or HR administrator of the company, or an auditor with a current grant for it (migration 0965,
 * app.payroll_audit_can_read). Anyone else, a malformed request and a company outside the caller's reach all get the same
 * bare 404, so the route cannot be used to probe which companies exist. An administrator's pack is captured fresh first.
 *
 * THE DOWNLOAD IS ITSELF ACCESS-LOGGED, and fails closed: the entry (surface `audit_pack`, the archive's sha256, size and
 * capture count) is written before the bytes are handed over, and a pack whose entry cannot be written is not sent. The one
 * stated exception is a tenant in read-only standing (core/payroll-audit/access-log.ts), where the read proceeds unrecorded.
 *
 * Read-only otherwise: it files nothing, submits nothing and changes no payroll record.
 */
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { AuditPackRefused, buildAuditPack, type AuditPackLabels } from '@/core/payroll-audit/pack';
import { recordPayrollAccess } from '@/core/payroll-audit/access-log';
import { AUDIT_CAPTURE_KINDS, AUDIT_CONTROL_IDS, AUDIT_DISPOSITIONS, isPayPeriod } from '@/core/payroll-audit/types';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const companyId = q.get('company'), payPeriod = q.get('period');
  if (!companyId || !UUID.test(companyId) || !isPayPeriod(payPeriod)) return notFound();
  const s = await getSession();
  if (!s?.userId || s.agent) return notFound();
  const t = await getTranslations('payrollAudit.pack');
  const td = await getTranslations('payrollAudit.dispositions');
  const labels: AuditPackLabels = {
    title: t('title'), company: t('company'), payPeriod: t('payPeriod'), generated: t('generated'), by: t('by'), runs: t('runs'), runLine: t.raw('runLine') as string,
    statutory: t('statutory'), filingEvidence: t('filingEvidence'), findings: t('findings'), findingLine: t.raw('findingLine') as string,
    corrections: t('corrections'), correctionLine: t.raw('correctionLine') as string, captures: t('captures'), captureLine: t.raw('captureLine') as string,
    verification: t('verification'), verified: t.raw('verified') as string, notVerified: t.raw('notVerified') as string, anchors: t.raw('anchors') as string,
    files: t('files'), none: t('none'), findingItem: t.raw('findingItem') as string, open: t('open'), unprintable: t.raw('unprintable') as string,
    dispositions: Object.fromEntries(AUDIT_DISPOSITIONS.map(d => [d, td(d)])) as AuditPackLabels['dispositions'],
    kinds: Object.fromEntries(AUDIT_CAPTURE_KINDS.map(kind => [kind, t(`kinds.${kind}`)])) as AuditPackLabels['kinds'],
    controls: Object.fromEntries(AUDIT_CONTROL_IDS.map(id => [id, t(`controls.${id}`)])) as AuditPackLabels['controls'],
  };
  try {
    const pack = await buildAuditPack(s, { companyId, payPeriod }, labels);
    await recordPayrollAccess(s, { surface: 'audit_pack', action: 'export', companyId, payPeriod, format: 'zip', fileSha256: pack.sha256,
      bytes: pack.bytes.byteLength, rows: pack.captures });
    return new Response(new Uint8Array(pack.bytes), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${pack.filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Audit-Pack-SHA256': pack.sha256,
      },
    });
  } catch (e) {
    if (e instanceof AuditPackRefused) return notFound();
    throw e;
  }
}
