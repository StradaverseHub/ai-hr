/**
 * ADR-0085 step 2 — THE FILED-PERIOD PREDICATE. "Has anything been filed for this company-month?"
 *
 * ⚠️ NOTHING CALLS THIS YET, AND THAT IS THE CORRECT END STATE FOR THIS ROUND. ADR-0085's build order
 * puts the predicate before the clamps it will eventually decide (`deltaStat` in core/payroll.ts,
 * `clampDelta` in the MY multi-cycle module, and the worksheet's own clamp). Those three are steps 3
 * and 4, they are money-affecting, and they are UNCHANGED here. This file is a pure read: it computes
 * no figure, writes no row, appends no event and changes no payslip.
 *
 * ── WHAT COUNTS AS "FILED", AND WHY EITHER SIGNAL BARS ───────────────────────────────────────────────
 * Two different facts live in this database, and the temptation is to rank them:
 *
 *   `statutory_report`  a RETURN that a named operator recorded as lodged, carrying the agency's own
 *                       acknowledgement reference (`markReportFiled` in the reporting service makes
 *                       that reference mandatory and non-empty).
 *   `pcb_payment`       a PAYMENT: LHDN's receipt or transaction number for money the employer actually
 *                       remitted for that deduction month, keyed by a human after paying.
 *
 * NEITHER outranks the other, and the predicate is their UNION, because what both have in common is the
 * only property that matters here: **each is an assertion this company has already made to a third
 * party, and neither can be withdrawn by recomputing a number in this system.** An acknowledged return
 * means the agency now holds a figure. A receipt means the agency now holds MONEY against that month.
 * A silent negative increment after either one changes what an outside party was told, which is an
 * amendment to a statutory submission — the agency's own process, with its own timing, and explicitly
 * out of ADR-0085's scope (§6). So: either bars it. This agrees with the position put to me, but not by
 * inheritance — the argument above is why, and the argument is that both are EXTERNAL facts, not that
 * one is "money" and the other "paperwork".
 *
 * Three consequences of that reasoning, each of which had to be decided rather than assumed:
 *
 * 1. **A DRAFT RETURN IS NOT FILED.** `recordReport` writes every artefact as `draft`, and pressing
 *    "Record generation" on a PREVIEW must never bar anything. This is exactly the defect r292 fixed
 *    one layer up (the amber banner fired for previews and never for real filings); repeating it here
 *    would be repeating it on a money path. `STATUTORY_FILED_STATUSES` — owned by db/schema.ts, beside
 *    the column, so that no second hand-kept copy of "which statuses mean filed" can drift from the
 *    first — is what this resolves against, NOT a locally re-listed pair of strings.
 *
 * 2. **STATUS DECIDES; THE ACKNOWLEDGEMENT CORROBORATES.** ADR-0085 §3.2 phrases the rule as "a
 *    `statutory_report` with an `ack_ref`". Measured against the source, status and acknowledgement are
 *    set and cleared together in one transaction by the one service that may touch them, so today the
 *    two describe the same set of rows. Keying the predicate on `ack_ref` alone would nonetheless
 *    install a SECOND definition of "filed" beside the owned one, free to disagree with the banner the
 *    operator sees. So the filed statuses decide. The acknowledgement is then read back as EVIDENCE, so
 *    that step 4's refusal can name what was filed and when — which the ADR requires it to do.
 *
 *    The one place the two are OR-ed rather than equated is a defensive arm: a row carrying an
 *    acknowledgement reference under a status that does not account for it is unreachable through the
 *    service and would be a data anomaly. Read as "filed" it refuses a correction that may have been
 *    fine; read as "not filed" it permits a silent amendment to a lodged return. For a guard on money,
 *    the first mistake is the cheap one, so the anomaly counts as filed and says so in its evidence.
 *
 * 3. **PERIOD GRANULARITY, NOT PER-LEG.** A filed EPF form asserts EPF figures and a CP39 asserts PCB;
 *    strictly, an EPF filing has nothing to say about a PCB increment. Splitting the predicate that way
 *    would need a map from report type to the contribution legs it asserts, and no such map exists in
 *    this repo. Inventing one would be inventing the scope of somebody else's statutory form. ADR-0085
 *    §3.2 states the rule at the period, the clamps it will feed apply to all delta keys at once, and
 *    the coarse answer errs toward refusing — so period granularity it is. The per-leg refinement is a
 *    recorded UNKNOWN, not a thing this round quietly settled; the evidence rows carry the report type
 *    so a later round can narrow it without re-deriving anything.
 *
 * ── HOW A YEAR-KEYED RETURN COVERS A MONTH ───────────────────────────────────────────────────────────
 * `statutory_report.period_kind` may be `month`, `year` or `event`, and a year-keyed filed return over
 * this month MUST count. Measured, not assumed:
 *
 *   - Exactly ONE year-kind report exists in the MY catalogue today: Form E / CP8D, the annual LHDN
 *     return. Its generator loads the whole YEAR's rows for the company and reports per-employee annual
 *     gross, EPF, PCB and SOCSO plus the Form E headcounts. A filed Form E for 2026 therefore asserts a
 *     total that already contains every month of 2026 — so a negative increment in 2026-03 after that
 *     filing changes a figure inside a lodged annual return.
 *   - A year row's `period_key` is a bare `YYYY`: the statutory-forms export route validates
 *     `^\d{4}$` for a year-kind report and `^\d{4}-(0[1-9]|1[0-2])$` for every other.
 *
 * So the month `YYYY-MM` is covered by a filed row keyed `YYYY-MM` **or** keyed `YYYY`, and the query
 * matches on the PERIOD KEY rather than on `period_kind`. That is deliberate: `period_key` is what the
 * row is actually filed under and what the partial index on (company_id, period_key) is built over,
 * while `period_kind` is a descriptive label with no database constraint tying it to the key's shape.
 * Matching the key means a row whose two columns disagree still answers correctly.
 *
 * `pcb_payment` needs no such widening: its own table constraint pins `period_key` to `^\d{4}-(0[1-9]|
 * 1[0-2])$`, so a year-keyed payment row cannot exist and an exact month match is complete.
 *
 * UNKNOWN, recorded rather than guessed: `event` is a reachable value of `period_kind` that NO report
 * in the catalogue produces, so there is no event `period_key` shape to resolve against. An event row
 * whose key happens to be this month or this year is matched like any other; one keyed anything else is
 * not. When the first event-kind return ships, this predicate must be revisited — the companion test
 * fails the day one appears, so the decision cannot be skipped silently.
 *
 * ── "NOTHING AT ALL" IS AN ANSWER; "I CANNOT SEE" IS AN ERROR ────────────────────────────────────────
 * A company-month with nothing filed returns `{ filed: false, evidence: [] }`. That is a positive
 * answer and it must stay distinguishable from the two ways this question can fail to be answerable,
 * because BOTH failures otherwise return zero rows and read as "not filed" — a guard on money failing
 * open, silently:
 *
 *   - `statutory_report`'s row-level policy is `tenant_id = current tenant AND app.is_admin_for(
 *     company_id)`. A session without an admin grant over that company sees NO rows, however many are
 *     filed. So the predicate asks the database that same question first and throws if the answer is
 *     no. (Every payroll path and every sweep in this repo runs with an `hr_admin` grant, so this
 *     refuses nothing that legitimately computes payroll; it refuses a caller that could never have
 *     seen the truth.)
 *   - A company id belonging to another tenant. Note the ORDER of the two checks below: a group-wide
 *     grant carries a NULL company, so `app.is_admin_for` answers true for any uuid at all, including
 *     one from another tenant. It is the COMPANY read that is tenant-fenced, and it therefore goes
 *     first. `app.is_admin_for` is not a cross-tenant guard and is not used as one here.
 *
 * A malformed period throws for the same reason the payment table pins its key shape in the database:
 * `2026-3` would match no row and answer "not filed", which is a wrong answer wearing a right one's
 * clothes.
 *
 * ── WHY THIS FILE, AND NOT THE REPORTING SERVICE ─────────────────────────────────────────────────────
 * core/reporting.ts owns `statutory_report` and would be the natural home — but it imports core/payroll
 * .ts, and core/payroll.ts is where step 3's first consumer lives. Putting the predicate there would
 * make that import circular, which is the same reason `STATUTORY_FILED_STATUSES` lives in db/schema.ts
 * rather than in either service. This module imports only the database client and the schema.
 *
 * substrate: read-only. No write, no domain event, no migration.
 */
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { company, pcbPayment, statutoryReport, STATUTORY_FILED_STATUSES } from '../db/schema';

/** The two kinds of external assertion this predicate unions. */
export type FiledEvidenceKind = 'statutory-return' | 'pcb-payment';

/**
 * One reason the month reads as filed. Carried so the refusal ADR-0085 §3.2 asks for (step 4) can name
 * what was filed and when, instead of saying only that something was.
 */
export type FiledEvidence = {
  kind: FiledEvidenceKind;
  /** The report type for a return ('my.cp39', 'my.cp8d'); the payment stream for a payment ('mtd'). */
  what: string;
  /** The row's OWN period key — the month itself, or the year that contains it. */
  periodKey: string;
  /** How that key reaches the month asked about. */
  covers: 'month' | 'year';
  /** `filed_on` for a return, `paid_on` for a payment: the day the outside world was told. */
  on: string | null;
  /** `ack_ref` for a return, `receipt_ref` for a payment. The agency's own reference. */
  reference: string | null;
  /**
   * TRUE only on the defensive arm described in the header: a row carrying an acknowledgement under a
   * status that does not account for it. Never true for anything the reporting service wrote.
   */
  anomalous?: true;
};

/** The predicate's answer. `filed === false` with an empty `evidence` is "nothing has been filed". */
export type PeriodFiledAnswer = {
  filed: boolean;
  evidence: FiledEvidence[];
};

/**
 * Named refusal, mirroring `StatutoryFilingError` in the reporting service: a caller can branch on the
 * CODE rather than on a message string that would also match the wrong throw.
 *
 * `notVisible` / `notAdministered` are NOT "nothing is filed". They mean this session could not have
 * seen a filing if one existed, and a money guard must never read that as permission.
 */
export class PeriodFiledError extends Error {
  constructor(
    message: string,
    readonly code: 'invalidPeriod' | 'notVisible' | 'notAdministered',
  ) {
    super(message);
    this.name = 'PeriodFiledError';
  }
}

/** The month shape both tables key on; `pcb_payment` pins the same expression as a table constraint. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const nonEmpty = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

/**
 * Has anything been filed for this company and this month?
 *
 * Takes a transaction so that step 3 can ask the question inside the payroll transaction already open
 * around a delta, rather than opening a second one mid-computation. `periodFiled` below is the same
 * predicate for a caller holding a session instead.
 *
 * @param p.periodKey the pay period, 'YYYY-MM'.
 */
export async function periodFiledTx(
  tx: Tx,
  p: { companyId: string; periodKey: string },
): Promise<PeriodFiledAnswer> {
  if (!MONTH_RE.test(p.periodKey)) {
    throw new PeriodFiledError(`Not a month: ${p.periodKey}`, 'invalidPeriod');
  }
  const yearKey = p.periodKey.slice(0, 4);

  // ── Can this session see the answer at all? See the header: zero rows is otherwise indistinguishable
  // from nothing filed, and the tenant-fenced read has to come FIRST because app.is_admin_for is not.
  const [visible] = await tx
    .select({ id: company.id })
    .from(company)
    .where(eq(company.id, p.companyId))
    .limit(1);
  if (!visible) {
    throw new PeriodFiledError(
      'Cannot determine whether this period has been filed: the company is not visible to this session.',
      'notVisible',
    );
  }
  const admin = await tx.execute(sql`select app.is_admin_for(${p.companyId}::uuid) as ok`);
  if (!(admin as unknown as { ok: boolean }[])[0]?.ok) {
    throw new PeriodFiledError(
      'Cannot determine whether this period has been filed: this session does not administer the company, ' +
        'so filed returns for it are not readable.',
      'notAdministered',
    );
  }

  // ── Returns lodged with an agency. `inArray` over the two covering keys uses the partial index on
  // (company_id, period_key) that only ever holds filed rows.
  const returns = await tx
    .select({
      id: statutoryReport.id,
      reportType: statutoryReport.reportType,
      periodKey: statutoryReport.periodKey,
      status: statutoryReport.status,
      ackRef: statutoryReport.ackRef,
      filedOn: statutoryReport.filedOn,
    })
    .from(statutoryReport)
    .where(
      and(
        eq(statutoryReport.companyId, p.companyId),
        inArray(statutoryReport.periodKey, [p.periodKey, yearKey]),
        or(
          inArray(statutoryReport.status, [...STATUTORY_FILED_STATUSES]),
          sql`coalesce(btrim(${statutoryReport.ackRef}), '') <> ''`,
        ),
      ),
    )
    // Asserted array ⇒ ORDER BY. `filed_on` can be null only on the anomalous arm, so it sorts last.
    .orderBy(
      sql`${statutoryReport.filedOn} asc nulls last`,
      asc(statutoryReport.reportType),
      asc(statutoryReport.id),
    );

  // ── Money actually remitted. Exact month only: the table's own CHECK forbids a year-shaped key.
  const payments = await tx
    .select({
      id: pcbPayment.id,
      kind: pcbPayment.kind,
      periodKey: pcbPayment.periodKey,
      receiptRef: pcbPayment.receiptRef,
      paidOn: pcbPayment.paidOn,
    })
    .from(pcbPayment)
    .where(and(eq(pcbPayment.companyId, p.companyId), eq(pcbPayment.periodKey, p.periodKey)))
    .orderBy(asc(pcbPayment.paidOn), asc(pcbPayment.kind), asc(pcbPayment.id));

  const filedStatuses = STATUTORY_FILED_STATUSES as readonly string[];
  const evidence: FiledEvidence[] = [
    ...returns.map((r): FiledEvidence => {
      const item: FiledEvidence = {
        kind: 'statutory-return',
        what: r.reportType,
        periodKey: r.periodKey,
        covers: r.periodKey === p.periodKey ? 'month' : 'year',
        on: r.filedOn ?? null,
        reference: nonEmpty(r.ackRef),
      };
      if (!filedStatuses.includes(r.status)) item.anomalous = true;
      return item;
    }),
    ...payments.map(
      (m): FiledEvidence => ({
        kind: 'pcb-payment',
        what: m.kind,
        periodKey: m.periodKey,
        covers: 'month',
        on: m.paidOn,
        reference: nonEmpty(m.receiptRef),
      }),
    ),
  ];

  return { filed: evidence.length > 0, evidence };
}

/** `periodFiledTx` for a caller holding a session rather than an open transaction. */
export function periodFiled(
  ctx: SessionContext,
  p: { companyId: string; periodKey: string },
): Promise<PeriodFiledAnswer> {
  return withTenant(ctx, (tx) => periodFiledTx(tx, p));
}
