/** Fictional observation/cleanup models only, not native PostgreSQL acceptance. */
import {expect,it} from 'vitest';
import {employeePlanLoggingChanges,employeeRestorationHash as hash,verifyEmployeePrototypeRestoration as prototype,verifyEmployeeLoggingRestoration as logging} from '../.github/ci/employee-restoration-proof.mjs';
import {employeeChoiceAsciiTerminalWitness} from './performance/employee-choice-ascii-terminal-witness';
import {employeeChoiceRestorationCleanup} from './performance/employee-choice-restoration-cleanup';
const database='ai_hr_test_w1',identity={role:'postgres',login:'postgres',database,databaseOid:'321',loopback:true};
function prototypeModel(){
 const metadata={prosecdef:false,provolatile:'s',proparallel:'u',proconfig:['search_path=pg_catalog, pg_temp','jit=off'],pronargs:20,proisstrict:false,proleakproof:false,prokind:'f'};
 const installed={definition:'FICTIONAL complete native definition',identity:{...metadata,oid:'123',proowner:'10',proname:'employee_choice_native_prototype',prosrc:'FICTIONAL complete native body'},...metadata,owner:'postgres',app:true,public:false,acl_count:2};
 const beforeSecurity={functions:[{signature:'app.fictional()',identity:'FICTIONAL unchanged native metadata'}],policies:[],grants:[],roleEdges:[]};
 const expected={database,sourceSha256:'a'.repeat(64),installedSha256:hash(installed),securitySha256:hash(beforeSecurity)};
 const value={version:1,kind:'NATIVE_EMPLOYEE_PROTOTYPE_RESTORATION_NOT_RELEASE',database,identity:{...identity},sourceSha256:expected.sourceSha256,installed,installedSha256:expected.installedSha256,beforeSecurity,afterSecurity:structuredClone(beforeSecurity),beforeSecuritySha256:expected.securitySha256,afterSecuritySha256:expected.securitySha256,securityCounts:{functions:1,policies:0,grants:0,roleEdges:0},signatureAbsent:true,overloads:0};return{value,expected};
}
function loggingModel(before:null|{setdatabase:number;setrole:number;setconfig:string[]}=null){
 const old=before?.setconfig??[],settings=[...old];for(const[key,value]of Object.entries(employeePlanLoggingChanges)){const index=settings.findIndex(entry=>entry.startsWith(key+'='));if(index<0)settings.push(key+'='+value);else settings[index]=key+'='+value;}
 const instrumented={setdatabase:321,setrole:0,setconfig:settings},expected={database,beforeSha256:hash(old),instrumentedSha256:hash(settings)};
 const value={version:1,kind:'NATIVE_EMPLOYEE_LOGGING_RESTORATION_NOT_RELEASE',identity:{...identity},before:structuredClone(before),instrumented,after:structuredClone(before),...expected,beforeNativeSha256:hash(before),instrumentedNativeSha256:hash(instrumented),afterNativeSha256:hash(before)};return{value,expected};
}
const held=()=>{let release!:()=>void;const promise=new Promise<void>(done=>{release=done;});return{promise,release};};
it('verifies a complete bound fictional prototype observation without declaring native authority',()=>{
 const f=prototypeModel();expect(prototype(f.value,f.expected)).toBe(f.value);expect('releaseAuthorized'in f.value).toBe(false);
});
it('refuses missing, partial, extra, named-overload and wrong-carrier prototype claims',()=>{
 const changes:((v:ReturnType<typeof prototypeModel>['value'])=>void)[]=[v=>{Reflect.deleteProperty(v,'beforeSecurity');},v=>{v.signatureAbsent=false;},v=>{v.overloads=1;},v=>{v.securityCounts.functions=0;},v=>{v.identity.role='ai_hr_app';},v=>{v.identity.database='foreign';},v=>{Reflect.set(v,'authenticated',true);}];
 for(const change of changes){const f=prototypeModel();change(f.value);expect(()=>prototype(f.value,f.expected)).toThrow();}
});
it('refuses coherently rehashed installed security changes and retained native metadata drift',()=>{
 const changes:((v:ReturnType<typeof prototypeModel>['value'])=>void)[]=[v=>{v.installed.prosecdef=true;},v=>{v.installed.identity.proconfig=['jit=on'];},v=>{v.installed.owner='foreign';},v=>{v.installed.public=true;}];
 for(const change of changes){const f=prototypeModel();change(f.value);f.value.installedSha256=hash(f.value.installed);f.expected.installedSha256=f.value.installedSha256;expect(()=>prototype(f.value,f.expected)).toThrow();}
 const f=prototypeModel();f.value.afterSecurity.functions[0].identity='CHANGED';f.value.afterSecuritySha256=hash(f.value.afterSecurity);expect(()=>prototype(f.value,f.expected)).toThrow();
});
it('retains native setting-row absence separately from an existing empty logical row',()=>{
 const absent=loggingModel();expect(logging(absent.value,absent.expected)).toBe(absent.value);
 const empty=loggingModel({setdatabase:321,setrole:0,setconfig:[]});empty.value.after=null;empty.value.afterNativeSha256=hash(null);expect(empty.value.beforeSha256).toBe(absent.value.beforeSha256);expect(()=>logging(empty.value,empty.expected)).toThrow();
});
it('preserves unrelated ordered settings and refuses coherently rehashed unknown instrumentation or database identity',()=>{
 const valid=loggingModel({setdatabase:321,setrole:0,setconfig:['application_name=FICTIONAL preserved']});expect(logging(valid.value,valid.expected)).toBe(valid.value);
 const f=loggingModel();f.value.instrumented.setconfig.push('application_name=UNOWNED');f.value.instrumentedSha256=hash(f.value.instrumented.setconfig);f.value.instrumentedNativeSha256=hash(f.value.instrumented);f.expected.instrumentedSha256=f.value.instrumentedSha256;expect(()=>logging(f.value,f.expected)).toThrow();
 const foreign=loggingModel();foreign.value.identity.databaseOid='322';expect(()=>logging(foreign.value,foreign.expected)).toThrow();
});
it('waits for the deferred terminal guard despite abort and still runs the independent guard',async()=>{
 const state=employeeChoiceAsciiTerminalWitness(),started=held(),finish=held(),abort=new AbortController();let settled=false;
 const pending=state.prove('prototype',async()=>{started.release();await finish.promise;}).then(()=>{settled=true;});await started.promise;abort.abort(Error('FICTIONAL abort'));
 await state.prove('logging',async()=>{});expect(settled).toBe(false);expect(state.snapshot()).toEqual({prototype:false,logging:true,complete:false});finish.release();await pending;expect(abort.signal.aborted).toBe(true);expect(state.snapshot().complete).toBe(true); // Cleanup can succeed after work abort; lifetime still independently refuses acceptance.
});
it('telemetry and one cleanup failure cannot skip other mandatory settlement, and distinct errors survive',async()=>{
 const telemetry=Error('FICTIONAL telemetry'),native=Error('FICTIONAL native cleanup'),events:string[]=[],failed:string[]=[];
 const state=employeeChoiceRestorationCleanup(()=>{events.push('telemetry-refused');},name=>failed.push(name));
 expect(await state.run('first',async()=>{events.push('first-work');throw native;},()=>{throw telemetry;})).toBe(false);
 expect(await state.run('second',async()=>{events.push('second-work');},()=>{throw telemetry;})).toBe(true);
 await state.run('pools',async()=>{events.push('closed-pools');},()=>{});expect(events).toContain('first-work');expect(events).toContain('second-work');expect(events.at(-1)).toBe('closed-pools');expect(failed).toEqual(['first']);expect(state.failures).toEqual([telemetry,native]);
});
it('revalidates every new postimage rather than inheriting an earlier successful observation',()=>{
 const first=prototypeModel();prototype(first.value,first.expected);const next=prototypeModel();next.value.overloads=1;expect(()=>prototype(next.value,next.expected)).toThrow();
 const before=loggingModel();logging(before.value,before.expected);const later=loggingModel();later.value.after={setdatabase:321,setrole:0,setconfig:['application_name=CHANGED']};later.value.afterNativeSha256=hash(later.value.after);expect(()=>logging(later.value,later.expected)).toThrow();
});
