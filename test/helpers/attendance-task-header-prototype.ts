import {sql} from 'drizzle-orm';
import {expect} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import {owner} from '../harness';

type ExplainNode = {'Actual Rows'?:number;'Shared Hit Blocks'?:number};

// Prototype lives only in the isolated test database. Compare against actual RLS
// in the same snapshot before deciding whether a production migration is worthwhile.
export async function comparePendingHeaderPrototype(actors:Record<string,SessionContext>,requestId?:string){
 await owner.db.execute(sql`
  create function app.test_attendance_pending_headers(wanted uuid)
  returns table(id uuid, employment_id uuid, created_at timestamptz)
  language sql stable security definer set search_path=pg_catalog,public,pg_temp as $prototype$
    with actor as materialized (
      select app.current_tenant_id() as tenant_id
      where app.current_user_id() is not null and app.principal_snapshot_current()
    ), visibility as materialized (
      select tenant_id, app.visible_employment_ids() as ids from actor
    )
    select q.id,q.employment_id,q.created_at
    from public.attendance_correction q join visibility v on q.tenant_id=v.tenant_id
    where q.status='pending' and (wanted is null or q.id=wanted)
      and case when q.employment_id=any(v.ids) then true else
        app.attendance_workflow_delegate_request(q.id)
        or app.attendance_workflow_v2_read(q.id)
        or app.attendance_workflow_v3_read(q.id)
        or app.unrouted_attendance_delegate(q.id)
      end
  $prototype$
 `);
 try{
  await owner.db.execute(sql`revoke all on function app.test_attendance_pending_headers(uuid) from public`);
  await owner.db.execute(sql`grant execute on function app.test_attendance_pending_headers(uuid) to ai_hr_app`);
  const comparisons:Record<string,unknown>={};
  for(const [name,actor] of Object.entries(actors)){
   const [row]=await withTenant(actor,tx=>tx.execute<{db_role:string;expected:number;differences:number}>(sql`
    with expected as materialized (
      select id,employment_id,created_at from public.attendance_correction
      where tenant_id=app.current_tenant_id() and status='pending'
      and (${requestId??null}::uuid is null or id=${requestId??null}::uuid)
    ), candidate as materialized (select * from app.test_attendance_pending_headers(${requestId??null}::uuid)),
    missing as (select * from expected except all select * from candidate),
    extra as (select * from candidate except all select * from expected)
    select current_user as db_role,(select count(*)::int from expected) as expected,
      ((select count(*) from missing)+(select count(*) from extra))::int as differences
   `));
   expect(row.db_role).toBe('ai_hr_app');
   expect(row.differences,name).toBe(0);
   const measure=(candidate:boolean)=>withTenant(actor,async tx=>{
    const query=candidate?sql`select * from app.test_attendance_pending_headers(${requestId??null}::uuid)`:sql`
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
 }finally{
  await owner.db.execute(sql`drop function app.test_attendance_pending_headers(uuid)`);
 }
}

