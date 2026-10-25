/** Actual reused-connection controls for the owned visibility experiment; not release coverage. */
import assert from 'node:assert/strict';
import {writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {assertInstallEnvironment} from './visibility-plan-prototype.mjs';
const sorted=xs=>[...(xs??[])].map(String).sort();
export async function exerciseReusedVisibilityConnection(pg,contexts,all,ids){
 assertInstallEnvironment(process.env);
 assert(contexts.length>=24&&new Set(contexts.map(c=>c.tenantId)).size>=2&&all.length>=40);
 const session=await pg.reserve(),observations=[],proof={kind:'OWNED_REUSED_CONNECTION_VISIBILITY_CONTROLS',mode:process.env.AIHR_PLAN_REUSE_MODE,source:process.env.AIHR_CI_HEAD,releaseAuthorized:false};
 let begun=false,failure;
 try{
  await session.unsafe('begin');begun=true;
  {const tx=session;
   const [{pid}]=await tx.unsafe('select pg_backend_pid() as pid');assert(Number.isInteger(pid));
   const setContext=async c=>{
    await tx.unsafe('set local role postgres');
    await tx.unsafe("select set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true),set_config('app.roles',$3,true),set_config('app.grants',$4,true)",[c.tenantId,c.userId,c.roles.join(','),JSON.stringify(c.grants)]);
    await tx.unsafe('set local role ai_hr_app');
   };
   const observe=async()=>{
    const [r]=await tx.unsafe('select pg_backend_pid() as pid,current_user as caller,app.principal_snapshot_current() as current,app.visible_employment_ids() as actual,array(select x from unnest($1::uuid[]) x where app.can_see_employment(x)) as reference',[all]);
    assert.equal(r.pid,pid);assert.equal(r.caller,'ai_hr_app');assert.deepEqual(sorted(r.actual),sorted(r.reference),'Cached predicate diverged from real per-row authorization');
    return r;
   };
   for(let repeat=0;repeat<3;repeat++)for(const c of contexts){
    await setContext(c);const r=await observe();observations.push({repeat,tenant:c.tenantId,visibility:sorted(r.actual)});
   }
   assert(new Set(observations.map(o=>JSON.stringify(o.visibility))).size>=8,'Context comparison is vacuous');
   const admin=contexts.find(c=>c.name==='hr_admin scoped to A'),manager=contexts.find(c=>c.name==='manager top (ceo)');assert(admin&&manager&&ids.ceo);
   await setContext(admin);assert.equal((await observe()).current,true);
   await tx.unsafe('savepoint plan_revoke');await tx.unsafe('set local role postgres');
   const revoked=await tx.unsafe("update role_assignment set role='employee' where tenant_id=$1 and app_user_id=$2 and role='hr_admin' returning id",[admin.tenantId,admin.userId]);assert(revoked.length>0);
   await tx.unsafe('set local role ai_hr_app');assert.equal((await observe()).current,false,'Revoked real role was cached as current');
   await tx.unsafe('rollback to savepoint plan_revoke');await tx.unsafe('release savepoint plan_revoke');assert.equal((await observe()).current,true);
   proof.roleRevocationAndRollbackVerified=true;
   await tx.unsafe('savepoint plan_archive');await tx.unsafe('set local role postgres');
   const archived=await tx.unsafe('update app_user set archived_at=now() where tenant_id=$1 and id=$2 returning id',[admin.tenantId,admin.userId]);assert.equal(archived.length,1);
   await tx.unsafe('set local role ai_hr_app');assert.equal((await observe()).current,false,'Archived login was cached as current');
   await tx.unsafe('rollback to savepoint plan_archive');await tx.unsafe('release savepoint plan_archive');assert.equal((await observe()).current,true);
   proof.loginArchivalAndRollbackVerified=true;
   await setContext(manager);const before=sorted((await observe()).actual);
   await tx.unsafe('savepoint plan_edges');await tx.unsafe('set local role postgres');
   const changed=await tx.unsafe("update reporting_line set valid_to=current_date where tenant_id=$1 and manager_employment_id=$2 and line_type='administrative' and superseded_at is null and (valid_to is null or valid_to>current_date) returning id",[manager.tenantId,ids.ceo]);assert(changed.length>0);
   await tx.unsafe('set local role ai_hr_app');const after=sorted((await observe()).actual);assert.notDeepEqual(after,before,'Actual graph mutation did not change visibility');
   await tx.unsafe('rollback to savepoint plan_edges');await tx.unsafe('release savepoint plan_edges');assert.deepEqual(sorted((await observe()).actual),before,'Cached graph did not recover after rollback');
   proof.actualGraphMutationAndRollbackVerified=true;proof.backendPid=pid;proof.reusedConnection=true;proof.applicationRole='ai_hr_app';
   proof.contextQueries=observations.length;proof.contexts=contexts.length;proof.tenants=new Set(contexts.map(c=>c.tenantId)).size;proof.distinctVisibilitySets=new Set(observations.map(o=>JSON.stringify(o.visibility))).size;
  }
  await session.unsafe('rollback');begun=false;proof.outerTransactionRolledBack=true;
 }catch(error){failure=error;throw error;}
 finally{try{if(begun)await session.unsafe('rollback');}catch(cleanup){throw new AggregateError([failure,cleanup].filter(Boolean),'Owned control rollback failed');}finally{session.release();}}
 assert(proof.roleRevocationAndRollbackVerified&&proof.loginArchivalAndRollbackVerified&&proof.actualGraphMutationAndRollbackVerified&&proof.contextQueries>=72);
 const out=realpathSync(process.env.AIHR_PLAN_PROOF_DIR),temp=realpathSync(process.env.RUNNER_TEMP);assert(out.startsWith(temp+'/'));
 writeFileSync(join(out,'reused-connection.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});return proof;
}
