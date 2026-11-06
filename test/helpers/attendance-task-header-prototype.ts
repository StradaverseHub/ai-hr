import {sql} from 'drizzle-orm';
import {expect} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import {owner} from '../harness';

type ExplainNode = {'Actual Rows'?:number;'Shared Hit Blocks'?:number};

const originalJoin = 'FROM public.attendance_correction q JOIN visibility v ON q.tenant_id=v.tenant_id';
const originalPolicies = `app.attendance_workflow_delegate_request(q.id)
  OR app.attendance_workflow_v2_read(q.id)
  OR app.attendance_workflow_v3_read(q.id)
  OR app.unrouted_attendance_delegate(q.id)`;

// Only the policy that handles the recorded routing version can admit this row.
const versionedPolicies = `CASE
  WHEN workflow.routing_version IS NULL THEN app.unrouted_attendance_delegate(q.id)
  WHEN workflow.routing_version=1 THEN app.attendance_workflow_delegate_request(q.id)
  WHEN workflow.routing_version=2 THEN app.attendance_workflow_delegate_request(q.id) OR app.attendance_workflow_v2_read(q.id)
  WHEN workflow.routing_version IN (3,4) THEN app.attendance_workflow_v3_read(q.id)
  ELSE false
 END`;

async function withVersionedPendingHeaders<T>(read: () => Promise<T>): Promise<T> {
 const [row] = await owner.client<{definition:string}[]>`
  select pg_get_functiondef('app.attendance_pending_visible_headers(uuid)'::regprocedure) as definition
 `;
 expect(row.definition).toContain(originalJoin);
 expect(row.definition).toContain(originalPolicies);
 const candidate=row.definition
  .replace(originalJoin,originalJoin+`
 LEFT JOIN public.attendance_workflow_request workflow
  ON workflow.correction_id=q.id AND workflow.tenant_id=q.tenant_id`)
  .replace(originalPolicies,versionedPolicies);
 await owner.client.unsafe(candidate);
 try { return await read(); }
 finally { await owner.client.unsafe(row.definition); }
}

/** Compare both plans against actual RLS. The test database restores its installed function after the experiment. */
export async function comparePendingHeaderPrototype(actors:Record<string,SessionContext>,requestId?:string){
 const installed=await comparePendingHeaders(actors,requestId);
 const routed=await withVersionedPendingHeaders(()=>comparePendingHeaders(actors,requestId));
 return Object.fromEntries(Object.entries(installed).map(([name,measurements])=>[
  name,{...measurements,routed:routed[name].prototype},
 ]));
}

async function comparePendingHeaders(actors:Record<string,SessionContext>,requestId?:string){
  const comparisons:Record<string,{rows:number;differences:number;rls:unknown;prototype:unknown}>={};
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
