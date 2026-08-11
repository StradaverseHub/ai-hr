/**
 * 2aed39d4 — THE ONE-OFF REPAIR that has to run before migration 0426 can be applied.
 *
 *   node --env-file=.env.production --import tsx scripts/repair-fixed-transaction-overlaps.ts
 *   node --env-file=.env.production --import tsx scripts/repair-fixed-transaction-overlaps.ts --apply
 *   node --env-file=.env.production --import tsx scripts/repair-fixed-transaction-overlaps.ts --apply --tag 2aed39d4-2026-08-11
 *
 * REPORT-ONLY BY DEFAULT, like scripts/reset-medical-hospitalization-ledger.ts and
 * scripts/correct-hrdf-opt-outs.ts. Without --apply it prints every row it would supersede, with the row
 * it is being superseded IN FAVOUR OF, and writes nothing.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY IT MUST RUN FIRST, AND WHAT HAPPENS IF IT DOES NOT
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Migration 0426 adds `employment_pay_component_no_overlap`, an EXCLUDE USING gist over
 * (employment_id, component_id, daterange(valid_from, coalesce(valid_to, '9999-12-31'), '[]')) WHERE
 * superseded_at IS NULL. Applied to today's production data it fails TWICE OVER, and only one of the two
 * failures looks like a constraint violation:
 *
 *   1. THE INVERTED ROW ABORTS THE ALTER OUTRIGHT. One live row has valid_to BEFORE valid_from
 *      (EMP-0001 ALLOWANCE 200.00, 2026-01-31 -> 2026-01-06, written 2026-06-29, before the 34cc8137
 *      guard existed). `daterange()` raises `range lower bound must be less than or equal to range upper
 *      bound` while merely BUILDING the index entry — the exclusion operator is never reached. Reproduced
 *      locally against PostgreSQL 16.14. It is cleared FIRST, in its own pass, for that reason.
 *
 *   2. THE OVERLAPPING PAIRS raise `conflicting key value violates exclusion constraint`.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT DOES, AND THE THREE THINGS IT DELIBERATELY DOES NOT DO
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT: within each (employment, pay item) group it walks the live rows NEWEST-WRITTEN FIRST and keeps a
 * row only if it does not overlap one already kept. Everything else is superseded (`superseded_at =
 * now()`), one row at a time, each with its own DomainEvent. Newest-written wins because that is the
 * operator's most recent intent — the plan's words are "keeping the most recent line of each group and
 * moving the rest into history".
 *
 * NOT #1 — NO BLANKET UPDATE. Every write is `WHERE id = $1`, driven off the scan, and the row's own
 * before-state is printed. A `UPDATE ... WHERE <overlap predicate>` would be shorter and would also make
 * it impossible to say afterwards which rows moved and why.
 *
 * NOT #2 — PAYSLIPS ARE NOT TOUCHED. This changes what a FUTURE run pays. It does not amend a single
 * issued payslip, and it does not reverse one. In particular: X000001's July payslip paid HANDPHONE
 * ALLOWANCE 100.00, and the row this repair KEEPS is the 150.00 written at 16:06 on 2026-08-10. Those
 * two figures do not match, on purpose. That is stated in the approved plan and is the intended outcome,
 * not a defect — the alternative (keeping the row that happens to agree with an already-issued slip)
 * would silently discard the operator's most recent correction.
 *
 * NOT #3 — NO TRUNCATION. An older row that overlaps is superseded whole, not shortened to end the day
 * before the keeper starts. Truncation would invent an end date nobody chose, and for a row like
 * EMP-0001 BASIC it would manufacture a compensation history that never existed. Superseded rows stay in
 * the table and stay auditable; they are simply no longer live.
 *
 * SAFE TO RE-RUN. A superseded row is no longer a candidate, so a second run reports zero.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { appendEvent } from '../db/events';
import { employment, employmentPayComponent, payComponent, person } from '../db/schema';

type LiveRow = {
  id: string;
  tenantId: string;
  employmentId: string;
  componentId: string;
  amount: string;
  validFrom: string;
  validTo: string | null;
  runType: string | null;
  createdAt: Date;
  code: string;
  employeeCode: string | null;
  fullName: string;
};

type Action = {
  row: LiveRow;
  /** Why it is being cleared: an inverted window, or an overlap with `keeper`. */
  reason: 'inverted' | 'overlap';
  keeper: LiveRow | null;
};

export type RepairReport = {
  apply: boolean;
  tag: string;
  liveRows: number;
  inverted: Action[];
  overlaps: Action[];
  /** Groups still holding an overlap AFTER the plan is applied — must be empty or 0426 will fail. */
  residual: string[];
};

const iso = (d: string | null) => d ?? 'open';
/** Inclusive-inclusive overlap — the same boundary the kernel pays on and 0426 indexes. */
const touches = (a: LiveRow, b: LiveRow) =>
  a.validFrom <= (b.validTo ?? '9999-12-31') && b.validFrom <= (a.validTo ?? '9999-12-31');
const inverted = (r: LiveRow) => r.validTo != null && r.validTo < r.validFrom;
const label = (r: LiveRow) =>
  `${(r.employeeCode ?? r.fullName ?? '?').padEnd(10)} ${r.code.padEnd(12)} ${r.amount.padStart(10)} ` +
  `${r.validFrom}..${iso(r.validTo).padEnd(10)} cycle=${(r.runType ?? '-').padEnd(10)} ` +
  `written ${r.createdAt.toISOString()} id=${r.id}`;

export async function runRepair(url: string, opts: { apply: boolean; tag?: string }): Promise<RepairReport> {
  const owner = createDb(url);
  const tag = opts.tag ?? `2aed39d4-${new Date().toISOString().slice(0, 10)}`;
  try {
    // Owner connection: RLS is bypassed on purpose, because the repair spans every tenant. The scan and
    // the writes read the SAME snapshot ordering (created_at, then id) so a re-run is deterministic.
    const rows: LiveRow[] = await owner.db
      .select({
        id: employmentPayComponent.id,
        tenantId: employmentPayComponent.tenantId,
        employmentId: employmentPayComponent.employmentId,
        componentId: employmentPayComponent.componentId,
        amount: employmentPayComponent.amount,
        validFrom: employmentPayComponent.validFrom,
        validTo: employmentPayComponent.validTo,
        runType: employmentPayComponent.runType,
        createdAt: employmentPayComponent.createdAt,
        code: payComponent.code,
        employeeCode: employment.employeeCode,
        fullName: person.fullName,
      })
      .from(employmentPayComponent)
      .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
      .innerJoin(employment, eq(employment.id, employmentPayComponent.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(isNull(employmentPayComponent.supersededAt))
      .orderBy(desc(employmentPayComponent.createdAt), asc(employmentPayComponent.id));

    // ── PASS 1: the inverted rows. Cleared first and separately — see the header. ──
    const invertedActions: Action[] = rows.filter(inverted).map((row) => ({ row, reason: 'inverted' as const, keeper: null }));
    const invertedIds = new Set(invertedActions.map((a) => a.row.id));

    // ── PASS 2: overlaps, per (employment, pay item), newest-written first. ──
    const groups = new Map<string, LiveRow[]>();
    for (const r of rows) {
      if (invertedIds.has(r.id)) continue; // already being cleared; never used as a keeper
      const key = `${r.employmentId}|${r.componentId}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
    }
    const overlapActions: Action[] = [];
    const kept: LiveRow[] = [];
    for (const group of groups.values()) {
      const keepers: LiveRow[] = [];
      for (const r of group) {
        // `group` is already newest-first (the scan's ORDER BY carries through).
        const clash = keepers.find((k) => touches(k, r));
        if (clash) overlapActions.push({ row: r, reason: 'overlap', keeper: clash });
        else keepers.push(r);
      }
      kept.push(...keepers);
    }

    // ── VERIFY THE PLAN BEFORE OFFERING IT. Nothing kept may overlap anything else kept. ──
    const residual: string[] = [];
    for (let i = 0; i < kept.length; i += 1) {
      for (let j = i + 1; j < kept.length; j += 1) {
        const a = kept[i];
        const b = kept[j];
        if (a.employmentId === b.employmentId && a.componentId === b.componentId && touches(a, b)) {
          residual.push(`${a.employeeCode ?? a.fullName} ${a.code}: ${a.id} still overlaps ${b.id}`);
        }
      }
    }

    if (opts.apply && residual.length === 0) {
      for (const a of [...invertedActions, ...overlapActions]) {
        // ONE ROW, BY ID, IN ITS OWN TRANSACTION WITH ITS OWN EVENT. Never a predicate UPDATE.
        await owner.db.transaction(async (tx) => {
          const done = await tx
            .update(employmentPayComponent)
            .set({ supersededAt: sql`now()` })
            .where(and(eq(employmentPayComponent.id, a.row.id), isNull(employmentPayComponent.supersededAt)))
            .returning({ id: employmentPayComponent.id });
          if (done.length !== 1) throw new Error(`row ${a.row.id} was not in the state the scan saw it in — aborting`);
          await appendEvent(tx, {
            tenantId: a.row.tenantId,
            aggregateType: 'employment-pay-component',
            aggregateId: a.row.id,
            eventType: 'employment-pay-component.archived',
            actor: { type: 'system' },
            subjectEmploymentId: a.row.employmentId,
            // ADR-0030 Layer 0: dates/codes/ids are references, never the amount.
            payload: {
              employmentId: a.row.employmentId,
              componentId: a.row.componentId,
              validFrom: a.row.validFrom,
              validTo: a.row.validTo,
              reason: a.reason,
              supersededInFavourOf: a.keeper?.id ?? null,
              repairTag: tag,
            },
          });
        });
      }
    }

    return { apply: opts.apply, tag, liveRows: rows.length, inverted: invertedActions, overlaps: overlapActions, residual };
  } finally {
    await owner.client.end();
  }
}

const argOf = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

if (process.argv[1]?.endsWith('repair-fixed-transaction-overlaps.ts')) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('repair-fixed-transaction-overlaps requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  runRepair(url, { apply: process.argv.includes('--apply'), tag: argOf('--tag') ?? undefined })
    .then((r) => {
      console.log(`\n2aed39d4 fixed-transaction overlap repair — mode=${r.apply ? 'APPLY' : 'REPORT ONLY'}, tag '${r.tag}'`);
      console.log(`live employment_pay_component rows: ${r.liveRows}\n`);

      console.log(`INVERTED windows (valid_to < valid_from) — ${r.inverted.length}. These abort the 0426 ALTER outright.`);
      for (const a of r.inverted) console.log(`  clear  ${label(a.row)}`);

      console.log(`\nOVERLAPPING rows — ${r.overlaps.length} to clear.`);
      for (const a of r.overlaps) {
        console.log(`  clear  ${label(a.row)}`);
        console.log(`    keep ${label(a.keeper!)}`);
      }

      if (r.residual.length > 0) {
        console.error(`\n✗ REFUSED: ${r.residual.length} overlap(s) would remain after this plan. Nothing was written.`);
        for (const m of r.residual) console.error(`    ${m}`);
        process.exit(1);
      }
      const total = r.inverted.length + r.overlaps.length;
      console.log(
        `\n${r.apply ? 'Cleared' : 'Would clear'} ${total} row(s). Payslips are not touched.` +
          (r.apply ? ' Migration 0426 can now be applied.' : ' Re-run with --apply to write.'),
      );
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
