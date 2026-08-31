/**
 * ADR-0083 §3 item 2 — RECORD READINESS: the loop that feeds every other loop.
 *
 * ADR-0076's detectors run AFTER `generatePayslips`, which means a missing bank account is discovered at
 * the moment it blocks a payment — every cycle, for the same person, until somebody edits the record. The
 * ADR's argument is that this is the wrong moment and the wrong unit of work: **a fix is permanent, a
 * review recurs.** This is the shift-left half. Same questions, asked continuously against the RECORD, and
 * answered as a list of things to complete rather than a list of things to disposition.
 *
 * ⚠️ IT IS A QUERY, NOT A STORED VERDICT, AND THAT IS THE DESIGN. There is no readiness table, no sweep and
 * no migration. Readiness is a function of the records as they are RIGHT NOW, so a computed-and-stored
 * answer could only ever be wrong — stale the moment somebody fills a field in, and needing its own
 * invalidation story to stop lying. The payroll adapter persists verdicts because a verdict is a statement
 * about one RUN, which is immutable once made. A gap is a statement about a record, which is not.
 *
 * ⚠️ THE RULES MATCH THE PAYROLL DETECTORS ON PURPOSE, AND ONE OF THEM IS SUBTLE. `missing-bank-profile`
 * fires only when the employee is paid BY BANK (`payment_method` is bank_transfer or unset) — somebody paid
 * in cash needs no account. Readiness applies the same condition. Without it this screen would open on day
 * one accusing every cash-paid employee of an incomplete record, and a readiness list that cries wolf is
 * one nobody opens twice.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never writes, never proposes a value, and never contacts anybody.
 * ADR-0083's action layer (§2.5) is a separate build with its own security review; this is the read that
 * tells you what to fix. Naming the gap is the whole deliverable.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';

/**
 * What a gap STOPS. This is the field that makes the screen worth opening: "no bank account" is a data
 * complaint, "payment will fail for 14 people" is a consequence somebody acts on. Ordered by severity of
 * consequence, which is also the order the summary sorts in.
 */
export type ReadinessBlocks = 'payment' | 'payroll' | 'statutory_filing';

export type ReadinessGapId =
  /** No compensation record: the run cannot compute anything for them at all. */
  | 'no_compensation'
  /** Paid by bank with no account recorded — the exact condition `missing-bank-profile` blocks a run on. */
  | 'no_bank_account'
  /** No IC and no passport: they cannot appear on any statutory return. */
  | 'no_identity'
  /** No tax number: PCB has nowhere to be filed against. */
  | 'no_tax_number'
  /** No EPF number: the KWSP contribution file cannot name them. */
  | 'no_epf_number'
  /** No SOCSO number: the PERKESO file cannot name them. */
  | 'no_socso_number';

export const GAP_BLOCKS: Record<ReadinessGapId, ReadinessBlocks> = {
  no_compensation: 'payroll',
  no_bank_account: 'payment',
  no_identity: 'statutory_filing',
  no_tax_number: 'statutory_filing',
  no_epf_number: 'statutory_filing',
  no_socso_number: 'statutory_filing',
};

/** Consequence order — what stops a run first is what an operator should fix first. */
const BLOCK_RANK: Record<ReadinessBlocks, number> = { payroll: 0, payment: 1, statutory_filing: 2 };

export type ReadinessPerson = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  company: string;
};

export type ReadinessGap = {
  id: ReadinessGapId;
  blocks: ReadinessBlocks;
  count: number;
  /** Capped for the screen; `count` is the true total and is never capped. */
  people: ReadinessPerson[];
};

export type ReadinessView = {
  /** Active employments considered. A leaver's incomplete record is not an operational problem. */
  employees: number;
  /** Employments with no gap at all. */
  ready: number;
  gaps: ReadinessGap[];
};

/** How many names a gap carries to the screen. The count above it is always the real one. */
export const PEOPLE_PER_GAP = 25;

/**
 * Every active employment, and what is missing from each.
 *
 * ONE query, not one per check: this has to open for a 3,000-person tenant, and six round trips per
 * employee is how a readiness screen becomes the slowest page in the product. RLS scopes it to the
 * tenant; `scopedAdmin` on the screen decides who may open it.
 */
export async function recordReadiness(ctx: SessionContext): Promise<ReadinessView> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        employmentId: schema.employment.id,
        name: schema.person.fullName,
        employeeCode: schema.employment.employeeCode,
        company: schema.company.legalName,
        paymentMethod: schema.employment.paymentMethod,
        ic: schema.employeeStatutoryMy.icNumber,
        passport: schema.employeeStatutoryMy.passportNumber,
        taxNumber: schema.employeeStatutoryMy.taxNumber,
        epfNumber: schema.employeeStatutoryMy.epfNumber,
        socsoNumber: schema.employeeStatutoryMy.socsoNumber,
        bankAccountNo: schema.employeeStatutoryMy.bankAccountNo,
        // EXISTS rather than a join: an employment may carry many compensation rows over time and a join
        // would multiply every employee by their salary history before the gaps were even counted.
        hasComp: sql<boolean>`exists (
          select 1 from ${schema.compensation} c where c.employment_id = ${schema.employment.id}
        )`,
      })
      .from(schema.employment)
      .innerJoin(schema.person, eq(schema.person.id, schema.employment.personId))
      .innerJoin(schema.company, eq(schema.company.id, schema.employment.companyId))
      .leftJoin(
        schema.employeeStatutoryMy,
        eq(schema.employeeStatutoryMy.personId, schema.employment.personId),
      )
      // ACTIVE ONLY. A leaver with no SOCSO number is a historical record, not a thing to go and fix, and
      // listing them would bury the people whose next payslip actually depends on it.
      .where(isNull(schema.employment.terminatedOn));

    const blank = (v: string | null | undefined) => v == null || v.trim() === '';
    const buckets = new Map<ReadinessGapId, ReadinessPerson[]>();
    const add = (id: ReadinessGapId, p: ReadinessPerson) => {
      const list = buckets.get(id) ?? [];
      list.push(p);
      buckets.set(id, list);
    };

    let ready = 0;
    for (const r of rows) {
      const who: ReadinessPerson = {
        employmentId: r.employmentId,
        name: r.name,
        employeeCode: r.employeeCode,
        company: r.company,
      };
      let clean = true;
      const flag = (id: ReadinessGapId) => {
        clean = false;
        add(id, who);
      };

      if (!r.hasComp) flag('no_compensation');
      // The bank rule, matched to `missing-bank-profile`: unset counts as bank_transfer, and cash or
      // cheque needs no account. See the header on why this condition is load-bearing.
      if ((r.paymentMethod === 'bank_transfer' || r.paymentMethod == null) && blank(r.bankAccountNo)) {
        flag('no_bank_account');
      }
      // EITHER identity document satisfies it — r220 established that an old identity card counts as an
      // identity, and the same logic applies to a passport for a non-citizen. Demanding an IC would flag
      // every foreign worker for a record that is complete.
      if (blank(r.ic) && blank(r.passport)) flag('no_identity');
      if (blank(r.taxNumber)) flag('no_tax_number');
      if (blank(r.epfNumber)) flag('no_epf_number');
      if (blank(r.socsoNumber)) flag('no_socso_number');

      if (clean) ready++;
    }

    const gaps: ReadinessGap[] = [...buckets.entries()]
      .map(([id, people]) => ({
        id,
        blocks: GAP_BLOCKS[id],
        count: people.length,
        // Sorted before capping, so the names shown are stable between loads rather than whatever the
        // query happened to return first.
        people: [...people].sort((a, b) => a.name.localeCompare(b.name)).slice(0, PEOPLE_PER_GAP),
      }))
      // Worst consequence first, then biggest — "payroll cannot run for these 3" outranks "40 are missing
      // a SOCSO number", because one stops a cycle and the other stops a filing.
      .sort((a, b) => BLOCK_RANK[a.blocks] - BLOCK_RANK[b.blocks] || b.count - a.count);

    return { employees: rows.length, ready, gaps };
  });
}
