/** Pure ownership models and a real unprivileged Linux child; no application/DB calls. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {expect,it} from 'vitest';
import {AttendanceBridgeOwnedPhases} from './helpers/attendance-bridge-owned-phase';
import {OwnerWorkFrontier,childEnvironment,ownedDatabaseUrls,ownerReport,ownerStage,OwnerRefusal} from './helpers/attendance-bridge-owner-protocol';
import {assertOwnedRole,type OwnerSnapshot} from './helpers/attendance-bridge-owner-catalogue';
import {directChildIdentity,holdChildPidfd,pidfdOutput} from './helpers/attendance-bridge-pidfd';

const gate=()=>{let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve;});return{promise,open};};
it('registers a late constructor, stops every next callback and waits for its actual resource closure',async()=>{
 const frontier=new OwnerWorkFrontier(),construct=gate(),closed=gate(),calls:string[]=[];
 const pool={end:()=>{calls.push('close');return closed.promise;}};
 const pending=frontier.construct(async()=>{calls.push('construct');await construct.promise;return pool;},value=>[value]);
 const rejected=expect(pending).rejects.toThrow('work stopped');
 frontier.stop();let drained=false;const drain=frontier.closeAll().then(()=>{drained=true;});
 await Promise.resolve();expect(drained).toBe(false);construct.open();await rejected;expect(calls).toEqual(['construct','close']);
 expect(drained).toBe(false);await expect(frontier.step(async()=>{calls.push('forbidden');})).rejects.toThrow('work stopped');
 closed.open();await drain;expect(drained).toBe(true);expect(calls).toEqual(['construct','close']);
});
it('propagates stop before the next fixture callback and holds reset until complete child restoration',async()=>{
 const frontier=new OwnerWorkFrontier(),phases=new AttendanceBridgeOwnedPhases(),entered=gate(),release=gate(),restoring=gate(),restored=gate(),calls:string[]=[];
 const phase=phases.start(async()=>{
  await frontier.step(async()=>{entered.open();await release.promise;calls.push('admitted-work-settled');});
  await frontier.step(async()=>{calls.push('forbidden-fixture-call');});
 },async()=>{await frontier.closeAll();restoring.open();await restored.promise;calls.push('native-restoration');},()=>frontier.stop());
 await entered.promise;const rejection=expect(phase.result).rejects.toThrow('work stopped');let drained=false;
 const hook=phase.stopAndDrain().then(()=>{drained=true;});release.open();await restoring.promise;
 expect(()=>phases.assertReady()).toThrow('unsettled');expect(drained).toBe(false);restored.open();await rejection;await hook;
 expect(calls).toEqual(['admitted-work-settled','native-restoration']);phases.assertReady();
});
it('a failed actual resource close poisons every later checkout after settlement',async()=>{
 const frontier=new OwnerWorkFrontier(),phases=new AttendanceBridgeOwnedPhases(),failure=Error('Uncertain owned close');
 frontier.adopt({end:()=>Promise.reject(failure)});
 const phase=phases.start(async()=>{},()=>frontier.closeAll(),()=>frontier.stop());
 await expect(phase.result).rejects.toBe(failure);await expect(phase.stopAndDrain()).rejects.toBe(failure);
 expect(()=>phases.start(async()=>{},async()=>{})).toThrow(failure);
});
it('requires the actual OID, complete flags, incident memberships and owned objects before restoration',()=>{
 const witness:OwnerSnapshot={state:{role:{oid:123,facts:{rolname:'bridge_owner_'+ 'a'.repeat(32),rolsuper:false}},memberships:[{roleid:5,member:123,inherit_option:true,set_option:false}],request:{owner:'bridge_owner_'+ 'a'.repeat(32),ownerOid:123},functions:[{oid:12,signature:'app.example()',owner:'bridge_owner_'+ 'a'.repeat(32),facts:{proowner:123}}],bindings:[]},body:'reviewed'};
 expect(()=>assertOwnedRole(structuredClone(witness),witness,['reviewed'])).not.toThrow();
 const oid=structuredClone(witness);assert(oid.state.role);oid.state.role.oid=456;
 const flags=structuredClone(witness);assert(flags.state.role);flags.state.role.facts.rolsuper=true;
 const membership=structuredClone(witness);membership.state.memberships[0].set_option=true;
 const relation=structuredClone(witness);relation.state.request.ownerOid=456;
 const fn=structuredClone(witness);fn.state.functions[0].facts.proowner=456;
 const body=structuredClone(witness);body.body='unknown';
 for(const current of [oid,flags,membership,relation,fn,body])expect(()=>assertOwnedRole(current,witness,['reviewed'])).toThrow();
 const absent=structuredClone(witness);absent.state.role=null;expect(()=>assertOwnedRole(witness,absent,['reviewed'])).toThrow();
});
it('closes inherited credentials and refuses non-worker, foreign host, role and arbitrary SQL startup options',()=>{
 const tag='bridge_'+ 'a'.repeat(32),app='postgres://ai_hr_app:fictional@127.0.0.1/ai_hr_test_w1',owner='postgres://postgres:fictional@127.0.0.1/ai_hr_test_w1';
 const urls=ownedDatabaseUrls(app,owner,'ai_hr_test_w1',tag);
 const env=childEnvironment({GH_TOKEN:'private',SSH_AUTH_SOCK:'private',PGPASSWORD:'private',OWNER_DATABASE_URL:'private',CI:'true'},urls,'/opt/node/bin/node');
 expect(Object.keys(env).sort()).toEqual(['PATH','HOME','LANG','LC_ALL','TZ','NODE_ENV','DATABASE_URL','TEST_DATABASE_URL','MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL','WORKER_DB','CI'].sort());
 expect(env.PATH).toBe('/opt/node/bin:/usr/bin:/bin');expect(env.DATABASE_URL).toBe(urls.app);
 for(const value of [app.replace('127.0.0.1','foreign.invalid'),app.replace('ai_hr_app','postgres'),app+'?options=-c+role%3Dpostgres',app.replace('ai_hr_test_w1','ai_hr_dev'),app+'#private'])expect(()=>ownedDatabaseUrls(value,owner,'ai_hr_test_w1',tag)).toThrow('Closed owned Attendance database capability required');
 expect(()=>ownerReport({kind:'ATTENDANCE_OWNER_FAULT',private:'private'})).toThrow();
 expect(new OwnerRefusal(ownerStage('access-catalogue')).stage).toBe('access-catalogue');
 for(const value of ['private TOKEN=fictional',{},null]){
  let refusal:unknown;try{ownerStage(value);}catch(error){refusal=error;}
  expect(refusal).toBeInstanceOf(Error);if(!(refusal instanceof Error))throw Error('Closed owner stage must refuse');
  expect(refusal.message).toBe('Unknown closed owner stage');expect(refusal.message).not.toContain('TOKEN=');
 }
});
it('binds a real detached direct child to a kernel pidfd while stale-start and foreign-parent controls cannot signal it',async()=>{
 expect(process.platform).toBe('linux');expect(process.getuid?.()).not.toBe(0);
 const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),5000)'],{detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin'}});
 const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(yes=>{child.once('error',()=>{});child.once('close',(code,signal)=>yes({code,signal}));});
 let held:ReturnType<typeof holdChildPidfd>|undefined,bound=false;const failures:unknown[]=[];
 try{
  assert(child.pid);held=holdChildPidfd(child.pid);await held.ready;bound=true;const identity=directChildIdentity(child.pid);
  for(const args of [[identity.parent, String(BigInt(identity.start)+BigInt(1))],[identity.parent+1,identity.start]]as const){
   const probe=spawn('/usr/bin/python3',['-I','-B',resolve('test/helpers/attendance-bridge-pidfd.py'),String(identity.pid),String(args[0]),args[1]],{env:{PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','pipe']});
   let stdout='',stderr='',invalid=false;const result=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(yes=>{probe.once('error',()=>{invalid=true;});probe.once('close',(code,signal)=>yes({code,signal}));});
   probe.stdout.on('data',(chunk:Buffer)=>{if(stdout.length+chunk.length>128){invalid=true;return;}stdout+=chunk.toString('ascii');});
   probe.stderr.on('data',(chunk:Buffer)=>{if(stderr.length+chunk.length>128){invalid=true;return;}stderr+=chunk.toString('ascii');});probe.stdin.on('error',()=>{});probe.stdin.end('KILL\n');
   expect(await result).toEqual({code:1,signal:null});expect(invalid).toBe(false);expect(stdout).toBe('');expect(stderr).toBe('Owned child binding refused\n');
   expect(directChildIdentity(identity.pid)).toEqual(identity);
  }
  held.kill();held.kill();expect(await exited).toEqual({code:null,signal:'SIGKILL'});await held.close();held.kill();held=undefined;
 }catch(error){failures.push(error);}
 finally{
  try{if(held&&bound)held.kill();}catch(error){failures.push(error);}
  try{await exited;}catch(error){failures.push(error);}
  try{if(held)await held.close();}catch(error){failures.push(error);}
 }
 if(failures.length>1)throw new AggregateError(failures,'Owned pidfd control and cleanup failed');
 if(failures.length)throw failures[0];
},10000);
it('a closed unused pidfd never gains authority to signal the still-live original child',async()=>{
 expect(process.platform).toBe('linux');expect(process.getuid?.()).not.toBe(0);
 const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),2500)'],{detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin'}});
 const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(yes=>{child.once('error',()=>{});child.once('close',(code,signal)=>yes({code,signal}));});
 let held:ReturnType<typeof holdChildPidfd>|undefined;const failures:unknown[]=[];
 try{
  assert(child.pid);held=holdChildPidfd(child.pid);await held.ready;const identity=directChildIdentity(child.pid);
  const released=held;await released.close();held=undefined;
  expect(()=>released.kill()).toThrow('pidfd is not bound');expect(directChildIdentity(identity.pid)).toEqual(identity);
  expect(await exited).toEqual({code:0,signal:null});
 }catch(error){failures.push(error);}
 finally{try{await exited;}catch(error){failures.push(error);}try{if(held)await held.close();}catch(error){failures.push(error);}}
 if(failures.length>1)throw new AggregateError(failures,'Closed pidfd control and cleanup failed');
 if(failures.length)throw failures[0];
},10000);
it('accepts the complete signal acknowledgement at every chunk boundary while extra, reordered, unsolicited and non-ASCII bytes refuse',()=>{
 const complete=Buffer.from('BOUND\nSIGNALLED\n','ascii');
 for(let split=0;split<=complete.length;split++){
  const first=pidfdOutput('',complete.subarray(0,split),true);
  expect(pidfdOutput(first,complete.subarray(split),true)).toBe('BOUND\nSIGNALLED\n');
 }
 for(const raw of [Buffer.from('BOUND\nSIGNALLED\nX'),Buffer.from('SIGNALLED\nBOUND\n'),Buffer.from('BOUND\nBOUND\n'),Buffer.from([0xc2,0x4f,0x55,0x4e,0x44,0x0a])])expect(()=>pidfdOutput('',raw,true)).toThrow();
 expect(()=>pidfdOutput('',complete,false)).toThrow();
 expect(pidfdOutput('',Buffer.from('BOUND\n'),false)).toBe('BOUND\n');
});
