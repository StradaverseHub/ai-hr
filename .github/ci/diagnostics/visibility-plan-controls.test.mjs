/** Fake SQL transport only; validates that the new controls actually reject stale authorization. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exerciseReusedVisibilityConnection} from './visibility-plan-controls.mjs';
function transport(contexts,all,broken){
 let state={role:'postgres',context:null,revoked:false,archived:false,edges:false},released=false;
 const saves=new Map();
 const unsafe=async(text,args=[])=>{
  if(text==='begin'){saves.set('__outer',structuredClone(state));return [];}
  if(text==='rollback'){state=structuredClone(saves.get('__outer'));return [];}
  if(text==='select pg_backend_pid() as pid')return [{pid:222}];
  if(text.startsWith('set local role ')){state.role=text.endsWith('ai_hr_app')?'ai_hr_app':'postgres';return [];}
  if(text.includes("set_config('app.tenant_id'")){state.context=contexts.find(c=>c.tenantId===args[0]&&c.userId===args[1]);assert(state.context);return [];}
  if(text.startsWith('savepoint ')){saves.set(text.split(' ')[1],structuredClone(state));return [];}
  if(text.startsWith('rollback to savepoint ')){state=structuredClone(saves.get(text.split(' ')[3]));return [];}
  if(text.startsWith('release savepoint ')){saves.delete(text.split(' ')[2]);return [];}
  if(text.startsWith('update role_assignment')){assert.equal(state.role,'postgres');state.revoked=true;return [{id:'revoked'}];}
  if(text.startsWith('update app_user')){assert.equal(state.role,'postgres');state.archived=true;return [{id:'archived'}];}
  if(text.startsWith('update reporting_line')){assert.equal(state.role,'postgres');state.edges=true;return [{id:'edge'}];}
  if(text.startsWith('select pg_backend_pid() as pid,current_user')){
   const index=contexts.findIndex(c=>c.userId===state.context.userId&&c.tenantId===state.context.tenantId),normal=all.slice(index%10,index%10+2),reference=state.edges?normal.slice(0,1):normal;
   const actual=broken==='context'?all.slice(0,2):broken==='graph'&&state.edges?normal:reference;
   return [{pid:broken==='connection'?223:222,caller:state.role,current:broken==='revocation'?true:!state.revoked&&!state.archived,actual,reference}];
  }
  throw Error('Unexpected fake SQL command: '+text);
 };
 return {pg:{reserve:async()=>({unsafe,release:()=>{released=true;}})},released:()=>released};
}
const contexts=Array.from({length:24},(_,i)=>({name:i===0?'hr_admin scoped to A':i===1?'manager top (ceo)':'context'+i,tenantId:i<12?'tenant1':'tenant2',userId:'user'+i,roles:[i===0?'hr_admin':'employee'],grants:[]}));
const all=Array.from({length:40},(_,i)=>'employment'+i);
test('actual control flow on fake transport proves all72 context queries and refuses stale context, grant, graph or changed connection',async()=>{
 for(const broken of [null,'context','revocation','graph','connection']){
  const temp=realpathSync(mkdtempSync(join(tmpdir(),'plan-control-'))),out=join(temp,'proof');mkdirSync(out,{mode:0o700});
  const changes={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',AIHR_PLAN_REUSE_MODE:'prototype',AIHR_CI_HEAD:'a'.repeat(40),AIHR_CI_CONTROL_HEAD:'a'.repeat(40),TEST_DB_NAMESPACE:'plan_proto',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test_w_plan_proto1',RUNNER_TEMP:temp,AIHR_PLAN_PROOF_DIR:out};
  const before=Object.fromEntries(Object.keys(changes).map(k=>[k,process.env[k]]));Object.assign(process.env,changes);
  const fake=transport(contexts,all,broken);
  try{
   if(broken){await assert.rejects(exerciseReusedVisibilityConnection(fake.pg,contexts,all,{ceo:'ceo'},'ai_hr_test_w_plan_proto1'));assert(!existsSync(join(out,'reused-connection.json')));}
   else{const proof=await exerciseReusedVisibilityConnection(fake.pg,contexts,all,{ceo:'ceo'},'ai_hr_test_w_plan_proto1');assert.equal(proof.contextQueries,72);assert.equal(proof.outerTransactionRolledBack,true);assert(proof.roleRevocationAndRollbackVerified&&proof.loginArchivalAndRollbackVerified&&proof.actualGraphMutationAndRollbackVerified);assert.equal(JSON.parse(readFileSync(join(out,'reused-connection.json'))).releaseAuthorized,false);}
   assert(fake.released());
  }finally{for(const [k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;rmSync(temp,{recursive:true});}
 }
});
