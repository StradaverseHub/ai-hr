/** Fixed disposable test worker. Subscribe to stop BEFORE importing any app/pool. */
import assert from 'node:assert/strict';
import {ownerInput,ownedDatabaseUrls,OwnerWorkFrontier,OwnerRefusal,ownerStage,type OwnerStage} from './attendance-bridge-owner-protocol';
import type postgres from 'postgres';
import type {ProofResult} from './attendance-bridge-owner-proof';

assert(process.send&&process.connected&&process.env.NODE_ENV==='test');
const frontier=new OwnerWorkFrontier();
let stopped!:()=>void;
const stopSignal=new Promise<void>(resolve=>{stopped=resolve;});
const stop=()=>{frontier.stop();stopped();};
let started=false;
let activeStage:OwnerStage='admission';
process.on('SIGTERM',stop);
process.on('disconnect',stop);
process.on('message',(value:unknown)=>{
 if(value&&typeof value==='object'&&'kind'in value&&value.kind==='stop'){
  if(Object.keys(value).length!==1)process.exitCode=1;
  stop();return;
 }
 if(started){process.exitCode=1;stop();return;}
 started=true;
 void main(value).catch(error=>finish(undefined,error));
});
function send(value:unknown):Promise<void>{return new Promise((resolve,reject)=>{
 if(!process.connected||!process.send){reject(Error('Owned parent IPC closed'));return;}
 process.send(value,error=>error?reject(Error('Owned parent IPC refused')):resolve());
});}
async function finish(report:ProofResult|undefined,error?:unknown){
 try{await frontier.closeAll();}catch{report=undefined;activeStage='work-settlement';}
 try{
  if(report)await send({kind:'owner-result',report});
  else{process.exitCode=1;await send({kind:'owner-refusal',stage:error instanceof OwnerRefusal?ownerStage(error.stage):activeStage});}
 }catch{process.exitCode=1;}
 finally{if(process.connected)process.disconnect();}
}
async function main(value:unknown){
 const input=ownerInput(value);
 const app=new URL(process.env.TEST_DATABASE_URL!),owner=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 const tag=app.searchParams.get('application_name');assert(tag&&/^bridge_[a-f0-9]{32}$/.test(tag));
 for(const url of [app,owner])for(const [key,expected]of [['connect_timeout','3'],['options','-c statement_timeout=5000 -c lock_timeout=300'],['application_name',tag]]){
  assert.equal(url.searchParams.get(key),expected);url.searchParams.delete(key);
 }
 const expected=ownedDatabaseUrls(app.toString(),owner.toString(),decodeURIComponent(app.pathname).slice(1),tag);
 assert.equal(process.env.DATABASE_URL,expected.app);assert.equal(process.env.TEST_DATABASE_URL,expected.app);
 assert.equal(process.env.MIGRATION_DATABASE_URL,expected.owner);assert.equal(process.env.TEST_MIGRATION_DATABASE_URL,expected.owner);
 const actualPools=()=>{
  const registry=(globalThis as typeof globalThis&{__aihrPgPools?:Map<string,postgres.Sql>}).__aihrPgPools;
  const pools:postgres.Sql[]=[];
  let foreign=false;
  if(registry)for(const [url,pool]of registry){frontier.adopt(pool);pools.push(pool);if(url!==expected.app&&url!==expected.owner)foreign=true;}
  if(foreign){frontier.stop();throw Error('Unknown child work pool capability');}
  return pools;
 };
 const stage=async(name:string)=>{await send({kind:'owner-stage',stage:name});await stopSignal;frontier.check();};
 let result:ProofResult|undefined,refusal:unknown;
 try{
  const proof=await frontier.construct(async()=>{
   if(input.mode==='stop-late-pool'){activeStage='late-pools';await stageBeforeImport();}
   try{return await import('./attendance-bridge-owner-proof');}
   finally{actualPools();} // Includes pools created before a failed/late import.
  },()=>[]);
  result= input.mode==='role-collision'
   ?await proof.collisionControl(input,frontier,()=>frontier.closeAll(),stage,name=>{activeStage=name;})
   :await proof.runOwnerProof(input,frontier,()=>frontier.closeAll(),stage,name=>{activeStage=name;});
 }catch(error){
  refusal=error;
  if(input.mode==='stop-late-pool'&&frontier.isStopped()){
   await frontier.closeAll();const pools=actualPools();assert(pools.length>=2);
   for(const pool of pools)await assert.rejects(async()=>{await pool.unsafe('select 1');},error=>
    error!==null&&typeof error==='object'&&'code'in error&&error.code==='CONNECTION_ENDED');
   result={kind:'ATTENDANCE_OWNER_FAULT',mode:input.mode,complete:true,allCatalogueRestored:false,roleAbsent:false,
    ownedOidCaptured:false,faultObserved:true,nonemptyApprover:false,canonicalRequestWritten:false,unchangedForcedRls:false};
  }
 }
 await finish(result,refusal);
 async function stageBeforeImport(){await send({kind:'owner-stage',stage:'late-constructor'});await stopSignal;}
}
