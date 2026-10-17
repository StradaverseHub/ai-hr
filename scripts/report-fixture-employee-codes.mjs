/** Fictional fixture identifiers; the canonical employee-code validator remains the format owner. */
import {requireEmployeeCode} from '../lib/employee-code.ts';
export const REPORT_FIXTURE_ACTOR_KEYS=Object.freeze(['HR_A','HR_B','NoSalary','HiddenHR','Employee','ForeignHR']);
export function reportFixtureActorCode(key){
 if(!REPORT_FIXTURE_ACTOR_KEYS.includes(key))throw new Error('Unknown Reports fixture actor.');
 return requireEmployeeCode('R18-'+key.replaceAll('_','-').toUpperCase());
}
/** Validate every manually supplied actor/subject code before the first business writer runs.
 * Draft codes remain allocated and validated by the canonical reservation owner, not this plan.
 */
export function preflightReportFixtureEmployeeCodes(){
 const actors=Object.fromEntries(REPORT_FIXTURE_ACTOR_KEYS.map(key=>[key,reportFixtureActorCode(key)]));
 const subjects=Array.from({length:56},(_,index)=>requireEmployeeCode('R18-'+String(index+1).padStart(6,'0')));
 const codes=[...Object.values(actors),...subjects];
 if(new Set(codes).size!==codes.length)throw new Error('Reports fixture employee codes overlap.');
 return {actors,subjects};
}
