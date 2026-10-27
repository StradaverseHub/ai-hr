/** Semantic evidence from the already-authorized Mine entitlement tool, never from model prose.
 * This is a projection, not another entitlement resolver or a disclosure/authorization boundary.
 * Rendering uses the existing entitlement/eligibility translation vocabulary. Missing figures stay
 * unknown; status is copied from the engine, never inferred from a zero or a missing ledger row.
 */
import {ENTITLEMENT_STATUS_LABEL_KEY,ENTITLEMENT_STATUS_TIP_KEY,ELIGIBILITY_AXIS_LABEL_KEY,
 type EntitlementStatus,type EligibilityNotice,type EligibilityRuleNotice} from '../entitlement-status';

const FIGURES=['displayEntitlementDays','currentYearEntitlement','broughtForward','adjustments',
 'totalEntitlement','takenThisCycle','pendingApproval','forfeitedThisCycle','totalAvailable'] as const;
type Figure=typeof FIGURES[number];
type RuleState=EligibilityRuleNotice['state'];
type Verdict=EligibilityNotice['verdict'];
export type LeaveEligibilityEvidence=Readonly<{
 verdict:Verdict;activeAtDate:boolean;usesUndatedAxis:boolean;
 rules:readonly Readonly<{lineageId:string;name:string;state:RuleState;tested:boolean;
 validFrom:string;validTo:string|null;tableName:string|null;
 failingAxisLabel:Readonly<{ns:'criteria'|'orgCategory';key:string}>|null;failsOnCombination:boolean}>[];
}>;
export type LeaveEmploymentEvidence=Readonly<{
 employmentId:string;company:string;leaveType:string;cycleStart:string;withheld:boolean;
 entitlement:Readonly<{status:EntitlementStatus;labelKey:string;tipKey:string|null;templateName:string|null}>;
 figures:Readonly<Partial<Record<Figure,number>>>;
 /** null is UNKNOWN/withheld, not a promise that carry never expires. */
 carryForwardExpiryDate:string|null;
 eligibility:LeaveEligibilityEvidence|null;
}>;
export type LeaveAnswerEvidence=Readonly<{asOf:string;employments:readonly LeaveEmploymentEvidence[];truncated:boolean}>;
const record=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid canonical leave evidence.');return v as Record<string,unknown>;};
const text=(v:unknown):string=>{if(typeof v!=='string'||v.length>500)throw Error('Invalid canonical leave evidence.');return v;};
const nullableText=(v:unknown)=>v===null||v===undefined?null:text(v);
const bool=(v:unknown):boolean=>{if(typeof v!=='boolean')throw Error('Invalid canonical leave evidence.');return v;};
const date=(v:unknown):string=>{const s=text(v);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)throw Error('Invalid canonical leave evidence.');return s;};
const nullableDate=(v:unknown)=>v===null||v===undefined?null:date(v);
const states:readonly RuleState[]=['matched','in_force','expired','not_yet','table_stopped'];
const verdicts:readonly Verdict[]=['resolved','sole_table','default_table','not_active','no_rules','no_match'];
function eligibility(value:unknown):LeaveEligibilityEvidence|null{
 if(value===null||value===undefined)return null;
 const n=record(value),verdict=n.verdict;
 if(typeof verdict!=='string'||!verdicts.includes(verdict as Verdict)||!Array.isArray(n.rules))throw Error('Invalid canonical leave evidence.');
 const rules=n.rules.map(value=>{
  const r=record(value),state=r.state,tested=bool(r.tested),axis=nullableText(r.failingAxis);
  if(typeof state!=='string'||!states.includes(state as RuleState))throw Error('Invalid canonical leave evidence.');
  // Match the employee panel: name the failed axis only when it was actually tested, never its raw
  // stored value or an admin href. Unknown axes have no authoritative label and are not guessed.
  const label=tested&&axis&&Object.prototype.hasOwnProperty.call(ELIGIBILITY_AXIS_LABEL_KEY,axis)?ELIGIBILITY_AXIS_LABEL_KEY[axis]:null;
  return Object.freeze({lineageId:text(r.id),name:text(r.name),state:state as RuleState,tested,
   validFrom:date(r.validFrom),validTo:nullableDate(r.validTo),tableName:nullableText(r.tableName),
   failingAxisLabel:label?Object.freeze({...label}):null,failsOnCombination:bool(r.failsOnCombination)});
 });
 return Object.freeze({verdict:verdict as Verdict,activeAtDate:bool(n.activeAtDate),usesUndatedAxis:bool(n.usesUndatedAxis),rules:Object.freeze(rules)});
}
/** Caller must supply the actual current leave_entitlement_explain outcome, not posted/model data.
 * No derivation is reconstructed from transactions: Mine may deliberately withhold those records.
 * Full ExplainStep/proration working requires a separately authorized canonical derivation contract.
 */
export function projectLeaveAnswerEvidence(outcome:unknown):LeaveAnswerEvidence|null{
 const source=record(outcome);if(source.ok!==true)return null;
 if(!Array.isArray(source.employments))throw Error('Invalid canonical leave evidence.');
 const employments=source.employments.slice(0,25).map(value=>{
  const row=record(value),status=row.entitlementStatus;
  if(typeof status!=='string'||!Object.prototype.hasOwnProperty.call(ENTITLEMENT_STATUS_LABEL_KEY,status))throw Error('Invalid canonical leave evidence.');
  const figures:Partial<Record<Figure,number>>={};
  for(const key of FIGURES){const v=row[key];if(v===null||v===undefined)continue;
   if(typeof v!=='number'||!Number.isFinite(v))throw Error('Invalid canonical leave evidence.');figures[key]=v;}
  const s=status as EntitlementStatus;
  return Object.freeze({employmentId:text(row.employmentId),company:text(row.company),leaveType:text(row.leaveType),cycleStart:date(row.cycleStart),
   withheld:bool(row.withheld),entitlement:Object.freeze({status:s,labelKey:ENTITLEMENT_STATUS_LABEL_KEY[s],tipKey:ENTITLEMENT_STATUS_TIP_KEY[s]??null,
    templateName:nullableText(row.entitlementTemplateName)}),figures:Object.freeze(figures),
   carryForwardExpiryDate:nullableDate(row.carryForwardExpiryDate),eligibility:eligibility(row.eligibility)});
 });
 return Object.freeze({asOf:date(source.asOf),employments:Object.freeze(employments),truncated:source.truncated===true||source.employments.length>25});
}
