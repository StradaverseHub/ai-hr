/** 5143/5144 replaced app.can_see_employment and app.visible_employment_ids with the request-bound final-decision window.
 * Earlier applied migrations (2141, 3001, 3102) pin the reviewed bodies they were written against, so a test that
 * replays their actual bytes installs those reviewed bodies first and the current 5143 bodies afterwards. */
import {readFileSync} from 'node:fs';
function definition(file:string,head:string){
 const sql=readFileSync(file,'utf8'),start=sql.indexOf(head);
 if(start<0)throw new Error(`${head} not found in ${file}`);
 const end=sql.indexOf('$$;',start);if(end<0)throw new Error(`unterminated ${head} in ${file}`);
 return sql.slice(start,end+3)+'\n';
}
const CAN_SEE='CREATE OR REPLACE FUNCTION app.can_see_employment(emp_id uuid)',VISIBLE='CREATE OR REPLACE FUNCTION app.visible_employment_ids()';
export const REVIEWED_VISIBILITY_PREDECESSOR=definition('db/migrations/0109_hierarchy_visibility_rls.sql',CAN_SEE)+definition('db/migrations/2105_authorization_navigation_plans.sql',VISIBLE);
export const CURRENT_VISIBILITY=definition('db/migrations/5144_attendance_lane_security_review.sql',CAN_SEE)+definition('db/migrations/5144_attendance_lane_security_review.sql',VISIBLE);
/** Replay `sql` against the reviewed predecessor bodies, then reinstall the current ones in the same statement batch. */
export const againstReviewedVisibility=(sql:string)=>REVIEWED_VISIBILITY_PREDECESSOR+sql+'\n'+CURRENT_VISIBILITY;

/** 7240 (precomputed employment visibility) replaced app.visible_employment_ids (5144 body), and the USING of
 * employment_rls and person_rls. Its reviewed predecessor and replacement texts live in the migration itself. */
const M7240=readFileSync('db/migrations/7240_access_visible_employment.sql','utf8');
const constant7240=(name:string)=>{const m=M7240.match(new RegExp(`${name} constant text := \\$q\\$([\\s\\S]*?)\\$q\\$;`));if(!m)throw new Error(`${name} not found in 7240`);return m[1];};
export const VISIBILITY_7240={
 employmentBefore:constant7240('emp_pred'),employmentAfter:constant7240('emp_next'),
 personBefore:constant7240('person_pred'),personAfter:constant7240('person_next'),
 visibleBefore:definition('db/migrations/5144_attendance_lane_security_review.sql',VISIBLE),
};
type Sql={unsafe:(q:string)=>Promise<unknown>;begin:<T>(fn:(tx:{unsafe:(q:string)=>Promise<unknown>})=>Promise<T>)=>Promise<T>};
/** PostgreSQL's deparsed form of a USING expression on `table`, through a scratch policy rolled back with its transaction. */
export async function deparsedUsing(client:Sql,table:'employment'|'person',using:string):Promise<string>{
 let out='';
 await client.begin(async tx=>{
  await tx.unsafe(`create policy reviewed_visibility_scratch on public.${table} for select to ai_hr_app using (${using})`);
  const rows=await tx.unsafe(`select pg_get_expr(polqual,polrelid) as q from pg_policy where polrelid='public.${table}'::regclass and polname='reviewed_visibility_scratch'`) as {q:string}[];
  out=rows[0].q;
  await tx.unsafe(`drop policy reviewed_visibility_scratch on public.${table}`);
 });
 return out;
}
/** Tests that replay migrations written before 7240 run against the state 7240 replaced: install it, and return a
 * function that restores the installed 7240 objects. */
export async function installPre7240(client:Sql):Promise<()=>Promise<void>>{
 let current:{fn:string;employment:string;person:string}|null=null;
 await client.begin(async tx=>{
  const[fn]=await tx.unsafe(`select pg_get_functiondef('app.visible_employment_ids()'::regprocedure) as d`) as {d:string}[];
  const[emp]=await tx.unsafe(`select pg_get_expr(polqual,polrelid) as q from pg_policy where polrelid='public.employment'::regclass and polname='employment_rls'`) as {q:string}[];
  const[per]=await tx.unsafe(`select pg_get_expr(polqual,polrelid) as q from pg_policy where polrelid='public.person'::regclass and polname='person_rls'`) as {q:string}[];
  current={fn:fn.d,employment:emp.q,person:per.q};
  await tx.unsafe(VISIBILITY_7240.visibleBefore);
  await tx.unsafe(`alter policy employment_rls on public.employment using (${VISIBILITY_7240.employmentBefore})`);
  await tx.unsafe(`alter policy person_rls on public.person using (${VISIBILITY_7240.personBefore})`);
 });
 return async()=>{const c=current!;await client.begin(async tx=>{
  await tx.unsafe(c.fn);
  await tx.unsafe(`alter policy employment_rls on public.employment using (${c.employment})`);
  await tx.unsafe(`alter policy person_rls on public.person using (${c.person})`);
 });};
}
