/** AI v2 Phase 2 P2-1 — the autonomy ladder: what each loop may become, and what earns it (no database, no React).
 *
 * Levels per loop per company: 0 Watch, 1 Prepare, 2 Act within limits, 3 Act and audit.
 *  - The cap is code. A loop that touches pay, employment status, system access, discipline or statutory filing stays
 *    at Prepare in every company, whatever its declaration or configuration says: maxLevel() computes the ceiling from
 *    the categories, never from a stored value, and the declarations are frozen at load. Migration 0963 repeats the
 *    cap in the database (teras_loop_level_cap), so a direct write cannot raise it either.
 *  - Of the five Phase 1 loops only missed clock-outs and missing employee data may stand above Prepare. Probation
 *    (employment status), payroll inputs (pay) and passports (owner decision) stay at Prepare, and so do the Phase 2
 *    Salary payroll loop (pay) and the payroll Audit loop (pay and statutory filing; not a LoopId, capped in 0963).
 *  - A loop moves above Prepare only if it has an automatic step built in code (`actor`): missed clock-outs sets the
 *    clock-out to the roster end through the attendance owner (core/loops/act-clock-outs.ts); missing employee data sends
 *    the request to the employee itself and changes no record (core/loops/act-requests.ts).
 *  - Level 3 (Act and audit) acts exactly as Level 2; instead of every action showing in HR's feed, HR reviews a weekly
 *    sample of at least 10% and at least 5 actions (core/loops/samples.ts). The employee is still told; undo and
 *    demotion are unchanged.
 *  - Promotion is by certificate: each loop declares its criteria, computed from its own case and run records and its
 *    action ledger (core/loops/levels.ts promotionEvidenceTx). Level 3 needs 90 days at Level 2.
 *  - Demotion is fixed: more than 1% of the automatic actions changed or undone by people over 7 days drops the loop
 *    back to Prepare for that company. Telling the person is always on. Neither is configurable. */
import type {LoopId} from './types';
import {LOOP_IDS} from './types';
import {ACT_CONDITIONS,MAX_ACTIONS_PER_NIGHT,UNDO_WINDOW_DAYS,type AutonomyLevel,type LoopLimits} from './autonomy-types';

/** The categories a loop may never act on by itself. */
export const CAPPED_CATEGORIES=Object.freeze(['pay','employment_status','access','discipline','statutory_filing'] as const);
export type CappedCategory=(typeof CAPPED_CATEGORIES)[number];

export type CriterionId='prepared'|'changed'|'rule_broken'|'days_at_level';
export type AutonomyDeclaration=Readonly<{
 /** What the loop's work touches. Any capped category caps it at Prepare. */
 categories:readonly string[];
 /** The highest level the owner allows for it; never above what its categories allow. */
 ceiling:AutonomyLevel;
 /** Whether an automatic step is built for it (the action it takes above Prepare). */
 actor:boolean;
 /** What its promotion certificate checks. */
 criteria:readonly CriterionId[];
}>;

/** The fixed rules. Not configurable per company or tenant. */
export const PROMOTION_RULES=Object.freeze({minPrepared:200,maxChangedShare:0.01,windowDays:30,daysAtLevel:Object.freeze({2:30,3:90}) as Readonly<Record<2|3,number>>});
export const DEMOTION_RULE=Object.freeze({maxCorrectedShare:0.01,windowDays:7});

const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

const DECLARATIONS:Record<LoopId,AutonomyDeclaration>={
 loop_probation_ending:{categories:['employment_status'],ceiling:1,actor:false,criteria:['prepared','rule_broken','days_at_level']},
 loop_payroll_inputs:{categories:['pay'],ceiling:1,actor:false,criteria:['prepared','rule_broken','days_at_level']},
 // The request to the employee would be sent automatically, never the change itself (owner, 3 November 2026).
 loop_missing_employee_data:{categories:['employee_record_request'],ceiling:3,actor:true,criteria:['prepared','rule_broken','days_at_level']},
 loop_missed_clock_outs:{categories:['attendance'],ceiling:3,actor:true,criteria:['prepared','changed','rule_broken','days_at_level']},
 // Passports stay at Prepare (owner, 3 November 2026).
 loop_document_expiry:{categories:['identity_document'],ceiling:1,actor:false,criteria:['prepared','rule_broken','days_at_level']},
 // AI v2 P2-2a: the Salary payroll loop is pay; it stays at Prepare in every company (owner decision 2: a person runs,
 // approves and closes payroll). The payroll Audit loop (P2-2b, its own runner) is not a LoopId: core/loops/levels.ts
 // refuses it, and migration 0963's teras_loop_level_cap keeps it at Prepare in the database.
 loop_salary_payroll:{categories:['pay'],ceiling:1,actor:false,criteria:['prepared','rule_broken','days_at_level']},
};
export const LOOP_AUTONOMY:Readonly<Record<LoopId,AutonomyDeclaration>>=freeze(DECLARATIONS);

/** True when any category is one a loop may never act on by itself. */
export const touchesCapped=(categories:readonly string[])=>categories.some(category=>(CAPPED_CATEGORIES as readonly string[]).includes(category));

/** The highest level a loop may ever reach, from its declaration. A capped category always gives Prepare. */
export function maxLevel(id:LoopId,declaration:AutonomyDeclaration=LOOP_AUTONOMY[id]):AutonomyLevel{
 if(!declaration||touchesCapped(declaration.categories))return 1;
 const ceiling=Math.min(Math.max(0,Math.trunc(declaration.ceiling)),3) as AutonomyLevel;
 return ceiling<1?1:ceiling;
}
/** The highest level a loop can be promoted to now: its ceiling, and above Prepare only with a built automatic step. */
export function promotableTo(id:LoopId,declaration:AutonomyDeclaration=LOOP_AUTONOMY[id]):AutonomyLevel{
 const ceiling=maxLevel(id,declaration);
 return ceiling>1&&!declaration.actor?1:ceiling;
}
/** Whether a level is allowed for a loop at all (the code cap the service and the runner both apply). */
export const levelAllowed=(id:LoopId,level:number)=>Number.isInteger(level)&&level>=0&&level<=promotableTo(id);
export const isCappedLoop=(id:LoopId)=>maxLevel(id)<=1;
export const CAPPED_LOOPS:readonly LoopId[]=Object.freeze(LOOP_IDS.filter(isCappedLoop));

/** Level 3: the weekly sample HR reviews, at least 10% and at least 5 actions (all of them when there are fewer). */
export const SAMPLE_RULE=Object.freeze({minShare:0.1,minActions:5});
export const sampleSize=(total:number)=>total<=0?0:Math.min(total,Math.max(SAMPLE_RULE.minActions,Math.ceil(total*SAMPLE_RULE.minShare)));

/** Whether a loop's acting depends on a chosen condition (only the missed clock-outs loop's does). */
export const usesCondition=(id:LoopId)=>id==='loop_missed_clock_outs';

/** Without a promotion, limits only become stricter: no more actions a night, an undo window no shorter. The condition
 * to act is the group administrator's choice at any time. Something must change. */
export function limitsChangeAllowed(before:LoopLimits,after:LoopLimits):boolean{
 if(after.maxActionsPerNight>before.maxActionsPerNight||after.undoDays<before.undoDays)return false;
 return after.maxActionsPerNight!==before.maxActionsPerNight||after.undoDays!==before.undoDays||after.condition!==before.condition;
}

/** Limits a group administrator may set: at most MAX_ACTIONS_PER_NIGHT a night, an undo window of 3 or 7 days, and one
 * of the declared conditions. Anything else is refused, never clamped. */
export function parseLimits(value:unknown):LoopLimits|null{
 if(!value||typeof value!=='object')return null;
 const {maxActionsPerNight,undoDays,condition}=value as Record<string,unknown>;
 if(typeof maxActionsPerNight!=='number'||!Number.isInteger(maxActionsPerNight)||maxActionsPerNight<1||maxActionsPerNight>MAX_ACTIONS_PER_NIGHT)return null;
 if(!(UNDO_WINDOW_DAYS as readonly unknown[]).includes(undoDays))return null;
 if(!(ACT_CONDITIONS as readonly unknown[]).includes(condition))return null;
 return Object.freeze({maxActionsPerNight,undoDays:undoDays as LoopLimits['undoDays'],condition:condition as LoopLimits['condition']});
}

/** What a certificate is computed from, for one loop and company over PROMOTION_RULES.windowDays. At Prepare the
 * evidence is the loop's cases (prepared, and completed as prepared or changed by the person); at Level 2 it is its
 * automatic actions (applied, and undone or changed by people afterwards). */
export type PromotionInput=Readonly<{targetLevel:2|3;prepared:number;asPrepared:number;changed:number;ruleBroken:number;daysAtLevel:number}>;
export type Criterion=Readonly<{id:CriterionId;needed:number;actual:number|null;count:number|null;met:boolean}>;
export type Certificate=Readonly<{targetLevel:2|3;criteria:readonly Criterion[];met:boolean}>;

/** The certificate: every declared criterion, its threshold, the actual value and whether it is met. A share with no
 * denominator is unknown and not met. "Under 1%" is strict. */
export function certificate(id:LoopId,input:PromotionInput,declaration:AutonomyDeclaration=LOOP_AUTONOMY[id]):Certificate{
 const daysNeeded=PROMOTION_RULES.daysAtLevel[input.targetLevel];
 const decided=input.asPrepared+input.changed;
 const share=decided>0?input.changed/decided:null;
 const all:Record<CriterionId,Criterion>={
  prepared:{id:'prepared',needed:PROMOTION_RULES.minPrepared,actual:input.prepared,count:null,met:input.prepared>=PROMOTION_RULES.minPrepared},
  changed:{id:'changed',needed:PROMOTION_RULES.maxChangedShare,actual:share,count:input.changed,met:share!==null&&share<PROMOTION_RULES.maxChangedShare},
  rule_broken:{id:'rule_broken',needed:0,actual:input.ruleBroken,count:null,met:input.ruleBroken===0},
  days_at_level:{id:'days_at_level',needed:daysNeeded,actual:input.daysAtLevel,count:null,met:input.daysAtLevel>=daysNeeded},
 };
 const criteria=declaration.criteria.map(key=>Object.freeze(all[key]));
 return Object.freeze({targetLevel:input.targetLevel,criteria:Object.freeze(criteria),met:criteria.every(item=>item.met)});
}

/** The fixed demotion rule: strictly more than 1% of the automatic actions over the last 7 days corrected by people. */
export function shouldDemote(applied:number,corrected:number):boolean{
 return applied>0&&corrected/applied>DEMOTION_RULE.maxCorrectedShare;
}
