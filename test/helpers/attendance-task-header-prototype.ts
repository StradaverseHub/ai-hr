import {sql} from 'drizzle-orm';
import {expect} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';

type ExplainNode = {'Actual Rows'?:number;'Shared Hit Blocks'?:number};

/** Compare the installed reader against actual RLS in the same statement snapshot. */
export async function comparePendingHeaderPrototype(actors:Record<string,SessionContext>,requestId?:string){
  const comparisons:Record<string,unknown>={};
  for(const [name,actor] of Object.entries(actors)){
   const [row]=await withTenant(actor,tx=>tx.execute<{db_role:string;expected:number;differences:number}>(sql`
    with expected as materialized (
      select id,employment_id,created_at from public.attendance_correction
      where tenant_id=app.current_tenant_id() and status='pending'
      and (${requestId??null}::uuid is null or id=${requestId??null}::uuid)
    ), candidate as materialized (select * from app.attendance_pending_visible_headers(${requestId??null}::uuid)),
    missing as (select * from expected except all select * from candidate),
    extra as (select * from candidate except all select * from expected)
    select current_user as db_role,(select count(*)::int from expected) as expected,
      ((select count(*) from missing)+(select count(*) from extra))::int as differences
   `));
   expect(row.db_role).toBe('ai_hr_app');
   expect(row.differences,name).toBe(0);
   const measure=(candidate:boolean)=>withTenant(actor,async tx=>{
    const query=candidate?sql`select * from app.attendance_pending_visible_headers(${requestId??null}::uuid)`:sql`
      select id,employment_id,created_at from public.attendance_correction
      where tenant_id=app.current_tenant_id() and status='pending'
      and (${requestId??null}::uuid is null or id=${requestId??null}::uuid)`;
    const [result]=await tx.execute<{'QUERY PLAN':{Plan:ExplainNode;'Execution Time':number}[]}>(sql`
      explain (analyze, buffers, format json) ${query}
    `);
    const [plan]=result['QUERY PLAN'];
    return {rows:plan.Plan['Actual Rows'],sharedHits:plan.Plan['Shared Hit Blocks'],executionMs:plan['Execution Time']};
   });
   comparisons[name]={rows:row.expected,differences:row.differences,rls:await measure(false),prototype:await measure(true)};
  }
  return comparisons;

}

export async function verifyWorkflowOnlyAttendanceHeader(actor:SessionContext,requestId:string,subjectId:string){
 const [visibility]=await withTenant(actor,tx=>tx.execute<{ordinary:boolean}>(sql`
  select ${subjectId}::uuid=any(app.visible_employment_ids()) as ordinary
 `));
 expect(visibility.ordinary).toBe(false);
 const result=await comparePendingHeaderPrototype({assigned:actor},requestId);
 expect(result).toMatchObject({assigned:{rows:1,differences:0}});
}
