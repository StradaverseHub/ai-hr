/**
 * 3c88d593 — THE ONE-OFF BACKFILL that gives migration 0440's `assignment.company_id` its history.
 *
 *   node --import tsx scripts/backfill-assignment-company.ts
 *   node --import tsx scripts/backfill-assignment-company.ts --apply
 *
 * ⚠️ ON THE SERVER, SOURCE THE ENV — `node --env-file=` DOES NOT WORK THERE (node v18.19.1; the flag is
 * node 20+ and exits 9):
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && node --import tsx scripts/backfill-assignment-company.ts
 *
 * REPORT-ONLY BY DEFAULT, like every other repair script in this directory. Without --apply it prints the
 * full plan — every row it would stamp, every row it would split, and every employment it REFUSES — and
 * writes nothing.
 *
 * ⚠️ THIS IS NOT PART OF DEPLOY. `deploy.sh` runs migrations, not scripts. Migration 0440 adds a NULLABLE
 * column and the resolver reads NULL as "fall back to employment.company_id", so the release is correct
 * and byte-identical WITHOUT this script — it simply cannot split a transferred month until the history
 * exists. The round is not finished when deploy.sh returns.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT DOES
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * For each employment, in one transaction per employment:
 *
 *   1. REPLAY the entity timeline from the ledger. `employment.company.transferred` events carry BOTH
 *      company ids and an effective date, so the timeline is: the first transfer's `before`, then each
 *      transfer's `after` from its effective date. A transfer that was later rolled back is dropped (its
 *      `employment.company.transfer.reverted` names it in `reversalOf`). No transfers ⇒ one company for
 *      the whole of history: today's `employment.company_id`.
 *
 *   2. VERIFY the replay lands on today's `employment.company_id`. If it does not, the ledger and the
 *      column disagree about something this script did not model, and the employment is REFUSED BY NAME
 *      and left completely alone. Guessing at a legal entity is how you pay the wrong employer.
 *
 *   3. SPLIT any assignment version whose range STRADDLES a transfer date, at that date. The version keeps
 *      its id and its head; a new row carries the tail with every dimension copied. This is what makes the
 *      resolver able to answer "1–10 August under the old entity, 11–31 under the new".
 *
 *   4. STAMP `company_id` on every live version, from the replayed timeline, keyed on the version's own
 *      `valid_from`.
 *
 * SAFE TO RE-RUN. Step 3 finds no straddling version once the boundaries exist and step 4 writes values
 * that are already there (rows already holding the right value are not written at all). A second run
 * reports zero changes.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THE APPROVED PLAN GOT WRONG, MEASURED ON PRODUCTION 2026-08-13 (read-only)
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The plan says: "the movement effective date and the assignment split date can disagree: 100814's
 * assignment rows split at 2026-08-10 while the transfer's effective date is 2026-08-11 … the request says
 * the movement effective date is the source of truth, so use that and reconcile the assignment row rather
 * than the reverse."
 *
 * THE TWO DATES DO NOT DISAGREE ABOUT THE SAME EVENT, and reconciling them the way that sentence reads —
 * moving the 08-10 boundary to 08-11 — would DESTROY a different movement's effective date. The ledger
 * says so plainly:
 *
 *   seq 6886  employment.movement.applied  kind=promotion       effectiveDate 2026-08-10
 *   seq 7188  employment.company.transferred                    effectiveDate 2026-08-11
 *
 * The 2026-08-10 assignment boundary is the PROMOTION's (position + grade + basic, applied 2026-08-10 at
 * 03:00). The 11 August transfer wrote no boundary at all — its `changes` are `companyId` and `joinDate`
 * only, so `assignmentChanged` was false in core/movement.ts and the assignment leg never ran. That is the
 * root cause, restated exactly: the transfer moved a column and nothing else.
 *
 * So the correct action for 100814 is to SPLIT the open version (2026-08-10 → open) at 2026-08-11, leaving
 * the promotion's own boundary exactly where it is. Which is what this script does for every employment,
 * because it is the general rule and not a special case: a transfer date needs a boundary; an existing
 * boundary belonging to some other movement is none of a backfill's business.
 *
 * The plan is right about which date is AUTHORITATIVE — the movement's — and this script takes it from the
 * ledger for that reason. It is wrong that the assignment row needs reconciling to it.
 *
 * MEASURED SCALE (production, 2026-08-13): 40 employments, 54 live assignment rows, exactly ONE
 * `employment.company.transferred` event in the entire ledger and zero `employment.company.changed` /
 * `…transfer.reverted`. So this run stamps 54 rows, splits 1, and refuses none — and every one of those
 * numbers is printed before anything is written.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * THE ONE HAZARD, STATED RATHER THAN HIDDEN
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A split gives one movement's assignment version a second row that no `employment.assignment.changed`
 * event points at. Rolling that ORIGINAL movement back afterwards (reverseLegTx supersedes the row the
 * event names and reopens its predecessor) would leave the split tail behind, overlapping the reopened
 * predecessor. In production this is reachable only by rolling back employee 100814's 10 August promotion,
 * which has been applied, paid and is a month old — and a rollback of a paid movement is refused upstream.
 * Every split appends its own `assignment.entity-backfilled` event naming the parent row, so if it ever
 * happens the trail is there. Widening reverseLegTx to notice split tails is stage-two work and is
 * deliberately not smuggled in here.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { createDb } from '../db/client';
import { appendEvent } from '../db/events';
import { assignment, company, domainEvent, employment, employmentTypeEnum, person } from '../db/schema';

type EmploymentTypeValue = (typeof employmentTypeEnum.enumValues)[number];

type Row = {
  id: string;
  tenantId: string;
  employmentId: string;
  validFrom: string;
  validTo: string | null;
  companyId: string | null;
  departmentId: string;
  positionId: string | null;
  businessUnitId: string | null;
  costCenterId: string | null;
  locationId: string | null;
  employmentType: EmploymentTypeValue;
};

type Transfer = { eventId: string; effectiveDate: string; before: string | null; after: string | null };

type Plan = {
  employmentId: string;
  employeeCode: string | null;
  fullName: string;
  /** Effective-dated timeline: company from `from` onward. The first entry starts at the hire date. */
  timeline: { from: string; companyId: string }[];
  /** Rows to split, with the date to split them at. */
  splits: { row: Row; at: string }[];
  /** Rows to stamp: id → company. Rows already holding the value are excluded. */
  stamps: { row: Row; companyId: string }[];
  /** Set when the employment is left completely alone, with the reason. */
  refused: string | null;
};

export type BackfillReport = {
  apply: boolean;
  employments: number;
  liveRows: number;
  plans: Plan[];
  applied: { splits: number; stamps: number };
};

const NAMES = new Map<string, string>();
const nameOf = (id: string | null) => (id ? (NAMES.get(id) ?? id.slice(0, 8)) : '—');

/**
 * The company timeline for one employment, replayed from the ledger.
 *
 * Returns null when the replay does not land on `currentCompanyId` — the caller refuses rather than
 * guesses. `transfers` must already be in ledger (sequence) order.
 */
export function replayTimeline(
  transfers: Transfer[],
  currentCompanyId: string,
  hiredOn: string,
): { from: string; companyId: string }[] | null {
  if (transfers.length === 0) return [{ from: hiredOn, companyId: currentCompanyId }];
  const first = transfers[0];
  if (!first.before) return null; // a transfer with no `before` cannot anchor the start of the timeline
  const out: { from: string; companyId: string }[] = [{ from: hiredOn, companyId: first.before }];
  for (const t of transfers) {
    if (!t.after) return null;
    // A transfer dated on or before the hire has no earlier range to close; it simply moves the start.
    if (t.effectiveDate <= hiredOn) out[0] = { from: hiredOn, companyId: t.after };
    else out.push({ from: t.effectiveDate, companyId: t.after });
  }
  // Collapse adjacent entries naming the same company — a transfer that was applied and then re-applied
  // to the same destination is not two ranges.
  const merged: { from: string; companyId: string }[] = [];
  for (const e of out) {
    if (merged.length && merged[merged.length - 1].companyId === e.companyId) continue;
    merged.push(e);
  }
  if (merged[merged.length - 1].companyId !== currentCompanyId) return null;
  return merged;
}

/** The company in force on `date`, from a replayed timeline. */
export function companyAt(timeline: { from: string; companyId: string }[], date: string): string {
  let cur = timeline[0].companyId;
  for (const e of timeline) if (e.from <= date) cur = e.companyId;
  return cur;
}

/**
 * ⚠️ DOES NOT CLOSE THE CONNECTION — `createDb` memoises its pool per connection string (db/client.ts),
 * so an end() here would close the pool every other holder of the same URL is using. The CLI entry point
 * at the bottom owns the teardown, because it is the only caller that owns the process. Same reasoning,
 * verbatim, as scripts/repair-fixed-transaction-overlaps.ts.
 */
export async function runBackfill(url: string, opts: { apply: boolean }): Promise<BackfillReport> {
  const owner = createDb(url);

  for (const c of await owner.db.select({ id: company.id, name: company.legalName }).from(company)) {
    NAMES.set(c.id, c.name);
  }

  // Owner connection: RLS is bypassed on purpose — the backfill spans every tenant.
  const emps = await owner.db
    .select({
      id: employment.id,
      tenantId: employment.tenantId,
      companyId: employment.companyId,
      hiredOn: employment.hiredOn,
      employeeCode: employment.employeeCode,
      fullName: person.fullName,
    })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .orderBy(asc(employment.employeeCode));

  const rows = (await owner.db
    .select({
      id: assignment.id,
      tenantId: assignment.tenantId,
      employmentId: assignment.employmentId,
      validFrom: assignment.validFrom,
      validTo: assignment.validTo,
      companyId: assignment.companyId,
      departmentId: assignment.departmentId,
      positionId: assignment.positionId,
      businessUnitId: assignment.businessUnitId,
      costCenterId: assignment.costCenterId,
      locationId: assignment.locationId,
      employmentType: assignment.employmentType,
    })
    .from(assignment)
    .where(isNull(assignment.supersededAt))
    .orderBy(asc(assignment.employmentId), asc(assignment.validFrom))) as Row[];
  const rowsByEmp = new Map<string, Row[]>();
  for (const r of rows) rowsByEmp.set(r.employmentId, [...(rowsByEmp.get(r.employmentId) ?? []), r]);

  // The whole entity ledger, in sequence order, for every employment at once.
  const events = await owner.db
    .select({
      id: domainEvent.id,
      subjectEmploymentId: domainEvent.subjectEmploymentId,
      eventType: domainEvent.eventType,
      payload: domainEvent.payload,
    })
    .from(domainEvent)
    .orderBy(asc(domainEvent.sequence));
  const transfersByEmp = new Map<string, Transfer[]>();
  const reversedEventIds = new Set<string>();
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.eventType === 'employment.company.transfer.reverted' && typeof p.reversalOf === 'string') {
      reversedEventIds.add(p.reversalOf);
    }
  }
  for (const e of events) {
    if (e.eventType !== 'employment.company.transferred') continue;
    if (!e.subjectEmploymentId) continue;
    if (reversedEventIds.has(e.id)) continue; // rolled back — it never governed anything
    const p = (e.payload ?? {}) as Record<string, { companyId?: string } | string | undefined>;
    const before = (p.before as { companyId?: string } | undefined)?.companyId ?? null;
    const after = (p.after as { companyId?: string } | undefined)?.companyId ?? null;
    const effectiveDate = typeof p.effectiveDate === 'string' ? p.effectiveDate : '';
    if (!effectiveDate) continue;
    const list = transfersByEmp.get(e.subjectEmploymentId) ?? [];
    list.push({ eventId: e.id, effectiveDate, before, after });
    transfersByEmp.set(e.subjectEmploymentId, list);
  }

  const plans: Plan[] = [];
  for (const emp of emps) {
    const empRows = rowsByEmp.get(emp.id) ?? [];
    const base = {
      employmentId: emp.id,
      employeeCode: emp.employeeCode,
      fullName: emp.fullName,
      timeline: [] as { from: string; companyId: string }[],
      splits: [] as { row: Row; at: string }[],
      stamps: [] as { row: Row; companyId: string }[],
    };
    if (empRows.length === 0) {
      plans.push({ ...base, refused: 'no live assignment version' });
      continue;
    }
    const transfers = transfersByEmp.get(emp.id) ?? [];
    const timeline = replayTimeline(transfers, emp.companyId, emp.hiredOn);
    if (!timeline) {
      plans.push({
        ...base,
        refused: `the ledger replay does not land on the stored company (${nameOf(emp.companyId)}) — left untouched`,
      });
      continue;
    }

    // ── the splits: a version whose range STRADDLES a transfer date needs a boundary at that date ──
    const splits: { row: Row; at: string }[] = [];
    // Work on a mutable copy of the ranges so two transfers inside one version both land.
    const ranges = empRows.map((r) => ({ row: r, from: r.validFrom, to: r.validTo }));
    for (const entry of timeline.slice(1)) {
      const hit = ranges.find((r) => r.from < entry.from && (r.to === null || r.to > entry.from));
      if (!hit) continue; // a boundary already exists at this date (or the date is outside every range)
      splits.push({ row: hit.row, at: entry.from });
      ranges.push({ row: hit.row, from: entry.from, to: hit.to });
      hit.to = entry.from;
    }

    // ── the stamps: every live version, keyed on its own valid_from. A split tail is stamped by the
    //    split itself (it is inserted carrying its company), so only the pre-existing rows are listed.
    const stamps: { row: Row; companyId: string }[] = [];
    for (const r of empRows) {
      const want = companyAt(timeline, r.validFrom);
      if (r.companyId === want) continue; // already correct — a re-run writes nothing
      stamps.push({ row: r, companyId: want });
    }
    plans.push({ ...base, timeline, splits, stamps, refused: null });
  }

  const applied = { splits: 0, stamps: 0 };
  if (opts.apply) {
    for (const plan of plans) {
      if (plan.refused) continue;
      if (plan.splits.length === 0 && plan.stamps.length === 0) continue;
      await owner.db.transaction(async (tx) => {
        for (const s of plan.splits) {
          // The head keeps the row id, so every event that names it keeps naming the version it created.
          const closed = await tx
            .update(assignment)
            .set({ validTo: s.at })
            .where(and(eq(assignment.id, s.row.id), isNull(assignment.supersededAt), eq(assignment.validFrom, s.row.validFrom)))
            .returning({ id: assignment.id });
          if (closed.length !== 1) throw new Error(`row ${s.row.id} was not in the state the scan saw it in — aborting`);
          const [tail] = await tx
            .insert(assignment)
            .values({
              tenantId: s.row.tenantId,
              employmentId: s.row.employmentId,
              departmentId: s.row.departmentId,
              positionId: s.row.positionId,
              businessUnitId: s.row.businessUnitId,
              costCenterId: s.row.costCenterId,
              locationId: s.row.locationId,
              employmentType: s.row.employmentType,
              companyId: companyAt(plan.timeline, s.at),
              validFrom: s.at,
              validTo: s.row.validTo,
            })
            .returning({ id: assignment.id });
          await appendEvent(tx, {
            tenantId: s.row.tenantId,
            aggregateType: 'assignment',
            aggregateId: tail.id,
            // NOT `employment.assignment.changed`: that is a MOVEMENT_EVENT_TYPE and would project a
            // career-movement row for a data repair nobody performed. Its own type, off that allowlist.
            eventType: 'assignment.entity-backfilled',
            actor: { type: 'system' },
            subjectEmploymentId: s.row.employmentId,
            payload: {
              employmentId: s.row.employmentId,
              reason: 'entity-transfer boundary (3c88d593, migration 0440)',
              splitFromAssignmentId: s.row.id,
              at: s.at,
              companyId: companyAt(plan.timeline, s.at),
            },
          });
          applied.splits += 1;
        }
        for (const st of plan.stamps) {
          const done = await tx
            .update(assignment)
            .set({ companyId: st.companyId })
            .where(and(eq(assignment.id, st.row.id), isNull(assignment.supersededAt)))
            .returning({ id: assignment.id });
          if (done.length !== 1) throw new Error(`row ${st.row.id} vanished between scan and write — aborting`);
          applied.stamps += 1;
        }
        await appendEvent(tx, {
          tenantId: plan.stamps[0]?.row.tenantId ?? plan.splits[0]!.row.tenantId,
          aggregateType: 'employment',
          aggregateId: plan.employmentId,
          eventType: 'assignment.entity-backfilled',
          actor: { type: 'system' },
          subjectEmploymentId: plan.employmentId,
          payload: {
            employmentId: plan.employmentId,
            reason: '3c88d593 migration 0440 entity backfill',
            splits: plan.splits.length,
            stamps: plan.stamps.length,
            timeline: plan.timeline,
          },
        });
      });
    }
  }

  return { apply: opts.apply, employments: emps.length, liveRows: rows.length, plans, applied };
}

if (process.argv[1]?.endsWith('backfill-assignment-company.ts')) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('backfill-assignment-company requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  const closeAfter = async <T,>(r: T): Promise<T> => {
    await createDb(url).client.end();
    return r;
  };
  runBackfill(url, { apply: process.argv.includes('--apply') })
    .then(closeAfter)
    .then((r) => {
      console.log(`\n3c88d593 assignment entity backfill — mode=${r.apply ? 'APPLY' : 'REPORT ONLY'}`);
      console.log(`employments: ${r.employments}   live assignment versions: ${r.liveRows}\n`);

      const refused = r.plans.filter((p) => p.refused);
      const splitting = r.plans.filter((p) => p.splits.length > 0);
      const stamping = r.plans.filter((p) => p.stamps.length > 0);

      console.log(`SPLITS — ${splitting.reduce((n, p) => n + p.splits.length, 0)} version(s) straddle a transfer date.`);
      for (const p of splitting) {
        console.log(`  ${(p.employeeCode ?? p.fullName).padEnd(12)} ${p.fullName}`);
        for (const s of p.splits) {
          console.log(
            `      split ${s.row.validFrom}..${s.row.validTo ?? 'open'} at ${s.at}  ` +
              `→ ${s.row.validFrom}..${s.at} (${nameOf(companyAt(p.timeline, s.row.validFrom))}) + ` +
              `${s.at}..${s.row.validTo ?? 'open'} (${nameOf(companyAt(p.timeline, s.at))})`,
          );
        }
      }

      console.log(`\nSTAMPS — ${stamping.reduce((n, p) => n + p.stamps.length, 0)} version(s) to stamp.`);
      for (const p of stamping) {
        const tl = p.timeline.map((t) => `${t.from}→${nameOf(t.companyId)}`).join('  ');
        console.log(`  ${(p.employeeCode ?? p.fullName).padEnd(12)} ${p.fullName.padEnd(28)} ${tl}`);
      }

      if (refused.length > 0) {
        console.log(`\nREFUSED — ${refused.length} employment(s) left completely untouched:`);
        for (const p of refused) console.log(`  ${(p.employeeCode ?? p.fullName).padEnd(12)} ${p.refused}`);
      }

      console.log(
        r.apply
          ? `\nApplied: ${r.applied.splits} split(s), ${r.applied.stamps} stamp(s). No payslip was touched.`
          : `\nNothing written. Re-run with --apply. No payslip is touched either way — this changes what a FUTURE run computes.`,
      );
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
