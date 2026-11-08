/** Owned test subprocess. A failed/uncertain drain never authorizes the next reset. */
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import postgres from 'postgres';
import {BRIDGE_SNAPSHOT,type OwnerSnapshot} from './attendance-bridge-owner-catalogue';
import {ownerInput,ownerReport,ownerStage,ownedDatabaseUrls,childEnvironment,type OwnerInput,type OwnerStage} from './attendance-bridge-owner-protocol';
import type {ProofResult} from './attendance-bridge-owner-proof';
import {holdChildPidfd} from './attendance-bridge-pidfd';

export function attendanceOwnerProcess(inputValue:OwnerInput,environment:NodeJS.ProcessEnv,database:string){
 const input=ownerInput(inputValue),tag='bridge_'+randomUUID().replaceAll('-','');
 const urls=ownedDatabaseUrls(environment.TEST_DATABASE_URL!,environment.TEST_MIGRATION_DATABASE_URL!,database,tag);
 let child:ChildProcess|undefined,stopped=false,finished:Promise<void>|undefined,cleanupFailure:unknown;
 let binding:ReturnType<typeof holdChildPidfd>|undefined,inputSent=false;
 let closeResult:Promise<{code:number|null;signal:NodeJS.Signals|null}>|undefined,killTimer:ReturnType<typeof setTimeout>|undefined;
 const stop=()=>{
  stopped=true;
  if(child&&child.exitCode===null&&child.signalCode===null){
   if(!inputSent){if(child.connected)child.disconnect();return;}
   if(child.connected)try{child.send({kind:'stop'},()=>{});}catch{/* Actual exit/kill/drain remains mandatory. */}
   if(!killTimer)killTimer=setTimeout(()=>{if(child&&child.exitCode===null&&child.signalCode===null){
    try{assert(binding);binding.kill();}catch{cleanupFailure=Error('Owned child signal capability uncertain');}
   }},20000);
  }
 };
 const run=()=>{
  assert(!finished&&!stopped);assert.equal(process.platform,'linux');
  const result=Promise.resolve().then(async()=>{
   let observer:postgres.Sql|undefined,baseline:OwnerSnapshot|undefined,report:ProofResult|undefined;
   let workFailure:unknown,refusalStage:OwnerStage|undefined;
   try{
    assert(!stopped);
    const observerUrl=new URL(urls.owner);observerUrl.searchParams.set('application_name',tag+'_observer');
    observerUrl.searchParams.set('connect_timeout','2');observerUrl.searchParams.set('options','-c statement_timeout=2000 -c lock_timeout=300');
    observer=postgres(observerUrl.toString(),{max:1,connect_timeout:2});
    const [before]=await observer.unsafe<{snapshot:OwnerSnapshot}[]>(`select ${BRIDGE_SNAPSHOT} as snapshot`,[input.role]);
    baseline=before.snapshot;assert.equal(baseline.state.role,null);assert(!stopped);
    child=spawn(process.execPath,['--import','tsx',resolve('test/helpers/attendance-bridge-owner-worker.ts')],{
     cwd:process.cwd(),detached:true,env:childEnvironment(environment,urls,process.execPath),stdio:['ignore','ignore','ignore','ipc'],serialization:'json',
    });
    const ownedChild=child;
    let ipcFailure=false;
    closeResult=new Promise(resolveClose=>{
     ownedChild.once('error',()=>{ipcFailure=true;});
     ownedChild.once('close',(code,signal)=>resolveClose({code,signal}));
    });
    assert(ownedChild.pid&&ownedChild.pid>1);
    binding=holdChildPidfd(ownedChild.pid);await binding.ready;assert(!stopped);
    ownedChild.on('message',value=>{
     try{
      assert(value&&typeof value==='object'&&Buffer.byteLength(JSON.stringify(value))<=65536);
      assert('kind'in value);
      if(value.kind==='owner-stage'){
       assert.deepEqual(Object.keys(value).sort(),['kind','stage']);assert('stage'in value);
       assert((input.mode==='stop-late-pool'&&value.stage==='late-constructor')||(input.mode==='stop-fixture'&&value.stage==='fixture-frontier'));
       stop();
      }else if(value.kind==='owner-refusal'){
       assert.deepEqual(Object.keys(value).sort(),['kind','stage']);assert('stage'in value&&!refusalStage&&!report);
       refusalStage=ownerStage(value.stage);
      }else{
       assert(!report&&!refusalStage&&value.kind==='owner-result'&&'report'in value);
       assert.deepEqual(Object.keys(value).sort(),['kind','report']);
       report=ownerReport(value.report);
      }
     }catch{ipcFailure=true;stop();}
    });
    inputSent=true;ownedChild.send(input,error=>{if(error){ipcFailure=true;stop();}});
    const deadline=setTimeout(stop,70000);
    let exited:{code:number|null;signal:NodeJS.Signals|null};
    try{exited=await closeResult;}finally{clearTimeout(deadline);if(killTimer)clearTimeout(killTimer);}
    assert(!ipcFailure&&exited.code===0&&exited.signal===null,'Owned Attendance process failed');
    assert(report&&report.complete&&report.mode===input.mode);
    assert.equal(report.kind,input.mode==='positive'?'ATTENDANCE_OWNER_POSITIVE':'ATTENDANCE_OWNER_FAULT');
    if(input.mode!=='stop-late-pool')assert(report.allCatalogueRestored&&report.roleAbsent);
    if(input.mode==='positive'){
     assert(report.ownedOidCaptured&&!report.faultObserved&&report.nonemptyApprover&&report.canonicalRequestWritten&&report.unchangedForcedRls);
     assert.deepEqual(report.appIdentity,{session:'ai_hr_app',current:'ai_hr_app',super:false,bypass:false});
     assert.deepEqual(report.restrictedIdentity,{name:input.role,super:false,bypass:false,parentSet:false,statementTimeout:'5s',lockTimeout:'300ms'});
    }else assert(report.faultObserved);
   }catch{workFailure=Error(refusalStage?'Owned Attendance child refused at '+refusalStage:'Owned Attendance component execution refused');}
   finally{
    stop();
    try{
     if(closeResult)await closeResult;
     if(killTimer)clearTimeout(killTimer);
     if(binding)await binding.close();
     if(child?.pid){
      const until=Date.now()+1000;let gone=false;
      while(Date.now()<until){try{process.kill(-child.pid,0);}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='ESRCH'){gone=true;break;}throw error;}
       await new Promise(resolveWait=>setTimeout(resolveWait,10));}
      assert(gone,'Owned Attendance process family remains uncertain');
     }
     if(observer&&baseline){
      const [after]=await observer.unsafe<{snapshot:OwnerSnapshot;backends:number}[]>(`select ${BRIDGE_SNAPSHOT} as snapshot,
       (select count(*)::integer from pg_stat_activity where datname=current_database() and application_name=any($2::text[])) as backends`,[input.role,[tag,tag+'_restore']]);
      assert.equal(after.backends,0,'Owned Attendance database work remains unsettled');
      assert.deepEqual(after.snapshot,baseline,'Owned Attendance native catalogue restoration uncertain');
      if(report&&input.mode==='stop-late-pool'){report.allCatalogueRestored=true;report.roleAbsent=after.snapshot.state.role===null;}
     }
    }catch{cleanupFailure=Error('Owned Attendance process/backend/catalogue restoration uncertain');}
    finally{if(observer)try{await observer.end({timeout:1});}catch{cleanupFailure=Error('Owned Attendance observer closure uncertain');}}
   }
   if(cleanupFailure){if(workFailure)cleanupFailure=new AggregateError([workFailure,cleanupFailure],'Owned Attendance work and cleanup refused');throw cleanupFailure;}
   if(workFailure)throw workFailure;
   assert(report);return report;
  });
  finished=result.then(()=>undefined,()=>undefined);void result.catch(()=>undefined);
  return result;
 };
 return{run,stop,stopAndDrain:async()=>{stop();await finished;if(cleanupFailure)throw cleanupFailure;}};
}
