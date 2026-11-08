/** Native lifecycle boundaries only, not50k timings or acceptance. */
import {expect,it,afterAll} from 'vitest';
import {owner,seedBase,adminCtx} from './harness';
import {readEmployeeChoices} from '../core/employee-choice';
import {employeeChoiceBenchmarkOwner} from './performance/employee-choice-benchmark-owner';
import {installEmployeeChoiceNativePrototype,employeeChoicePrototypeSignature,type EmployeeChoiceNativeInstallation} from './performance/employee-choice-native-purpose-owner';
import {employeeChoicePlanLogging,type EmployeeChoicePlanLogging} from './performance/employee-choice-auto-explain';
import {employeeChoiceNativeCaseOwner} from './performance/employee-choice-native-case-owner';
import {admitEmployeeChoiceLifecycle} from './performance/employee-choice-lifecycle-admission';
admitEmployeeChoiceLifecycle('test/employee-choice-benchmark-owner-native.test.ts'); // Before ANY file query; constructors below remain lazy.
const cases=employeeChoiceNativeCaseOwner();
afterAll(()=>cases.drain());
it('owns the exact prototype and settings witness before a rolled-back or lost COMMIT response',context=>cases.run(context,async owned=>{
 const signal=new AbortController(),pools=employeeChoiceBenchmarkOwner(AbortSignal.any([signal.signal,owned.signal]),()=>{},undefined,'native-control');
 let installation:EmployeeChoiceNativeInstallation|undefined,logging:EmployeeChoicePlanLogging|undefined,primary:unknown;
 try{
  const [identity]=await owner.client`select current_database() as database,current_setting('statement_timeout') as statement,current_setting('lock_timeout') as lock`;
  expect(identity.statement).toBe('1s');expect(identity.lock).toBe('300ms');
  const base=await seedBase(),page=await readEmployeeChoices(adminCtx(base),{companyIds:[base.companyId]});
  expect(page.rows).toEqual([]);expect(page.total).toBe(0);expect(page.companyOptions).toEqual([]);
  const rollback=Error('Fixed controlled rollback after native witness adoption');
  await expect(installEmployeeChoiceNativePrototype(value=>{installation=value;throw rollback;})).rejects.toBe(rollback);
  expect(installation).toBeDefined();
  expect((await owner.client`select to_regprocedure('app.employee_choice_native_prototype(uuid,uuid,uuid,text[],jsonb,uuid[],date,uuid[],uuid,uuid,uuid,text,text,text,uuid,bigint,integer,text,text,uuid[])') as present`)[0].present).toBeNull();
  await installation!.remove();
  // Native COMMIT succeeds; simulate the client losing delivery afterwards.
  // The witness was already owned before COMMIT, never reconstructed from a
  // replacement function or a new caller receipt after the error.
  await expect((async()=>{await installEmployeeChoiceNativePrototype(value=>{installation=value;});throw Error('Fixed lost response after COMMIT');})()).rejects.toThrow('lost response');
  await installation!.unchanged();
  await owner.client.unsafe('alter function '+employeeChoicePrototypeSignature+' set jit=on');
  try{
   await expect(installation!.remove()).rejects.toThrow();
   expect((await owner.client`select to_regprocedure(${employeeChoicePrototypeSignature}) is not null as present`)[0].present).toBe(true);
  }finally{await owner.client.unsafe('alter function '+employeeChoicePrototypeSignature+' set jit=off');}
  await installation!.unchanged();
  await expect(employeeChoicePlanLogging(identity.database,value=>{logging=value;throw rollback;})).rejects.toBe(rollback);
  expect(logging).toBeDefined();await logging!.restore();
  await expect((async()=>{await employeeChoicePlanLogging(identity.database,value=>{logging=value;});throw Error('Fixed lost response after logging COMMIT');})()).rejects.toThrow('lost response');
 }catch(error){primary=error;throw error;}finally{
  // The case owns this full restoration even if Vitest has cancelled it.
  // Compound failures are retained; successors poison on uncertain cleanup.
  const errors:unknown[]=[];
  try{owned.enterCleanup();await pools.beginCleanup(owned.cleanupDeadline);}catch(error){errors.push(error);}
  try{await logging?.restore();}catch(error){errors.push(error);}
  try{await installation?.remove();}catch(error){errors.push(error);}
  try{await pools.close();}catch(error){errors.push(error);}
  if(errors.length){if(primary!==undefined)errors.unshift(primary);const error=new AggregateError(errors,'Native benchmark fixture restoration refused');cases.poison(error);throw error;}
 }
}));
it('cancels a real owned blocking transaction and refuses every later SQL/callback before cleanup',context=>cases.run(context,async owned=>{
 const signal=new AbortController(),pools=employeeChoiceBenchmarkOwner(AbortSignal.any([signal.signal,owned.signal]),()=>{},undefined,'native-control');let entered!:()=>void,after=false,primary:unknown,targetPid=0,operation:Promise<unknown>|undefined;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 try{
  const work=owner.client.begin(async tx=>{const [identity]=await tx`select pg_backend_pid() as pid`;targetPid=identity.pid;entered();await tx`select pg_sleep(30)`;after=true;await tx`select 1`;});
  operation=work;void work.catch(()=>{});await Promise.race([ready,work.then(()=>{throw Error('Native blocking transaction ended before admission');})]);
  const started=performance.now();let sleeping=false;
  while(!sleeping&&performance.now()-started<2000){sleeping=(await owner.client`select exists(select 1 from pg_stat_activity where pid=${targetPid} and state='active' and wait_event='PgSleep') as sleeping`)[0].sleeping;if(!sleeping)await new Promise(resolve=>setTimeout(resolve,20));}
  expect(sleeping).toBe(true);signal.abort(Error('Fixed controlled native stop'));
  const failure:unknown=await work.then(()=>undefined,error=>error);expect(failure).toBeInstanceOf(Error);if(!(failure instanceof Error))throw Error('Native stop must reject');expect(Reflect.get(failure,'code')).not.toBe('57014');expect(after).toBe(false);
  expect(()=>owner.client`select 1`).toThrow('frontier');let callback=false;
  expect(()=>owner.client.begin(async()=>{callback=true;})).toThrow('frontier');expect(callback).toBe(false);
 }catch(error){primary=error;throw error;}finally{
  const errors:unknown[]=[];signal.abort(Error('Fixed native case settlement'));try{await pools.stop();}catch(error){errors.push(error);}
  await operation?.catch(()=>{});try{owned.enterCleanup();await pools.beginCleanup(owned.cleanupDeadline);}catch(error){errors.push(error);}
  try{await pools.close();}catch(error){errors.push(error);}
  if(errors.length){if(primary!==undefined)errors.unshift(primary);const error=new AggregateError(errors,'Native stop drain refused');cases.poison(error);throw error;}
 }
}));
