/**
 * M09 — the employee's own payslip index, EA sources and the audited share of their PDFs, for the native app.
 * COMPOSITION ONLY: which payslips are the caller's own and released, and which EA forms exist, belong to the owners
 * the web's /me/payslip and /me/ea already use. Nothing here decides a release, an ownership or an amount.
 *
 *   index   myReleasedPayslipRuns (core/read.ts) — every employment of the person, current and past (D1), closed
 *           runs whose release instant has passed; keyset-paged in memory, grouped order (year, company, period)
 *   ea      myEaSources (core/reporting.ts) — the own (employment, employer, year) options and their availability
 *   share   a `confirmed` / `completed` / `cancelled` event per stage, appended in the mobile command receipt's
 *           transaction (core/mobile-command-receipt.ts). Identifiers only; never a figure (CLAUDE.md §8).
 *
 * The Payroll module gate is checked first; with the module off nothing is read. A blocked login never arrives
 * here: the bearer session is refused before the handler runs (lib/mobile-api/handler.ts), and the readers' own
 * `principal_snapshot_current()` fence refuses a stale principal besides.
 *
 * Kept free of 'server-only' (mobile-command-receipt.ts says why).
 */
import { and, asc, eq } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { domainEvent } from '../db/schema';
import { actorOf, appendEvent } from '../db/events';
import { isModuleEnabledOrFalse } from './entitlements';
import { myReleasedPayslipRuns } from './read';
import { myEaSources } from './reporting';
import { canonicalJson, MobileCommandOwnerRequired, withMobileCommandReceipt } from './mobile-command-receipt';
import { encodeCursor } from '../lib/mobile-api/v2/common';
import {
  PAYSLIPS_CURSOR, RunTypeV2, ShareEventResult,
  type EaSourcesV2, type PayslipIndexItemV2, type PayslipIndexV2, type SharedDocumentV2, type ShareEventCommand,
  type ShareEventRefusalCode, type ShareStage,
} from '../lib/mobile-api/v2/pay';

const refused = <C extends string>(code: C) => ({ outcome: 'refused' as const, code });
export const payrollEnabled = (ctx: SessionContext) => isModuleEnabledOrFalse(ctx, 'payroll');

// ── Index ──────────────────────────────────────────────────────────────────────────────────────────────────────

type Run = Awaited<ReturnType<typeof myReleasedPayslipRuns>>[number];
type Key = { period: string; companyId: string; runSeq: number; id: string };
/**
 * Grouped order: year desc, then employer (company id), then period desc, run sequence, payslip id. The canonical
 * reader orders period-first; the phone groups by employer and year, so a year's slips from two employers do not
 * interleave. Total over the four keys, so a keyset neither repeats nor skips.
 */
const order = (a: Key, b: Key) => {
  const ya = a.period.slice(0, 4), yb = b.period.slice(0, 4);
  if (ya !== yb) return ya < yb ? 1 : -1;
  if (a.companyId !== b.companyId) return a.companyId < b.companyId ? -1 : 1;
  if (a.period !== b.period) return a.period < b.period ? 1 : -1;
  if (a.runSeq !== b.runSeq) return a.runSeq - b.runSeq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};
const keyOf = (r: Run): Key => ({ period: r.payPeriod, companyId: r.companyId, runSeq: r.runSeq, id: r.payslipId });

/** One page of the caller's own released payslips: identity and context, never an amount. */
export async function payslipIndexV2(ctx: SessionContext, q: { limit: number; cursor: readonly [string, string, number, string] | null }): Promise<PayslipIndexV2> {
  if (!payrollEnabled(ctx)) return { enabled: false, items: [], nextCursor: null };
  const all = [...await myReleasedPayslipRuns(ctx)].sort((a, b) => order(keyOf(a), keyOf(b)));
  const at = q.cursor ? { period: q.cursor[0], companyId: q.cursor[1], runSeq: q.cursor[2], id: q.cursor[3] } : null;
  const after = (at ? all.filter((r) => order(keyOf(r), at) > 0) : all).slice(0, q.limit + 1);
  const rows = after.slice(0, q.limit), last = rows[rows.length - 1];
  return {
    enabled: true,
    items: rows.map((r): PayslipIndexItemV2 => ({
      id: r.payslipId, employmentId: r.employmentId, employeeCode: r.employeeCode, companyId: r.companyId, company: r.company,
      period: r.payPeriod, cycleName: r.cycleName, runType: RunTypeV2.parse(r.runType), runSeq: r.runSeq,
    })),
    nextCursor: after.length > q.limit && last ? encodeCursor(PAYSLIPS_CURSOR, [last.payPeriod, last.companyId, last.runSeq, last.payslipId]) : null,
  };
}

/** The caller's own RELEASED payslip's employment, or null (not own, not released, absent, module off). */
export async function ownReleasedPayslipEmployment(ctx: SessionContext, payslipId: string): Promise<string | null> {
  if (!payrollEnabled(ctx)) return null;
  return (await myReleasedPayslipRuns(ctx)).find((r) => r.payslipId === payslipId)?.employmentId ?? null;
}

// ── EA ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function eaSourcesV2(ctx: SessionContext): Promise<EaSourcesV2> {
  if (!payrollEnabled(ctx)) return { enabled: false, items: [] };
  const rows = await myEaSources(ctx);
  return {
    enabled: true,
    items: rows.map((r) => ({ employmentId: r.employmentId, employeeCode: r.employeeCode, companyId: r.companyId, company: r.company, year: r.year, available: r.available, isCurrent: r.isCurrent })),
  };
}

/** The own AVAILABLE EA source this names exactly (employment, employer, year), or null. */
async function ownAvailableEa(ctx: SessionContext, d: { employmentId: string; year: string; companyId: string }) {
  if (!payrollEnabled(ctx)) return null;
  return (await myEaSources(ctx)).find((r) => r.employmentId === d.employmentId && r.year === d.year && r.companyId === d.companyId && r.available) ?? null;
}

// ── Share events (D7) ──────────────────────────────────────────────────────────────────────────────────────────

export const DOCUMENT_SHARE_AGGREGATE = 'mobile-document-share';
export const DOCUMENT_SHARE_EVENTS: Record<ShareStage, string> = {
  confirmed: 'document.share.confirmed', completed: 'document.share.completed', cancelled: 'document.share.cancelled',
};
class ShareRefused extends Error {
  constructor(readonly code: ShareEventRefusalCode) { super(code); this.name = 'ShareRefused'; }
}
/** The audited reference: identifiers only. */
const documentOf = (d: SharedDocumentV2) => d.kind === 'payslip'
  ? { kind: 'payslip' as const, payslipId: d.id.toLowerCase() }
  : { kind: 'ea' as const, employmentId: d.employmentId.toLowerCase(), companyId: d.companyId.toLowerCase(), year: d.year };
/** jsonb does not keep key order, so the stored reference is compared canonically. */
const sameDocument = (a: unknown, b: ReturnType<typeof documentOf>) => { try { return canonicalJson(a) === canonicalJson(b); } catch { return false; } };

/** This share's prior stages, as this actor recorded them (none without a signed-in user). */
async function priorStagesTx(tx: Tx, ctx: SessionContext, shareId: string) {
  if (!ctx.userId) return [];
  return tx.select({ eventType: domainEvent.eventType, subject: domainEvent.subjectEmploymentId, payload: domainEvent.payload }).from(domainEvent).where(and(
    eq(domainEvent.tenantId, ctx.tenantId), eq(domainEvent.aggregateType, DOCUMENT_SHARE_AGGREGATE), eq(domainEvent.aggregateId, shareId),
    eq(domainEvent.actorId, ctx.userId),
  )).orderBy(asc(domainEvent.sequence));
}

/**
 * Record one stage of one share. `confirmed` admits through the owners (the caller's own released payslip, or own
 * available EA source); a closing stage needs this caller's acknowledged `confirmed` of the same document under the
 * same shareId, and closes it once. A refusal is raised inside the receipt's run, so it rolls back and records
 * nothing; an acknowledgement is recorded and replayed for a retried requestId.
 */
export async function recordShareEventV2(ctx: SessionContext, c: ShareEventCommand): Promise<ShareEventResult> {
  const shareId = c.shareId.toLowerCase(), document = documentOf(c.document);
  try {
    // The receipt's subject is the document's own employment — always one of the caller's own (receipt checks it).
    const d = c.document;
    const subject = c.stage !== 'confirmed'
      ? await confirmedSubject(ctx, shareId, document)
      : d.kind === 'payslip'
        ? await ownReleasedPayslipEmployment(ctx, d.id.toLowerCase())
        : (await ownAvailableEa(ctx, { employmentId: d.employmentId.toLowerCase(), year: d.year, companyId: d.companyId.toLowerCase() }))?.employmentId ?? null;
    if (!subject) return refused(c.stage === 'confirmed' ? 'not_found' : 'not_confirmed');
    return await withMobileCommandReceipt(ctx, {
      kind: 'document.share', requestId: c.requestId, actorEmploymentId: subject, response: ShareEventResult,
      intent: { shareId, document, stage: c.stage },
    }, async (tx) => {
      const prior = await priorStagesTx(tx, ctx, shareId);
      const confirmed = prior.find((e) => e.eventType === DOCUMENT_SHARE_EVENTS.confirmed);
      if (c.stage === 'confirmed') {
        if (prior.length) throw new ShareRefused('request_conflict'); // a shareId names one share
      } else {
        if (!confirmed || !sameDocument((confirmed.payload as { document?: unknown } | null)?.document, document)) throw new ShareRefused('not_confirmed');
        if (prior.some((e) => e.eventType !== DOCUMENT_SHARE_EVENTS.confirmed)) throw new ShareRefused('already_settled');
      }
      await appendEvent(tx, {
        tenantId: ctx.tenantId, aggregateType: DOCUMENT_SHARE_AGGREGATE, aggregateId: shareId, eventType: DOCUMENT_SHARE_EVENTS[c.stage],
        actor: actorOf(ctx), subjectEmploymentId: subject,
        payload: { channel: 'mobile', shareId, stage: c.stage, document },
      });
      return { outcome: 'recorded' as const, shareId, stage: c.stage };
    });
  } catch (e) {
    if (e instanceof ShareRefused) return refused(e.code);
    if (e instanceof MobileCommandOwnerRequired) return refused('employment_required');
    throw e;
  }
}

/** The subject of this caller's `confirmed` of this document under this shareId (read outside the receipt). */
async function confirmedSubject(ctx: SessionContext, shareId: string, document: ReturnType<typeof documentOf>): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    const confirmed = (await priorStagesTx(tx, ctx, shareId)).find((e) => e.eventType === DOCUMENT_SHARE_EVENTS.confirmed);
    return confirmed && sameDocument((confirmed.payload as { document?: unknown } | null)?.document, document) ? confirmed.subject : null;
  });
}
