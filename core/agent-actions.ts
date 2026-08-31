/**
 * ADR-0083 §2.5 / §3 item 3 — THE ACTION LAYER. The first place in this system where an agent writes.
 *
 * Everything shipped before this round is read-only: the narrator explains, the assistant answers, the
 * tower counts, readiness lists. **Read-only AI makes people faster; it does not remove them.** This is
 * the seam through which work actually leaves a human's desk — and it is therefore the seam most worth
 * being paranoid about.
 *
 * ═══ THE SHAPE, AND WHY EACH PART IS NOT NEGOTIABLE ═══
 *
 *  1. **TYPED ACTIONS WITH PRECONDITIONS, NEVER A GENERAL WRITE.** An agent cannot "update a record"; it
 *     can propose one of a closed set of action types, each of which knows what must be true before it
 *     runs. A closed vocabulary is reviewable line by line. A general write capability is not reviewable
 *     at all, and no amount of prompt discipline makes it so.
 *  2. **THE PRECONDITION IS RE-CHECKED AT EXECUTION, INSIDE THE TRANSACTION.** The proposal is evidence
 *     that something was true when the page rendered. Between rendering and clicking, somebody may have
 *     changed the record. Trusting the proposal would make this layer a replay of stale facts.
 *  3. **AUTONOMY IS `propose_only`, AND THAT IS THE ONLY VALUE THE TYPE ADMITS.** Not a config flag
 *     defaulting to off — a union with one member, so granting autonomy is a deliberate change to this
 *     file that cannot happen by editing a setting. §2.5 requires autonomy be earned PER ACTION TYPE from
 *     measured agreement, and no agreement has been measured yet.
 *  4. **BLAST RADIUS IS A GATE, NOT A WARNING.** One approval may touch at most `blastRadiusCap`
 *     subjects. An agent that is wrong about one record is a correction; an agent that is wrong about
 *     four hundred is an incident.
 *  5. **EVERY EXECUTION IS A DOMAIN EVENT**, inherited free: this layer executes through the existing
 *     service (`resolveAnomalyVerdict`), so the audit trail, the RBAC check and the event are the ones
 *     that were already there. It does not open its own write path to the same table.
 *
 * ═══ WHAT §2.5 LISTS THAT IS DELIBERATELY ABSENT, AND WHY ═══
 *
 * A KILL SWITCH and a DAILY ACTION BUDGET. Both exist in §2.5 to bound an agent that acts on its own, and
 * nothing here acts on its own: every execution below is a human pressing a button, having read what will
 * happen. A kill switch for propose-only agents stops nothing that was not already stopped, and shipping
 * one would advertise a safety property that is really just the button. **They belong with the first
 * grant of autonomy — the same change that widens the union in (3) — and that is a decision, not a
 * build.** Recorded here rather than silently skipped so the next reader does not mistake their absence
 * for an oversight.
 *
 * ⚠️ NO ACTION IN THIS FILE TOUCHES MONEY, and none ever should. Resolving a verdict records a judgement
 * about a finding; it cannot change a payslip, a rate or a statutory figure. ADR-0074's invariant is
 * untouched: the money is the deterministic kernel's, and an agent may not reach it.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { resolveAnomalyVerdict } from './payroll-anomaly';
import { gapsForRecord, type ReadinessGapId } from './record-readiness';

/** Nothing acts on its own. See (3) in the header before widening this. */
export type AutonomyLevel = 'propose_only';

export type ActionReversibility =
  /** Undoable by an ordinary operator with an ordinary screen, leaving a trail of both states. */
  | 'reversible'
  /** Not undoable. NEVER auto-executes at any autonomy level, and today cannot exist here at all. */
  | 'irreversible';

export type AgentActionTypeId = 'close_fixed_upstream';

export type AgentActionType = {
  id: AgentActionTypeId;
  reversibility: ActionReversibility;
  /** Most subjects one approval may touch. See (4). */
  blastRadiusCap: number;
  autonomy: AutonomyLevel;
};

/**
 * THE ACTION CATALOGUE. One entry, and the first one is chosen for what it CANNOT do as much as for what
 * it can.
 *
 * `close_fixed_upstream` closes a payroll exception whose CAUSE has since been fixed — the verdict blocked
 * because somebody had no bank account, and that person now has one. It is the right first action because:
 *
 *   · the precondition is DETERMINISTIC and re-checkable — it is the same `gapsForRecord` predicate the
 *     readiness screen uses, so the agent cannot be right about this while the screen says otherwise;
 *   · the write is a JUDGEMENT STAMP on a verdict, not a change to anybody's data, and a re-evaluation
 *     supersedes it anyway;
 *   · it attacks ADR-0083 §2.4 directly — these are the recurring instances of an already-fixed cause,
 *     which is precisely the work the ADR says should never have reached a human twice;
 *   · and it produces the RESOLVED verdicts that `falsePositiveRate` and `mttrSeconds` need. Those metrics
 *     are structurally null today because nobody has ever dispositioned a flag.
 */
export const AGENT_ACTION_TYPES: readonly AgentActionType[] = [
  {
    id: 'close_fixed_upstream',
    // The resolution is a stamp with an author and a reason; an operator can re-open by re-evaluating the
    // run, and the verdict row keeps its history either way.
    reversibility: 'reversible',
    // Deliberately small for a first action. Raising it is a decision someone should have to make.
    blastRadiusCap: 50,
    autonomy: 'propose_only',
  },
];

export const actionTypeById = (id: string): AgentActionType | undefined =>
  AGENT_ACTION_TYPES.find((t) => t.id === id);

/**
 * Which readiness gap each re-checkable detector corresponds to.
 *
 * ONLY detectors whose cause is a RECORD FACT appear here, and that is the boundary of what this action
 * may ever close. `net-swing` is absent because "their pay moved 40%" is not a condition that stops being
 * true when somebody edits a field — closing it would be asserting a judgement the agent has not made.
 */
const CAUSE_OF: Partial<Record<string, ReadinessGapId>> = {
  'missing-bank-profile': 'no_bank_account',
  'missing-tax-profile': 'no_tax_number',
};

export type ProposedSubject = {
  verdictId: string;
  employmentId: string;
  name: string;
  detectorId: string;
  /** The gap that caused it, now absent from the record. Shown so the human can check the reasoning. */
  cause: ReadinessGapId;
};

export type ActionProposal = {
  type: AgentActionType;
  subjects: ProposedSubject[];
  /** True subject count; `subjects` may be capped for display. */
  count: number;
  /** True when `count` exceeds the type's cap, so the screen can say one approval will not clear it all. */
  overCap: boolean;
};

/** Display cap, distinct from the blast-radius cap: this one is about a readable page. */
const SHOW = 50;

/**
 * What the agent would propose, computed fresh.
 *
 * A PROPOSAL IS A QUERY, NOT A STORED ROW — the same decision r234 made for readiness and for the same
 * reason. A stored proposal is a claim about the past that needs its own invalidation story to stop
 * lying; a computed one cannot be stale, and the precondition is re-checked at execution anyway (2).
 */
export async function proposeActions(ctx: SessionContext): Promise<ActionProposal[]> {
  const type = AGENT_ACTION_TYPES[0]!;

  const subjects = await withTenant(ctx, async (tx) => {
    // Unresolved, live, flagged verdicts joined to the record as it is NOW.
    const rows = await tx
      .select({
        verdictId: schema.payrollAnomalyVerdict.id,
        employmentId: schema.payrollAnomalyVerdict.employmentId,
        detectorId: schema.payrollAnomalyFinding.detectorId,
        name: schema.person.fullName,
        paymentMethod: schema.employment.paymentMethod,
        ic: schema.employeeStatutoryMy.icNumber,
        passport: schema.employeeStatutoryMy.passportNumber,
        taxNumber: schema.employeeStatutoryMy.taxNumber,
        epfNumber: schema.employeeStatutoryMy.epfNumber,
        socsoNumber: schema.employeeStatutoryMy.socsoNumber,
        bankAccountNo: schema.employeeStatutoryMy.bankAccountNo,
      })
      .from(schema.payrollAnomalyVerdict)
      .innerJoin(
        schema.payrollAnomalyFinding,
        eq(schema.payrollAnomalyFinding.verdictId, schema.payrollAnomalyVerdict.id),
      )
      .innerJoin(schema.employment, eq(schema.employment.id, schema.payrollAnomalyVerdict.employmentId))
      .innerJoin(schema.person, eq(schema.person.id, schema.employment.personId))
      .leftJoin(
        schema.employeeStatutoryMy,
        eq(schema.employeeStatutoryMy.personId, schema.employment.personId),
      )
      .where(
        and(
          isNull(schema.payrollAnomalyVerdict.supersededAt),
          isNull(schema.payrollAnomalyVerdict.resolvedAt),
          inArray(schema.payrollAnomalyFinding.detectorId, Object.keys(CAUSE_OF)),
        ),
      );

    const out: ProposedSubject[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const cause = CAUSE_OF[r.detectorId];
      if (!cause) continue;
      // `hasComp: true` — compensation is irrelevant to these two causes and querying it here would add a
      // join for a value neither branch reads. Stated rather than left as a bare literal.
      const gaps = gapsForRecord({ ...r, hasComp: true });
      // STILL BROKEN ⇒ NOT A PROPOSAL. The whole claim is "the cause is gone".
      if (gaps.includes(cause)) continue;
      // One verdict may carry several findings; it is closed once.
      if (seen.has(r.verdictId)) continue;
      seen.add(r.verdictId);
      out.push({
        verdictId: r.verdictId,
        employmentId: r.employmentId,
        name: r.name,
        detectorId: r.detectorId,
        cause,
      });
    }
    return out;
  });

  if (subjects.length === 0) return [];
  return [
    {
      type,
      subjects: subjects.slice(0, SHOW),
      count: subjects.length,
      overCap: subjects.length > type.blastRadiusCap,
    },
  ];
}

export type ExecuteResult = {
  /** Verdicts actually closed. */
  closed: number;
  /**
   * Approved but NOT closed, for either reason: the cause had come back (2), or the verdict moved under
   * us — somebody resolved it by hand between the page rendering and the button being pressed, and the
   * service refused. Deliberately ONE number rather than two, because the operator's next move is the
   * same for both (look at the row again) and a second count would imply a distinction they cannot act
   * on. The screen's wording covers both cases; it must keep doing so if this is ever split.
   */
  stale: number;
};

export class AgentActionError extends Error {
  constructor(readonly code: 'unknown_type' | 'blast_radius' | 'nothing_to_do') {
    super(`agent-action:${code}`);
    this.name = 'AgentActionError';
  }
}

/**
 * Execute an approved proposal.
 *
 * ⚠️ THE VERDICT IDS ARE NOT TRUSTED. They arrive from a form and name rows in a scope-enforced table, so
 * every one is re-fetched, re-joined to the record as it is at THIS instant, and re-tested against the
 * same predicate before anything is written. A subject whose cause has come back is counted as `stale`
 * and skipped, not closed — the human approved "close the ones that are fixed", not "close these ids".
 */
export async function executeAction(
  ctx: SessionContext,
  p: { typeId: string; verdictIds: string[] },
): Promise<ExecuteResult> {
  const type = actionTypeById(p.typeId);
  if (!type) throw new AgentActionError('unknown_type');
  const ids = [...new Set(p.verdictIds.filter(Boolean))];
  if (ids.length === 0) throw new AgentActionError('nothing_to_do');
  // A GATE, NOT A WARNING (4). Refused outright rather than truncated: silently doing half of what was
  // approved is worse than refusing, because the operator believes the whole thing happened.
  if (ids.length > type.blastRadiusCap) throw new AgentActionError('blast_radius');

  const fresh = await proposeActions(ctx);
  const stillValid = new Set(
    (fresh[0]?.subjects ?? [])
      .concat()
      .map((s) => s.verdictId),
  );
  // `proposeActions` caps its display list, so anything beyond SHOW must be re-tested individually rather
  // than assumed stale. Re-running the predicate is cheap next to writing the wrong thing.
  const unknown = ids.filter((id) => !stillValid.has(id));
  if (unknown.length > 0) {
    const recheck = await withTenant(ctx, async (tx) => {
      const rows = await tx
        .select({
          verdictId: schema.payrollAnomalyVerdict.id,
          detectorId: schema.payrollAnomalyFinding.detectorId,
          paymentMethod: schema.employment.paymentMethod,
          ic: schema.employeeStatutoryMy.icNumber,
          passport: schema.employeeStatutoryMy.passportNumber,
          taxNumber: schema.employeeStatutoryMy.taxNumber,
          epfNumber: schema.employeeStatutoryMy.epfNumber,
          socsoNumber: schema.employeeStatutoryMy.socsoNumber,
          bankAccountNo: schema.employeeStatutoryMy.bankAccountNo,
        })
        .from(schema.payrollAnomalyVerdict)
        .innerJoin(
          schema.payrollAnomalyFinding,
          eq(schema.payrollAnomalyFinding.verdictId, schema.payrollAnomalyVerdict.id),
        )
        .innerJoin(schema.employment, eq(schema.employment.id, schema.payrollAnomalyVerdict.employmentId))
        .leftJoin(
          schema.employeeStatutoryMy,
          eq(schema.employeeStatutoryMy.personId, schema.employment.personId),
        )
        .where(
          and(
            inArray(schema.payrollAnomalyVerdict.id, unknown),
            isNull(schema.payrollAnomalyVerdict.supersededAt),
            isNull(schema.payrollAnomalyVerdict.resolvedAt),
          ),
        );
      const ok = new Set<string>();
      for (const r of rows) {
        const cause = CAUSE_OF[r.detectorId];
        if (cause && !gapsForRecord({ ...r, hasComp: true }).includes(cause)) ok.add(r.verdictId);
      }
      return ok;
    });
    for (const id of recheck) stillValid.add(id);
  }

  let closed = 0;
  for (const id of ids) {
    if (!stillValid.has(id)) continue;
    try {
      // Through the EXISTING service: its RBAC check, its status guard and its domain event are the ones
      // already trusted for a human doing this by hand. This layer does not open a second write path.
      await resolveAnomalyVerdict(ctx, {
        verdictId: id,
        resolution: 'fixed_upstream',
        note: 'Closed by the control plane: the record fact that caused this finding is no longer missing.',
      });
      closed++;
    } catch {
      // ONE REFUSAL MUST NOT DISCARD THE REST, and it must not report failure over work that COMMITTED.
      // Each call is its own transaction, so a throw escaping this loop would leave the earlier verdicts
      // closed while the operator is told the whole thing failed — the mirror of the truncation (4)
      // refuses, and just as misleading. The realistic cause is a race: somebody resolved this verdict by
      // hand while the page was open, and the service's status guard correctly refused. Not closed BY US
      // is the only fact this layer can assert, so it counts as stale and the numbers stay true.
    }
  }
  return { closed, stale: ids.length - closed };
}
