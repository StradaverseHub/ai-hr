/** Server-only action navigation. No fact read, model catalogue, proposal or effect authority. */
import 'server-only';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {withAgentActionGuard} from './agent-action-guard';
export const PERSONNEL_REVIEW_NAVIGATION_ACTIONS=['employees.workforce_profile.maintain','employees.code.maintain'] as const;
export type PersonnelReviewNavigationAction=typeof PERSONNEL_REVIEW_NAVIGATION_ACTIONS[number];
const witnesses:Record<PersonnelReviewNavigationAction,(tx:Tx)=>Promise<boolean>>={
 'employees.workforce_profile.maintain':async tx=>{const [row]=await tx.execute<{available:boolean}>(sql`select app.assistant_workforce_profile_navigation_available() as available`);return row?.available===true;},
 'employees.code.maintain':async tx=>{const [row]=await tx.execute<{available:boolean}>(sql`select app.assistant_employee_code_navigation_available() as available`);return row?.available===true;},
};
/** Each action owns a separate read-only transaction. An unavailable action never poisons another
 * action's transaction, and unknown never means offered. No cached role or workspace result is authority. */
export async function availablePersonnelReviewNavigation(supplied:SessionContext):Promise<readonly PersonnelReviewNavigationAction[]>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))},offered:PersonnelReviewNavigationAction[]=[];
 // Change only access mode: preserve the principal guard's required default READ COMMITTED isolation.
 for(const action of PERSONNEL_REVIEW_NAVIGATION_ACTIONS){
  try{if(await withTenant(ctx,async tx=>{await tx.execute(sql`set transaction read only`);await withAgentActionGuard(tx,ctx,action,'approve');return witnesses[action](tx);}))offered.push(action);}catch{/* Unknown/refused: hide this navigation entry only. */}
 }
 return Object.freeze(offered);
}
