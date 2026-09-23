/**
 * ADR-0085 step 2 — the filed-period predicate, pinned BOTH WAYS.
 *
 * The predicate's future job is to decide whether a statutory delta may carry a minus sign, so the two
 * ways of being wrong are not symmetrical in cost but they are symmetrical in how easily a test hides
 * them. Code that answered "filed" for everything would satisfy every happy-path assertion here; code
 * that answered "not filed" for everything would satisfy every refusal. So every arm below is written
 * with its opposite beside it:
 *
 *   - a filed return reads filed AND an untouched month still reads not-filed;
 *   - a DRAFT artefact for the month does NOT read filed (the arm that fails against the pre-r292
 *     "any artefact exists" shape, and the one that keeps a recorded PREVIEW from barring a correction);
 *   - a recorded PAYMENT reads filed with no return at all, AND a month with neither reads not-filed;
 *   - a YEAR-keyed filed return covers the months of ITS year AND does not reach the next year's;
 *   - reversing the filing mark takes the answer back to false, so the predicate tracks the LIVE claim
 *     rather than the fact that a claim was once made.
 *
 * And the third answer, which is neither: a session that could not have seen a filing THROWS. Zero rows
 * under RLS is otherwise indistinguishable from nothing filed, and this predicate is destined to gate
 * money — a guard that fails open silently is worse than no guard.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { markReportFiled, reverseReportFiling } from '../core/reporting';
import { recordPcbPayment } from '../core/pcb-payment';
import { PeriodFiledError, periodFiled } from '../core/statutory-filed';
import { MY_REPORTS } from '../localization/my/reports';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
let a: SessionContext;

const MONTH = '2026-03';

/**
 * THE ANNUAL ARM IS DERIVED FROM THE CLOCK, NOT WRITTEN DOWN. Form E for a year is lodged in the year
 * AFTER it, and `markReportFiled` refuses a filing date in the future — so a hardcoded pair would be
 * either permanently impossible or would quietly become so. The completed year before today's, filed
 * today, is the only pair that stays true whenever this suite runs (CLAUDE.md §8).
 */
const TODAY = todayInKualaLumpur();
const YEAR = String(Number(TODAY.slice(0, 4)) - 1);
const YEAR_BEFORE = String(Number(YEAR) - 1);
const YEAR_AFTER = TODAY.slice(0, 4);

/** An artefact exactly as `recordReport` leaves one: status 'draft', nothing filed. */
async function draftReport(p: {
  reportType?: string;
  periodKind?: string;
  periodKey?: string;
  companyId?: string;
} = {}) {
  const [row] = await owner.db
    .insert(schema.statutoryReport)
    .values({
      tenantId: base.tenantId,
      companyId: p.companyId ?? base.companyId,
      jurisdiction: 'MY',
      reportType: p.reportType ?? 'my.cp39',
      periodKind: p.periodKind ?? 'month',
      periodKey: p.periodKey ?? MONTH,
      status: 'draft',
      statutoryVersion: 'MY-2026.1',
      rowCount: 3,
      generatedBy: base.adminUserId,
    })
    .returning({ id: schema.statutoryReport.id });
  return row.id;
}

/** A second company under the SAME tenant — for the company-scoping arm. */
async function siblingCompany(): Promise<string> {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: base.tenantId, legalName: 'Acme Two Sdn Bhd' })
    .returning({ id: schema.company.id });
  return c.id;
}

/** A company under ANOTHER tenant — for the cross-tenant arm. */
async function foreignCompany(): Promise<string> {
  const [t] = await owner.db
    .insert(schema.tenant)
    .values({ workosOrgId: `org_${randomUUID()}`, name: 'Other Group' })
    .returning({ id: schema.tenant.id });
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: t.id, legalName: 'Other Sdn Bhd' })
    .returning({ id: schema.company.id });
  return c.id;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  a = adminCtx(base);
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0085 step 2 · a month reads FILED when something really was filed for it', () => {
  it('a lodged return makes the month filed, and names what was filed and when', async () => {
    const id = await draftReport({ reportType: 'my.cp39', periodKey: MONTH });
    await markReportFiled(a, { reportId: id, ackRef: 'LHDN-ACK-77123', filedOn: '2026-04-14' });

    const answer = await periodFiled(a, { companyId: base.companyId, periodKey: MONTH });
    expect(answer.filed).toBe(true);
    expect(answer.evidence).toHaveLength(1);
    expect(answer.evidence[0]).toMatchObject({
      kind: 'statutory-return',
      what: 'my.cp39',
      periodKey: MONTH,
      covers: 'month',
      on: '2026-04-14',
      reference: 'LHDN-ACK-77123',
    });
    expect(answer.evidence[0].anomalous).toBeUndefined();
  });

  /**
   * THE OTHER HALF OF THE SAME TEST, and the one that fails against code that simply says yes. The
   * month next door had the same amount of nothing done to it.
   */
  it('a month with nothing filed reads NOT filed, with no evidence at all', async () => {
    const id = await draftReport({ reportType: 'my.cp39', periodKey: MONTH });
    await markReportFiled(a, { reportId: id, ackRef: 'LHDN-ACK-77123', filedOn: '2026-04-14' });

    const answer = await periodFiled(a, { companyId: base.companyId, periodKey: '2026-04' });
    expect(answer.filed).toBe(false);
    expect(answer.evidence).toEqual([]);
  });

  /**
   * THE PREVIEW ARM. `recordReport` writes every artefact as 'draft', and until r292 the downstream
   * "already filed" derivation was `rows.length > 0` — so pressing Record generation on a preview
   * looked exactly like a lodged return. Repeating that here would let a recorded preview bar a
   * correction the month is still entitled to make.
   */
  it('a recorded DRAFT artefact does not make the month filed', async () => {
    await draftReport({ reportType: 'my.cp39', periodKey: MONTH });
    await draftReport({ reportType: 'my.borang-a', periodKey: MONTH });

    const answer = await periodFiled(a, { companyId: base.companyId, periodKey: MONTH });
    expect(answer.filed).toBe(false);
    expect(answer.evidence).toEqual([]);
  });

  /**
   * THE MONEY ARM, on its own. No return exists for this month at all — only LHDN's receipt for money
   * the employer actually remitted. Either signal bars; this proves the payment half is not decoration
   * on the return half.
   */
  it('a recorded PCB payment makes the month filed with no statutory return anywhere', async () => {
    await recordPcbPayment(a, {
      companyId: base.companyId,
      periodKey: MONTH,
      kind: 'mtd',
      receiptRef: 'LHDN-RCPT-9901',
      paidOn: '2026-04-11',
    });

    const answer = await periodFiled(a, { companyId: base.companyId, periodKey: MONTH });
    expect(answer.filed).toBe(true);
    expect(answer.evidence).toEqual([
      {
        kind: 'pcb-payment',
        what: 'mtd',
        periodKey: MONTH,
        covers: 'month',
        on: '2026-04-11',
        reference: 'LHDN-RCPT-9901',
      },
    ]);
    // The other stream that month was never paid, and the month before was never touched.
    const clean = await periodFiled(a, { companyId: base.companyId, periodKey: '2026-02' });
    expect(clean.filed).toBe(false);
  });

  /**
   * REVERSAL. A mis-keyed mark goes back to draft and the acknowledgement is cleared, so the month must
   * stop reading filed. Without this arm the predicate could be keyed on "was a filing event ever
   * appended", which is history rather than the live claim.
   */
  it('reversing the filing mark takes the month back to NOT filed', async () => {
    const id = await draftReport({ reportType: 'my.cp39', periodKey: MONTH });
    await markReportFiled(a, { reportId: id, ackRef: 'LHDN-ACK-77123', filedOn: '2026-04-14' });
    expect((await periodFiled(a, { companyId: base.companyId, periodKey: MONTH })).filed).toBe(true);

    await reverseReportFiling(a, { reportId: id, reason: 'keyed against the wrong month' });

    const answer = await periodFiled(a, { companyId: base.companyId, periodKey: MONTH });
    expect(answer.filed).toBe(false);
    expect(answer.evidence).toEqual([]);
  });
});

describe('ADR-0085 step 2 · a YEAR-keyed return covers the months inside its year', () => {
  /**
   * Form E / CP8D is the annual LHDN return and the only year-kind report in the catalogue. Its
   * generator reports each employee's WHOLE-YEAR gross, EPF, PCB and SOCSO, so a filed 2026 return
   * already asserts a total containing March 2026. A negative increment in that month afterwards edits
   * a figure inside a lodged return.
   */
  it('a filed annual return makes every month of its year read filed', async () => {
    const id = await draftReport({ reportType: 'my.cp8d', periodKind: 'year', periodKey: YEAR });
    await markReportFiled(a, { reportId: id, ackRef: 'LHDN-E-5512', filedOn: TODAY });

    for (const month of [`${YEAR}-01`, `${YEAR}-03`, `${YEAR}-12`]) {
      const answer = await periodFiled(a, { companyId: base.companyId, periodKey: month });
      expect(answer.filed, month).toBe(true);
      expect(answer.evidence[0]).toMatchObject({
        kind: 'statutory-return',
        what: 'my.cp8d',
        periodKey: YEAR,
        covers: 'year',
        reference: 'LHDN-E-5512',
      });
    }
  });

  it('and does not reach a month in any other year', async () => {
    const id = await draftReport({ reportType: 'my.cp8d', periodKind: 'year', periodKey: YEAR });
    await markReportFiled(a, { reportId: id, ackRef: 'LHDN-E-5512', filedOn: TODAY });

    for (const month of [`${YEAR_BEFORE}-12`, `${YEAR_AFTER}-03`]) {
      const answer = await periodFiled(a, { companyId: base.companyId, periodKey: month });
      expect(answer.filed, month).toBe(false);
      expect(answer.evidence, month).toEqual([]);
    }
  });

  /**
   * THE UNKNOWN THIS PREDICATE IS ALLOWED TO CARRY, PINNED SO IT CANNOT BE FORGOTTEN.
   *
   * `period_kind` may be 'event', and the predicate resolves coverage from the period KEY — a month key
   * or the year key that contains it. No report in the catalogue produces an event-kind row, so there
   * is no third key shape to resolve and none was invented. The day one ships, this fails and somebody
   * has to decide what period an event-keyed return covers before it can be registered.
   */
  it('no report in the catalogue is event-kind, so month and year are the whole vocabulary', () => {
    const events = MY_REPORTS.filter((r) => r.periodKind === 'event').map((r) => r.id);
    expect(events, 'an event-kind report needs core/statutory-filed.ts revisited first').toEqual([]);
    // And the only year-kind report is the annual LHDN return the arm above is written around.
    expect(MY_REPORTS.filter((r) => r.periodKind === 'year').map((r) => r.id)).toEqual(['my.cp8d']);
  });
});

describe('ADR-0085 step 2 · scope: whose filing, and can this session see it', () => {
  /**
   * COMPANY SCOPE IS THIS FILE'S OWN GUARD, not RLS. Both companies are inside the session's tenant and
   * the session is a group-wide admin, so `app.is_admin_for` is true for both and RLS lets both rows
   * through; it is the `company_id` equality in the query that keeps them apart. A filing is per legal
   * entity, and one company's lodged return says nothing about its sibling's month.
   */
  it('a sibling company in the same tenant does not make this company filed', async () => {
    const other = await siblingCompany();
    const id = await draftReport({ companyId: other, reportType: 'my.cp39', periodKey: MONTH });
    await markReportFiled(a, { reportId: id, ackRef: 'LHDN-ACK-OTHER', filedOn: '2026-04-14' });
    await recordPcbPayment(a, {
      companyId: other,
      periodKey: MONTH,
      kind: 'mtd',
      receiptRef: 'RCPT-OTHER',
      paidOn: '2026-04-11',
    });

    expect((await periodFiled(a, { companyId: other, periodKey: MONTH })).filed).toBe(true);
    const mine = await periodFiled(a, { companyId: base.companyId, periodKey: MONTH });
    expect(mine.filed).toBe(false);
    expect(mine.evidence).toEqual([]);
  });

  /**
   * CROSS-TENANT IS RLS, NOT THIS FILE (CLAUDE.md §8 — know which one a green refusal is pinning). The
   * company policy's USING clause is `tenant_id = app.current_tenant_id()`, so the company row is
   * invisible and the predicate refuses rather than reporting an empty month.
   *
   * `app.is_admin_for` is deliberately NOT what fences this: a group-wide grant carries a null company
   * and answers true for any uuid at all, including this one. The tenant-fenced company read is why the
   * answer is a refusal, and it is why it runs first.
   */
  it('another tenant`s company refuses rather than reading as an unfiled month', async () => {
    const foreign = await foreignCompany();
    await expect(periodFiled(a, { companyId: foreign, periodKey: MONTH })).rejects.toMatchObject({
      name: 'PeriodFiledError',
      code: 'notVisible',
    });
  });

  /**
   * THE FAIL-OPEN ARM, and the reason the predicate refuses instead of answering.
   *
   * `statutory_report`'s policy is `tenant_id = current tenant AND app.is_admin_for(company_id)`. A
   * non-admin session reads ZERO filed returns however many exist — so without this check the month
   * would read "not filed" to exactly the caller least entitled to that answer.
   */
  it('a session that does not administer the company refuses instead of answering not-filed', async () => {
    const id = await draftReport({ reportType: 'my.cp39', periodKey: MONTH });
    await markReportFiled(a, { reportId: id, ackRef: 'LHDN-ACK-77123', filedOn: '2026-04-14' });

    const employee: SessionContext = { ...a, roles: ['employee'] };
    await expect(periodFiled(employee, { companyId: base.companyId, periodKey: MONTH })).rejects.toMatchObject({
      name: 'PeriodFiledError',
      code: 'notAdministered',
    });
    // Proof the refusal is about AUTHORITY and not about the data: the same question, same month, from
    // an administering session, answers filed.
    expect((await periodFiled(a, { companyId: base.companyId, periodKey: MONTH })).filed).toBe(true);
  });

  it('a malformed period refuses: a key that can match nothing must not read as nothing filed', async () => {
    for (const bad of ['2026-3', '2026', '2026-13', 'March 2026', '']) {
      await expect(
        periodFiled(a, { companyId: base.companyId, periodKey: bad }),
        bad,
      ).rejects.toMatchObject({ name: 'PeriodFiledError', code: 'invalidPeriod' });
    }
  });
});

describe('ADR-0085 step 2 · the evidence is what step 4 will read out', () => {
  /**
   * A row carrying an acknowledgement under a status that does not account for it is unreachable
   * through the reporting service — the two columns are set and cleared together, in one transaction,
   * by the only writer. If it ever existed it would be a data anomaly, and a guard on money reads an
   * anomaly the safe way round: filed, and flagged as such rather than quietly counted.
   */
  it('an acknowledgement under a non-filed status counts as filed and says it is anomalous', async () => {
    const id = await draftReport({ reportType: 'my.cp39', periodKey: MONTH });
    await owner.db
      .update(schema.statutoryReport)
      .set({ ackRef: 'LHDN-ACK-ORPHAN' })
      .where(eq(schema.statutoryReport.id, id));

    const answer = await periodFiled(a, { companyId: base.companyId, periodKey: MONTH });
    expect(answer.filed).toBe(true);
    expect(answer.evidence[0]).toMatchObject({
      kind: 'statutory-return',
      what: 'my.cp39',
      reference: 'LHDN-ACK-ORPHAN',
      on: null,
      anomalous: true,
    });
  });

  /** Asserted array ⇒ deterministic order. Returns first, oldest filing first; then payments by date. */
  it('orders returns by filing date and then lists payments', async () => {
    const later = await draftReport({ reportType: 'my.socso-eis', periodKey: MONTH });
    await markReportFiled(a, { reportId: later, ackRef: 'PERKESO-2', filedOn: '2026-04-20' });
    const earlier = await draftReport({ reportType: 'my.cp39', periodKey: MONTH });
    await markReportFiled(a, { reportId: earlier, ackRef: 'LHDN-1', filedOn: '2026-04-10' });
    await recordPcbPayment(a, {
      companyId: base.companyId,
      periodKey: MONTH,
      kind: 'mtd',
      receiptRef: 'RCPT-1',
      paidOn: '2026-04-11',
    });

    const answer = await periodFiled(a, { companyId: base.companyId, periodKey: MONTH });
    expect(answer.evidence.map((e) => [e.kind, e.what, e.on])).toEqual([
      ['statutory-return', 'my.cp39', '2026-04-10'],
      ['statutory-return', 'my.socso-eis', '2026-04-20'],
      ['pcb-payment', 'mtd', '2026-04-11'],
    ]);
  });
});
