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
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import * as schema from '../db/schema';
import { resolveAnomalyVerdict } from './payroll-anomaly';
import { gapsForRecord, type ReadinessGapId } from './record-readiness';
import { recordProposal } from './agent-proposal';
import {isAdmin} from '../lib/authz-model';
import {assertModuleEnabled} from './entitlements';

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
  companyId:string;
  companyName:string;
  employeeCode:string|null;
  /** Opaque version binds verdict and current supported source facts, not a displayed bank/tax value. */
  version:string;
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
type FixedSource={verdictId:string;employmentId:string;companyId:string;name:string;personId:string;companyName:string;employeeCode:string|null;detectorId:string;computedVersion:string;paymentMethod:string|null;bankAccountNo:string|null;taxNumber:string|null};
export function fixedUpstreamCauses(detectors:readonly string[],facts:{paymentMethod:string|null;bankAccountNo:string|null;taxNumber:string|null}):ReadinessGapId[]|null{
 if(!detectors.length)return null;
 const gaps=gapsForRecord({...facts,hasComp:true,ic:null,passport:null,epfNumber:null,socsoNumber:null});
 const causes=detectors.map(id=>CAUSE_OF[id]);
 if(causes.some(cause=>!cause||gaps.includes(cause)))return null;
 return [...new Set(causes)] as ReadinessGapId[];
}
/** One canonical eligibility predicate for preview and locked execution. Closing a verdict requires
 * EVERY finding to be a supported, corrected record cause, never just one corrected finding. */
async function fixedSubjectsTx(tx:Tx,companyIds?:string[],ids?:string[]):Promise<ProposedSubject[]>{
 const rows:FixedSource[]=await tx.select({verdictId:schema.payrollAnomalyVerdict.id,employmentId:schema.employment.id,companyId:schema.employment.companyId,name:schema.person.fullName,personId:schema.person.id,companyName:schema.company.legalName,employeeCode:schema.employment.employeeCode,
  detectorId:schema.payrollAnomalyFinding.detectorId,computedVersion:sql<string>`${schema.payrollAnomalyVerdict.computedAt}::text`,paymentMethod:schema.employment.paymentMethod,
  bankAccountNo:schema.employeeStatutoryMy.bankAccountNo,taxNumber:schema.employeeStatutoryMy.taxNumber})
 .from(schema.payrollAnomalyVerdict).innerJoin(schema.payrollAnomalyFinding,eq(schema.payrollAnomalyFinding.verdictId,schema.payrollAnomalyVerdict.id))
 .innerJoin(schema.employment,eq(schema.employment.id,schema.payrollAnomalyVerdict.employmentId)).innerJoin(schema.person,eq(schema.person.id,schema.employment.personId)).innerJoin(schema.company,eq(schema.company.id,schema.employment.companyId))
 .leftJoin(schema.employeeStatutoryMy,eq(schema.employeeStatutoryMy.personId,schema.employment.personId))
 .where(and(isNull(schema.payrollAnomalyVerdict.supersededAt),isNull(schema.payrollAnomalyVerdict.resolvedAt),companyIds?inArray(schema.employment.companyId,companyIds):undefined,ids?inArray(schema.payrollAnomalyVerdict.id,ids):undefined))
 .orderBy(schema.employment.id,schema.payrollAnomalyVerdict.id,schema.payrollAnomalyFinding.id);
 const grouped=new Map<string,FixedSource[]>();for(const row of rows){const group=grouped.get(row.verdictId)??[];group.push(row);grouped.set(row.verdictId,group);}
 const out:ProposedSubject[]=[];
 for(const group of grouped.values()){
  const row=group[0]!,detectors=group.map(item=>item.detectorId).sort(),causes=fixedUpstreamCauses(detectors,row);if(!causes)continue;
  const version=createHash('sha256').update(JSON.stringify({verdictId:row.verdictId,employmentId:row.employmentId,companyId:row.companyId,computedVersion:row.computedVersion,personId:row.personId,detectors,paymentMethod:row.paymentMethod,bankAccountNo:row.bankAccountNo,taxNumber:row.taxNumber})).digest('hex');
  out.push({verdictId:row.verdictId,employmentId:row.employmentId,companyId:row.companyId,companyName:row.companyName,employeeCode:row.employeeCode,name:row.name,detectorId:detectors[0]!,cause:causes[0]!,version});
 }
 return out;
}
export function fixedUpstreamProposalDigest(subjects:readonly ProposedSubject[]){return createHash('sha256').update(JSON.stringify(subjects.map(subject=>({id:subject.verdictId,employmentId:subject.employmentId,companyId:subject.companyId,version:subject.version})).sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex');}
export async function proposeActions(ctx:SessionContext,options?:{companyIds?:string[]}):Promise<ActionProposal[]>{
 if(!isAdmin(ctx))throw new AgentActionError('not_authorized');
 assertModuleEnabled(ctx,'payroll');
 return withTenant(ctx,tx=>proposeActionsTx(tx,ctx,options));
}
export async function proposeActionsTx(tx:Tx,ctx:SessionContext,options?:{companyIds?:string[]}):Promise<ActionProposal[]>{
 if(!isAdmin(ctx))throw new AgentActionError('not_authorized');assertModuleEnabled(ctx,'payroll');
 const subjects=await fixedSubjectsTx(tx,options?.companyIds);if(!subjects.length)return [];
 return [{type:AGENT_ACTION_TYPES[0]!,subjects:subjects.slice(0,SHOW),count:subjects.length,overCap:subjects.length>AGENT_ACTION_TYPES[0]!.blastRadiusCap}];
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
  constructor(readonly code: 'unknown_type' | 'blast_radius' | 'nothing_to_do' | 'not_authorized' | 'stale_proposal') {
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
export async function executeAction(ctx:SessionContext,p:{typeId:string;verdictIds:string[]}):Promise<ExecuteResult>{
 return withTenant(ctx,tx=>executeActionTx(tx,ctx,p));
}
/** Explicit scoped Tx seam for the confirmed-conversation ledger; default callers use the same owner.
 * Locks: employment -> statutory rows -> verdict -> finding. No extra connection, model result or
 * client-supplied authorization is accepted. Unsupported causes are never closed. */
export async function executeActionTx(tx:Tx,ctx:SessionContext,p:{typeId:string;verdictIds:string[];companyIds?:string[];expectedDigest?:string}):Promise<ExecuteResult>{
 if(!isAdmin(ctx))throw new AgentActionError('not_authorized');assertModuleEnabled(ctx,'payroll');
 const type=actionTypeById(p.typeId);if(!type)throw new AgentActionError('unknown_type');
 const ids=[...new Set(p.verdictIds.filter(Boolean))].sort();if(!ids.length)throw new AgentActionError('nothing_to_do');if(ids.length>type.blastRadiusCap)throw new AgentActionError('blast_radius');
 const visible=await tx.select({id:schema.payrollAnomalyVerdict.id,employmentId:schema.payrollAnomalyVerdict.employmentId}).from(schema.payrollAnomalyVerdict).where(inArray(schema.payrollAnomalyVerdict.id,ids));
 const employeeIds=[...new Set(visible.map(row=>row.employmentId))].sort();
 const employees=employeeIds.length?await tx.select({id:schema.employment.id,personId:schema.employment.personId,companyId:schema.employment.companyId}).from(schema.employment).where(inArray(schema.employment.id,employeeIds)).orderBy(schema.employment.id).for('share'):[];
 const people=[...new Set(employees.map(row=>row.personId))].sort();
 if(people.length)await tx.select({id:schema.employeeStatutoryMy.id}).from(schema.employeeStatutoryMy).where(inArray(schema.employeeStatutoryMy.personId,people)).orderBy(schema.employeeStatutoryMy.id).for('share');
 await tx.select({id:schema.payrollAnomalyVerdict.id}).from(schema.payrollAnomalyVerdict).where(inArray(schema.payrollAnomalyVerdict.id,ids)).orderBy(schema.payrollAnomalyVerdict.id).for('update');
 await tx.select({id:schema.payrollAnomalyFinding.id}).from(schema.payrollAnomalyFinding).where(inArray(schema.payrollAnomalyFinding.verdictId,ids)).orderBy(schema.payrollAnomalyFinding.id).for('share');
 const subjects=await fixedSubjectsTx(tx,p.companyIds,ids),byId=new Map(subjects.map(subject=>[subject.verdictId,subject]));
 // A retargeted verdict or newly linked employment cannot use a source row that was never locked.
 if(subjects.some(subject=>!employees.some(employee=>employee.id===subject.employmentId&&employee.companyId===subject.companyId)))throw new AgentActionError('stale_proposal');
 if(p.expectedDigest&&(subjects.length!==ids.length||fixedUpstreamProposalDigest(subjects)!==p.expectedDigest))throw new AgentActionError('stale_proposal');
 let closed=0;
 for (const id of ids) {const subject=byId.get(id),valid=!!subject;
  await recordProposal(ctx,{type:'close_fixed_upstream',subject:{type:'payroll_anomaly_verdict',id},facts:{typeId:type.id,verdictId:id,causeAbsent:valid},proposal:{action:type.id,reversibility:type.reversibility,autonomy:type.autonomy},adjudication:valid?{ok:true}:{ok:false,reason:'precondition_no_longer_holds'},...(valid?{decision:'approved' as const}:{})},tx);
  if(!subject)continue;
  try {
   // A refused subject rolls back to its savepoint, never aborting or misreporting the rest.
   await tx.transaction(async subjectTx=>{await resolveAnomalyVerdict(ctx,{verdictId:id,resolution:'fixed_upstream',note:'Closed by the control plane: every supported record cause is now corrected.'},subjectTx);});
   closed++;
  } catch { /* Only actual successful resolutions contribute to the committed result. */ }
 }
 return { closed, stale: ids.length - closed };
}
