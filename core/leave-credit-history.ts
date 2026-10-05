/**
 * r389 bc3e203d · THE EMPLOYEE'S OWN LEAVE CREDIT HISTORY — one read, every stored fact, nothing derived twice.
 *
 * WHOSE ROWS. The session PERSON's own employments, resolved here from `ctx.personId`, never from an id the
 * caller hands in — so the page and its export cannot be pointed at somebody else's requests by a query
 * string. EVERY employment of that person, not only `myEmployment`'s first active one: a rehired person keeps
 * seeing the earlier employment's requests, the same rule /leave/history applies (components/leave/
 * own-leave-history.tsx, `myEmploymentIdsAll`). RLS still fences every read underneath, but it is not what
 * scopes this list: a line manager or an HR administrator can SEE other people's requests through RLS, and
 * this read must still return only their own. That is why the person filter is explicit rather than left to
 * the policy (test/r389-leave-credit-history.test.ts drives it with an administrator who is also an employee).
 *
 * WHAT IT READS, EACH FROM ITS OWNER:
 *   · replacement_leave_request          — the request: submitted on, status, the decision instant and note;
 *   · replacement_leave_request_date     — the line: date worked, day kind, the claimed window, its credit days
 *                                          and the attendance snapshot stored with it;
 *   · toil_accrual (via the line's accrual_id) — the credit: status, expires_on, days_credited, reversed_at;
 *   · domain_event                       — `toil.consumed` / `toil.restored` (which leave applications used the
 *                                          credit, and how much each gave back), `toil.lapsed` /
 *                                          `toil.converted` (the days settled at expiry), and
 *                                          `replacement-leave-request.cancelled` (when the employee withdrew).
 *                                          Employee-readable by subject RLS (migration 0037).
 *   · leave_request                      — the dates and leave type of each application that used a credit.
 *   · app.own_replacement_request_deciders (migration 0512) — the display name of whoever decided each of
 *                                          the person's OWN decided requests. A SECURITY DEFINER read, because
 *                                          the decider's `person` row is invisible to the employee through RLS
 *                                          (visibility flows downward); it checks ownership itself and returns
 *                                          the name and nothing else about them.
 *
 * ⚠️ NEVER MONEY. `toil.converted` carries `amountOwed` and a valuation basis in its payload. Only the DAY
 * fields are selected out of the payload (`->> 'daysCredited'`, `->> 'asOf'`), never the payload itself, so
 * no amount ever leaves this function and a screen built on it cannot print one by accident.
 *
 * Read-only → no DomainEvent.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import {
  domainEvent,
  employment,
  leaveRequest,
  replacementLeaveRequest,
  replacementLeaveRequestDate,
  toilAccrual,
} from '../db/schema';
import { timeInKualaLumpur, todayInKualaLumpur } from '../lib/hr-date';
import {
  CREDIT_DAY_TYPES,
  CREDIT_STATUS_OF_ACCRUAL,
  requestRefOf,
  type CreditDayType,
  type CreditHistoryLine,
  type CreditUsage,
} from '../lib/leave-credit-history';

const round2 = (n: number) => Math.round(n * 100) / 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: string | number | null | undefined) => {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? 0 : n;
};

/** The event types this read draws on. Named once so the test can pin that nothing else is read. */
export const LEAVE_CREDIT_HISTORY_EVENTS = ['toil.consumed', 'toil.restored', 'toil.lapsed', 'toil.converted'] as const;
export const LEAVE_CREDIT_CANCELLED_EVENT = 'replacement-leave-request.cancelled';

/** Every Leave Credit request line of the signed-in person, unfiltered and unsorted (lib/ does both). */
export async function listOwnLeaveCreditHistory(ctx: SessionContext): Promise<CreditHistoryLine[]> {
  const personId = ctx.personId;
  if (!personId) return [];
  return withTenant(ctx, async (tx) => {
    const mine = await tx.select({ id: employment.id }).from(employment).where(eq(employment.personId, personId));
    const employmentIds = mine.map((m) => m.id);
    if (employmentIds.length === 0) return [];

    const heads = await tx
      .select({
        id: replacementLeaveRequest.id,
        submittedOn: replacementLeaveRequest.submittedOn,
        status: replacementLeaveRequest.status,
        decidedAt: replacementLeaveRequest.decidedAt,
        decisionNote: replacementLeaveRequest.decisionNote,
        reason: replacementLeaveRequest.reason,
      })
      .from(replacementLeaveRequest)
      .where(inArray(replacementLeaveRequest.employmentId, employmentIds));
    if (heads.length === 0) return [];
    const requestIds = heads.map((h) => h.id);

    const lines = await tx
      .select()
      .from(replacementLeaveRequestDate)
      .where(inArray(replacementLeaveRequestDate.requestId, requestIds))
      .orderBy(asc(replacementLeaveRequestDate.workedDate), asc(replacementLeaveRequestDate.id));

    // When the employee withdrew a request: the cancellation event is the record (the request row keeps no
    // "cancelled at" column, and `decided_at` is the APPROVAL instant the expiry is counted from — reusing it
    // for a withdrawal would put a meaning into it that core/toil.ts's expiry reader does not expect).
    const cancelledIds = heads.filter((h) => h.status === 'cancelled').map((h) => h.id);
    const cancelledAt = new Map<string, Date>();
    if (cancelledIds.length > 0) {
      const ev = await tx
        .select({ id: domainEvent.aggregateId, at: domainEvent.occurredAt })
        .from(domainEvent)
        .where(
          and(
            eq(domainEvent.tenantId, ctx.tenantId),
            eq(domainEvent.aggregateType, 'replacement-leave-request'),
            inArray(domainEvent.aggregateId, cancelledIds),
            eq(domainEvent.eventType, LEAVE_CREDIT_CANCELLED_EVENT),
          ),
        )
        .orderBy(asc(domainEvent.sequence));
      for (const e of ev) if (!cancelledAt.has(e.id)) cancelledAt.set(e.id, e.at);
    }

    const accrualIds = [...new Set(lines.flatMap((l) => (l.accrualId ? [l.accrualId] : [])))];
    const accruals = accrualIds.length
      ? await tx
          .select({
            id: toilAccrual.id,
            status: toilAccrual.status,
            expiresOn: toilAccrual.expiresOn,
            daysCredited: toilAccrual.daysCredited,
            reversedAt: toilAccrual.reversedAt,
          })
          .from(toilAccrual)
          .where(inArray(toilAccrual.id, accrualIds))
      : [];
    const accrualById = new Map(accruals.map((a) => [a.id, a]));

    // The day figures only — see the header's NEVER MONEY note.
    const events = accrualIds.length
      ? await tx
          .select({
            accrualId: domainEvent.aggregateId,
            type: domainEvent.eventType,
            requestId: sql<string | null>`${domainEvent.payload} ->> 'requestId'`,
            consumed: sql<string | null>`${domainEvent.payload} ->> 'daysConsumed'`,
            restored: sql<string | null>`${domainEvent.payload} ->> 'daysRestored'`,
            settledDays: sql<string | null>`${domainEvent.payload} ->> 'daysCredited'`,
            asOf: sql<string | null>`${domainEvent.payload} ->> 'asOf'`,
          })
          .from(domainEvent)
          .where(
            and(
              eq(domainEvent.tenantId, ctx.tenantId),
              eq(domainEvent.aggregateType, 'toil-accrual'),
              inArray(domainEvent.aggregateId, accrualIds),
              inArray(domainEvent.eventType, [...LEAVE_CREDIT_HISTORY_EVENTS]),
            ),
          )
          .orderBy(asc(domainEvent.sequence))
      : [];

    // Per credit: what each leave application took from it, net of what a cancellation gave back.
    const netByAccrual = new Map<string, Map<string, number>>();
    const settledByAccrual = new Map<string, { kind: 'expired' | 'paid_out'; days: number; on: string }>();
    for (const e of events) {
      if (e.type === 'toil.lapsed' || e.type === 'toil.converted') {
        settledByAccrual.set(e.accrualId, {
          kind: e.type === 'toil.lapsed' ? 'expired' : 'paid_out',
          days: round2(num(e.settledDays)),
          on: e.asOf ?? '',
        });
        continue;
      }
      if (!e.requestId) continue;
      const per = netByAccrual.get(e.accrualId) ?? new Map<string, number>();
      const delta = e.type === 'toil.consumed' ? num(e.consumed) : -num(e.restored);
      per.set(e.requestId, round2((per.get(e.requestId) ?? 0) + delta));
      netByAccrual.set(e.accrualId, per);
    }

    const leaveIds = [...new Set([...netByAccrual.values()].flatMap((m) => [...m.keys()]))].filter((id) => UUID.test(id));
    const leaves = leaveIds.length
      ? await tx
          .select({ id: leaveRequest.id, startDate: leaveRequest.startDate, endDate: leaveRequest.endDate, leaveTypeId: leaveRequest.leaveTypeId })
          .from(leaveRequest)
          .where(inArray(leaveRequest.id, leaveIds))
      : [];
    const leaveById = new Map(leaves.map((l) => [l.id, l]));

    // The decider's name, for the person's own decided requests only (the function re-checks ownership).
    const decidedIds = heads.filter((h) => (h.status === 'approved' || h.status === 'rejected') && UUID.test(h.id)).map((h) => h.id);
    const deciderName = new Map<string, string>();
    if (decidedIds.length > 0) {
      const rows = (await tx.execute(
        sql`SELECT request_id, decided_by_name FROM app.own_replacement_request_deciders(${`{${decidedIds.join(',')}}`}::uuid[])`,
      )) as unknown as { request_id: string; decided_by_name: string | null }[];
      for (const r of rows) if (r.decided_by_name) deciderName.set(r.request_id, r.decided_by_name);
    }

    const headById = new Map(heads.map((h) => [h.id, h]));
    return lines.map((l): CreditHistoryLine => {
      const h = headById.get(l.requestId)!;
      const decidedInstant = h.status === 'cancelled' ? (cancelledAt.get(h.id) ?? null) : h.decidedAt;
      const acc = l.accrualId ? accrualById.get(l.accrualId) : undefined;
      let credit: CreditHistoryLine['credit'] = null;
      if (acc && h.status === 'approved') {
        const per = netByAccrual.get(acc.id) ?? new Map<string, number>();
        const used = round2([...per.values()].reduce((s, v) => s + v, 0));
        const status = CREDIT_STATUS_OF_ACCRUAL[acc.status];
        const usage: CreditUsage[] = [...per.entries()]
          .filter(([, days]) => days > 0.004)
          .flatMap(([leaveRequestId, days]) => {
            const lr = leaveById.get(leaveRequestId);
            return lr ? [{ leaveRequestId, startDate: lr.startDate, endDate: lr.endDate, leaveTypeId: lr.leaveTypeId, days }] : [];
          })
          .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.leaveRequestId.localeCompare(b.leaveRequestId));
        credit = {
          accrualId: acc.id,
          status,
          expiresOn: acc.expiresOn,
          daysCredited: round2(num(acc.daysCredited)),
          used,
          remaining: status === 'available' ? round2(Math.max(0, num(acc.daysCredited) - used)) : 0,
          settled: settledByAccrual.get(acc.id) ?? null,
          reversedOn: acc.reversedAt ? todayInKualaLumpur(acc.reversedAt) : null,
          usage,
        };
      }
      const kind = l.workedDayKind;
      return {
        lineId: l.id,
        requestId: h.id,
        requestRef: requestRefOf(h.id),
        workedDate: l.workedDate,
        dayType: kind && (CREDIT_DAY_TYPES as readonly string[]).includes(kind) ? (kind as CreditDayType) : null,
        fromTime: l.fromTime ?? null,
        toTime: l.toTime ?? null,
        hours: l.hours != null ? num(l.hours) : null,
        days: l.days != null ? num(l.days) : null,
        submittedOn: h.submittedOn,
        approvalStatus: h.status,
        decidedOn: decidedInstant ? todayInKualaLumpur(decidedInstant) : null,
        decidedTime: decidedInstant ? timeInKualaLumpur(decidedInstant) : null,
        decidedByName: deciderName.get(h.id) ?? null,
        decisionNote: h.status === 'approved' || h.status === 'rejected' ? (h.decisionNote?.trim() || null) : null,
        reason: h.reason?.trim() || null,
        shiftEnd: l.shiftEnd ?? null,
        actualClockOut: l.actualClockOut ?? null,
        eligibleMinutes: l.eligibleMinutes ?? null,
        credit,
      };
    });
  });
}
