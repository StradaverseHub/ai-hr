/** Board 4197534a — the Overtime Pattern Eligibility step, as plain criteria rather than a formula.
 *
 * A draft keeps it in overtime_pattern_version.planned_eligibility (migration 7620). Activation turns it into the
 * ordinary assignment rows the overtime calculation already reads: one group target (every filled field must match,
 * any chosen value within a field matches; no field filled = everyone in the pattern's companies) and, when named
 * employees are listed, one individual target (named employees outrank groups in resolveOvertimePattern). Companies
 * are the version's company set, never a criterion here. Pure and client-safe; it never evaluates a payroll amount. */
import type {OvertimeAssignmentTarget,OvertimeCondition} from './overtime-pattern-model';
import {overtimeObject,overtimeRefuse,overtimeList,overtimeUuid} from './overtime-pattern-schema';
import {isCalendarDate} from './calendar-date';

export const OVERTIME_ELIGIBILITY_GROUPS={
 organisation:['businessUnitId','departmentId','orgDivision','orgBranch','orgRegion','orgLine','orgSection','orgTeam','orgBase'],
 job:['gradeId','positionId','employmentType','employmentCategory'],
} as const;
export type OvertimeEligibilityField=typeof OVERTIME_ELIGIBILITY_GROUPS[keyof typeof OVERTIME_ELIGIBILITY_GROUPS][number];
export const OVERTIME_ELIGIBILITY_FIELDS:readonly OvertimeEligibilityField[]=[...OVERTIME_ELIGIBILITY_GROUPS.organisation,...OVERTIME_ELIGIBILITY_GROUPS.job];
/** Criteria whose values are record ids; the rest are Personnel choice values (employment type, profile options). */
export const OVERTIME_ELIGIBILITY_ID_FIELDS:readonly OvertimeEligibilityField[]=['businessUnitId','departmentId','gradeId','positionId'];
/** Criteria read from the dated assignment row; the others come from the employment record (captured per day). */
export const OVERTIME_ELIGIBILITY_ASSIGNMENT_FIELDS:readonly OvertimeEligibilityField[]=['businessUnitId','departmentId','positionId','employmentType'];
export const OVERTIME_ELIGIBILITY_DEFAULT_PRIORITY=100;
export const OVERTIME_ELIGIBILITY_VALUE_LIMIT=500;

export type OvertimeEligibilityCriteria=Partial<Record<OvertimeEligibilityField,string[]>>;
export type OvertimePlannedEligibility={v:1;criteria:OvertimeEligibilityCriteria;employmentIds:string[];priority:number;from:string|null};

export function blankPlannedEligibility():OvertimePlannedEligibility {
 return {v:1,criteria:{},employmentIds:[],priority:OVERTIME_ELIGIBILITY_DEFAULT_PRIORITY,from:null};
}

/** Structural validation and normalisation (empty lists dropped, values de-duplicated, fields in catalogue order).
 * Throws OvertimePatternError for anything outside the shape. It does not prove a reference exists: the pack and
 * the 7620 trigger do that. */
export function parsePlannedEligibility(raw:unknown):OvertimePlannedEligibility {
 const r=overtimeObject(raw,'plannedEligibility');
 for(const key of Object.keys(r))if(!['v','criteria','employmentIds','priority','from'].includes(key))overtimeRefuse('invalid','plannedEligibility.'+key,'Unknown eligibility property.');
 if(r.v!==1)overtimeRefuse('invalid','plannedEligibility.v','Unsupported eligibility version.');
 const rawCriteria=overtimeObject(r.criteria??{},'plannedEligibility.criteria');
 for(const key of Object.keys(rawCriteria))if(!(OVERTIME_ELIGIBILITY_FIELDS as readonly string[]).includes(key))overtimeRefuse('invalid','plannedEligibility.criteria.'+key,'Choose a supported eligibility field.');
 const criteria:OvertimeEligibilityCriteria={};
 for(const field of OVERTIME_ELIGIBILITY_FIELDS){
  if(!(field in rawCriteria))continue;
  const path='plannedEligibility.criteria.'+field;
  const values=overtimeList(rawCriteria[field],OVERTIME_ELIGIBILITY_VALUE_LIMIT,path).map((value,i)=>{
   if(OVERTIME_ELIGIBILITY_ID_FIELDS.includes(field))return overtimeUuid(value,`${path}.${i}`).toLowerCase();
   if(typeof value!=='string'||!value.trim()||value.length>160)overtimeRefuse('invalid',`${path}.${i}`,'Choose a listed value.');
   return value;
  });
  const unique=[...new Set(values)];
  if(unique.length)criteria[field]=unique;
 }
 const employmentIds=[...new Set(overtimeList(r.employmentIds??[],OVERTIME_ELIGIBILITY_VALUE_LIMIT,'plannedEligibility.employmentIds').map((id,i)=>overtimeUuid(id,`plannedEligibility.employmentIds.${i}`).toLowerCase()))];
 const priority=r.priority===undefined?OVERTIME_ELIGIBILITY_DEFAULT_PRIORITY:r.priority;
 if(typeof priority!=='number'||!Number.isInteger(priority)||priority<0||priority>9999)overtimeRefuse('invalid','plannedEligibility.priority','Enter a whole-number priority from 0 to 9999.');
 const from=r.from===undefined||r.from===null||r.from===''?null:r.from;
 if(from!==null&&(typeof from!=='string'||!isCalendarDate(from)))overtimeRefuse('invalid','plannedEligibility.from','Choose a valid Applies from date.');
 return {v:1,criteria,employmentIds,priority,from:from as string|null};
}

export function eligibilityCriteriaCondition(criteria:OvertimeEligibilityCriteria):OvertimeCondition {
 const children:OvertimeCondition[]=OVERTIME_ELIGIBILITY_FIELDS.filter(field=>criteria[field]?.length).map(field=>({id:'eligibility_'+field,type:'selection',field,operator:'in',values:[...criteria[field]!]}));
 return children.length?{id:'eligibility',type:'group',logic:'and',children}:{id:'eligibility',type:'constant',value:true};
}

/** The assignment targets activation writes. The group target always exists; named employees add an individual one. */
export function plannedEligibilityTargets(p:OvertimePlannedEligibility):{group:OvertimeAssignmentTarget;individual:OvertimeAssignmentTarget|null} {
 return {group:{type:'group',condition:eligibilityCriteriaCondition(p.criteria)},individual:p.employmentIds.length?{type:'individual',employmentIds:[...p.employmentIds]}:null};
}

/** The plain criteria a saved group condition expresses, or null when it is not selection-only (an advanced target:
 * shown read-only and compared on the day, never rewritten). */
export function selectionOnlyCriteria(condition:OvertimeCondition):OvertimeEligibilityCriteria|null {
 if(condition.type==='constant')return condition.value?{}:null;
 const atoms=condition.type==='group'?(condition.logic==='and'?condition.children:null):[condition];
 if(!atoms)return null;
 const criteria:OvertimeEligibilityCriteria={};
 for(const atom of atoms){
  if(atom.type!=='selection'||atom.operator!=='in'||!(OVERTIME_ELIGIBILITY_FIELDS as readonly string[]).includes(atom.field))return null;
  const field=atom.field as OvertimeEligibilityField;
  if(criteria[field])return null;
  criteria[field]=[...atom.values];
 }
 return criteria;
}

/** Planned eligibility rebuilt from a live version's assignments (Edit of an active pattern). Null when the live
 * assignments are not exactly one selection-only group target plus at most one individual target at one priority. */
export function plannedEligibilityFromAssignments(rows:readonly {target:OvertimeAssignmentTarget;priority:number;validFrom:string}[]):OvertimePlannedEligibility|null {
 const groups=rows.filter(row=>row.target.type==='group'),individuals=rows.filter(row=>row.target.type==='individual');
 if(groups.length!==1||individuals.length>1)return null;
 const group=groups[0],target=group.target;
 if(target.type!=='group')return null;
 const criteria=selectionOnlyCriteria(target.condition);
 if(!criteria)return null;
 const person=individuals[0];
 if(person&&person.priority!==group.priority)return null;
 return {v:1,criteria,employmentIds:person&&person.target.type==='individual'?[...person.target.employmentIds]:[],priority:group.priority,from:null};
}
