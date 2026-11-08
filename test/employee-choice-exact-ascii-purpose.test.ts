import {admitEmployeeChoiceLifecycle} from './performance/employee-choice-lifecycle-admission';
/** Actual app LOGIN/RLS and borrowed native RRRO controls; no mocked data or providers. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,realpathSync,lstatSync,existsSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {employeeChoiceBenchmarkOwner} from './performance/employee-choice-benchmark-owner';
import {employeeChoicePrototypeCarriers} from './performance/employee-choice-prototype-carriers';
import {employeeChoiceReadFrontier} from './performance/employee-choice-sql-frontier';
import {exactAsciiEmployeeChoiceOwner,type ExactAsciiInstallation,type ExactAsciiOwnership} from './performance/employee-choice-exact-ascii-owner-factory';
import {employeeChoicePrototypeSignature} from './performance/employee-choice-native-purpose-owner-factory';
import {employeeChoiceBenchmarkLifetime} from './performance/employee-choice-benchmark-lifetime';
import {preserveDiagnosticFailure} from './performance/employee-choice-native-purpose-session';
import {sql,type SQL} from 'drizzle-orm';
import {afterAll,beforeEach,expect,it,vi,type TestContext} from 'vitest';
import * as database from '../db/client';
import * as current from '../core/employee-choice';
import * as prototype from './performance/employee-choice-exact-ascii-reader';
import {nativeEmployeeChoiceQuery} from './performance/employee-choice-native-purpose-reader';
import * as legacy from './performance/employee-choice-native-purpose-reader';
import {exactAsciiPrototypeRuntimeEvidence,closeExactAsciiPrototypeRuntime} from './performance/employee-choice-exact-ascii-runtime';
import {createAssignmentAuthorityFixture,assertAssignmentAuthority} from './performance/employee-choice-assignment-authority';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
const file='test/employee-choice-exact-ascii-purpose.test.ts',lifecycle=admitEmployeeChoiceLifecycle(file);
let installation:ExactAsciiInstallation|undefined,b:Base,started=false;
let ownedPools:ReturnType<typeof employeeChoiceBenchmarkOwner>|undefined,metadata:ReturnType<typeof employeeChoicePrototypeCarriers>|undefined;
const custodies=new Set<ExactAsciiOwnership>();
const realWithTenant=database.withTenant,lifetime=employeeChoiceBenchmarkLifetime(async()=>{const results=await Promise.allSettled([ownedPools?.stop(),metadata?.stop()]);const errors=results.filter(value=>value.status==='rejected');if(errors.length)throw new AggregateError(errors,'Owned ASCII purpose work stop refused');},()=>{});
function bounded(context:TestContext,name:string,work:()=>Promise<void>){
 const abort=()=>lifetime.stop('case-aborted');context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
 const pending=lifetime.run(name,work);context.onTestFinished(async()=>{try{await pending.catch(()=>{});await lifetime.drain();}finally{context.signal.removeEventListener('abort',abort);}});return pending;
}
function nativeIt(name:string,work:()=>Promise<void>,timeout=30000){it(name,context=>bounded(context,name,async()=>{
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:database.SessionContext,run:(tx:database.Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>{
  lifetime.active();if(!ownedPools)throw Error('Owned ASCII application carrier missing');return ownedPools.watchWork(realWithTenant(ctx,tx=>ownedPools!.ownWork(async()=>{lifetime.active();await tx.execute(sql`set local statement_timeout='20s'`);await tx.execute(sql`set local lock_timeout='300ms'`);return run(employeeChoiceReadFrontier(tx,()=>lifetime.active()));}),options?.readOnlySnapshot?{...options,readSignal:lifetime.signal}:options));
 });
 await preserveDiagnosticFailure(work,async()=>{spy.mockRestore();});
}),timeout);}
it('constructs the guarded unchanged-grant native experiment under an owned300s lifetime',context=>{
 started=true;const startNs=process.hrtime.bigint();lifetime.start(Number(startNs)/1e6);return bounded(context,'construction',async()=>{
  try{
   const base=lifecycle.evidenceDirectory;expect(realpathSync(base)).toBe(base);expect(lstatSync(base).uid).toBe(process.getuid!());
   const output=join(base,'employee-choice-exact-ascii-purpose');mkdirSync(output,{mode:0o700});
   const clock={version:1,run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,startNs:String(startNs)};
   writeFileSync(join(output,'benchmark-clock.pending'),JSON.stringify(clock),{flag:'wx',mode:0o600});renameSync(join(output,'benchmark-clock.pending'),join(output,'benchmark-clock.json'));
   const ack=join(output,'benchmark-clock-ack.json'),waiting=performance.now();
   while(!existsSync(ack)){if(performance.now()-waiting>3000)throw Error('External ASCII purpose full-envelope admission missing');await new Promise(resolve=>setTimeout(resolve,20));}expect(JSON.parse(readFileSync(ack,'utf8'))).toEqual(clock);
   ownedPools=employeeChoiceBenchmarkOwner(lifetime.signal,()=>{},()=>lifetime.active());metadata=employeeChoicePrototypeCarriers(lifetime.signal,()=>lifetime.active());
   expect(exactAsciiPrototypeRuntimeEvidence().status).toBe('uninitialized');await migrateTestDb();lifetime.active();await metadata.identity();
   const native=exactAsciiEmployeeChoiceOwner(metadata.getQuery,metadata.getPhase);
   // Expected actual rollback controls settle before another install. No close
   // failure or cause-chain SQLSTATE is consumed as a successful refusal.
   for(const target of ['original','candidate']as const){
    const sentinel=Error('Fixed ASCII '+target+' preCOMMIT rollback'),owned:{value?:ExactAsciiOwnership}={},phases:string[]=[];
    await expect(native.install((value,phase)=>{owned.value=value;custodies.add(value);phases.push(phase);if(phase===target)throw sentinel;})).rejects.toBe(sentinel);
    expect(phases).toEqual(target==='original'?['original']:['original','candidate']);if(!owned.value)throw Error('PreCOMMIT ASCII custody missing');await owned.value.remove();
    expect((await metadata.getQuery()`select to_regprocedure(${employeeChoicePrototypeSignature})as present`)[0].present).toBeNull();
   }
   const delivery=Error('Fixed ASCII lost return AFTER actual COMMIT');
   await expect((async()=>{installation=await native.install(value=>{custodies.add(value);});throw delivery;})()).rejects.toBe(delivery);
   if(!installation)throw Error('Actual committed ASCII result unavailable');await installation.unchanged();
   // Only fixture metadata is altered. Unknown state must remain present and
   // cannot authorize guessed restoration/drop through the retained witness.
   const installed=installation,last=[...custodies].at(-1);if(!last)throw Error('Committed ASCII custody missing');
   const detached=last.witness();detached.original.identity.prosrc='fixed foreign report mutation';expect(last.witness().original.identity.prosrc).not.toBe(detached.original.identity.prosrc);await installed.unchanged();
   await metadata.getQuery().unsafe('alter function '+employeeChoicePrototypeSignature+' set jit=on');
   try{await expect(last.remove()).rejects.toThrow();expect((await metadata.getQuery()`select to_regprocedure(${employeeChoicePrototypeSignature})is not null as present`)[0].present).toBe(true);}
   finally{await metadata.getQuery().unsafe('alter function '+employeeChoicePrototypeSignature+' set jit=off');}await installed.unchanged();
   const body=installed.installed.identity.prosrc;if(typeof body!=='string'||installed.installed.definition.split(body).length!==2)throw Error('Exact owned candidate body boundary required');
   await metadata.getQuery().unsafe(installed.installed.definition.replace(body,body+'\n-- fixed hostile native body\n'));
   try{await expect(last.remove()).rejects.toThrow();expect((await metadata.getQuery()`select to_regprocedure(${employeeChoicePrototypeSignature})is not null as present`)[0].present).toBe(true);}
   finally{await metadata.getQuery().unsafe(installed.installed.definition);}await installed.unchanged();
   expect(exactAsciiPrototypeRuntimeEvidence().status).toBe('uninitialized');
  }catch(error){lifetime.stop('setup-failed');throw error;}
 });
},300000);
beforeEach(context=>{
 if(!started)return;lifetime.active();if(!installation||!ownedPools)throw Error('Unknown exact ASCII construction; successor refused');ownedPools.installCarrier();
 return bounded(context,'fixture-reset',async()=>{await resetDb();lifetime.active();b=await seedBase();});
});
afterAll(()=>lifetime.finish(async()=>{
 const errors:unknown[]=[],finish=async(work:()=>Promise<unknown>)=>{try{await work();return true;}catch(error){errors.push(error);return false;}};
 const deadline=Number(process.hrtime.bigint())/1e6+Math.min(26000,Math.max(0,900000-lifetime.snapshot().elapsedMs));
 const setupReady=await finish(async()=>{if(!ownedPools)throw Error('Owned setup unavailable');await ownedPools.beginCleanup(deadline);});
 const metadataReady=await finish(async()=>{if(!metadata)throw Error('Owned metadata unavailable');await metadata.beginCleanup(deadline);});
 if(setupReady&&metadataReady){for(const value of [...custodies].reverse())await finish(()=>value.remove());}
 else errors.push(Error('Global native cleanup handoff refused; semantic restoration not admitted'));
 // Preserve the actual closed runtime observation BEFORE shutdown replaces its
 // reason. A reporter failure remains a failure and cannot skip any cleanup.
 await finish(async()=>{
  const value=JSON.stringify({kind:'ACTUAL_ASCII_RUNTIME_OBSERVATION_NOT_QUALIFICATION',runtime:exactAsciiPrototypeRuntimeEvidence(),releaseAuthorized:false})+'\n';
  if(Buffer.byteLength(value)>16384)throw Error('Closed runtime observation exceeds bound');
  writeFileSync(join(lifecycle.evidenceDirectory,'employee-choice-exact-ascii-purpose','runtime-before-shutdown.json'),value,{flag:'wx',mode:0o600});
 });
 await finish(async()=>{closeExactAsciiPrototypeRuntime();});await finish(async()=>metadata?.close());await finish(closeAll);await finish(async()=>ownedPools?.close());
 if(errors.length)throw new AggregateError(errors,'Owned ASCII purpose restoration and settlement refused');
}));
const stable=({contextId:_contextId,...page}:Awaited<ReturnType<typeof current.readEmployeeChoices>>)=>page;
const actor=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const prepared=(limit=25,offset=0)=>({filters:{query:'',companyId:'',departmentId:'',businessUnitId:'',status:''},offset,limit,labelMode:'names' as const,q:''});

nativeIt('matches the actual current root across native role/history/current-company/revocation and unrelated bank controls',async()=>{
 const fixture=await createAssignmentAuthorityFixture(),expected=await assertAssignmentAuthority(fixture);
 const port=vi.spyOn(current,'readEmployeeChoices').mockImplementation(prototype.readEmployeeChoices);
 try{expect(await assertAssignmentAuthority(fixture)).toEqual(expected);}finally{port.mockRestore();}
 await installation!.unchanged();
},120000);

nativeIt('restores JIT within the same borrowed native transaction after success and savepoint error, including a queued sibling',async()=>{
 const ctx=actor(),input={companyIds:[b.companyId]};
 const events=await owner.client`select md5(coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb)::text) as hash from domain_event e`;
 await database.withTenant(ctx,async tx=>{
  const [before]=await tx.execute<{role:string;login:string;pid:number;jit:string;isolation:string;mode:string;advisory:boolean}>(sql`select current_user as role,session_user as login,pg_backend_pid() as pid,
   current_setting('jit') as jit,current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as mode,
   exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted) as advisory`);
  expect(before).toMatchObject({role:'ai_hr_app',login:'ai_hr_app',jit:'on',isolation:'repeatable read',mode:'on',advisory:false});
  const [page,sibling]=await Promise.all([prototype.readEmployeeChoicesTx(tx,ctx,input),tx.execute<{jit:string}>(sql`select current_setting('jit') as jit`)]);
  expect(page.total).toBe(0);expect(sibling[0].jit).toBe('on');
  await expect(tx.transaction(inner=>inner.execute(nativeEmployeeChoiceQuery(ctx,input,prepared(0),'page')))).rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='22023');
  const [after]=await tx.execute<{pid:number;jit:string;mode:string}>(sql`select pg_backend_pid() as pid,current_setting('jit') as jit,current_setting('transaction_read_only') as mode`);
  expect(after).toEqual({pid:before.pid,jit:before.jit,mode:'on'});
  expect((await prototype.readEmployeeChoicesTx(tx,ctx,input)).total).toBe(0);
 },{readOnlySnapshot:true});
 expect(await owner.client`select md5(coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb)::text) as hash from domain_event e`).toEqual(events);
 await installation!.unchanged();
});

nativeIt('natively refuses wrong actor/person and read-committed callers before exposing any purpose data',async()=>{
 const ctx=actor(),input={companyIds:[b.companyId]};
 for(const altered of [{...ctx,userId:randomUUID()},{...ctx,tenantId:randomUUID()},{...ctx,personId:randomUUID()}]){
  await expect(database.withTenant(ctx,tx=>tx.execute(nativeEmployeeChoiceQuery(altered,input,prepared(),'page')),{readOnlySnapshot:true}))
   .rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='42501');
 }
 await expect(database.withTenant(ctx,tx=>tx.execute(nativeEmployeeChoiceQuery(ctx,input,prepared(),'page'))))
  .rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='42501');
 await expect(database.withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.agent_principal_id',${randomUUID()},true)`);
  return tx.execute(nativeEmployeeChoiceQuery(ctx,input,prepared(),'page'));},{readOnlySnapshot:true}))
  .rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='42501');
 expect((await prototype.readEmployeeChoices(ctx,input)).rows).toEqual([]);
 await installation!.unchanged();
});

nativeIt('keeps candidate matching and exact native projection in one snapshot and independently re-admits every submitted identity',async()=>{
 const f=await createAssignmentAuthorityFixture(),input={companyIds:[f.b.companyId],query:'fictional',selectedId:f.gamma.id};
 await database.withTenant(f.employeeCtx,async tx=>{
  const observe=async()=>(await tx.execute(sql`select pg_backend_pid()as pid,txid_current_snapshot()::text as snapshot,
   current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as mode`))[0];
  const before=await observe(),page=await prototype.readEmployeeChoicesTx(tx,f.employeeCtx,input);
  expect(exactAsciiPrototypeRuntimeEvidence()).toMatchObject({status:'qualified',scalarCount:1112063,contexts:85});
  expect(page.rows.map(row=>row.employmentId)).toEqual([f.alpha.id]);expect(page.total).toBe(1);expect(page.selected).toBeNull();
  expect(await observe()).toEqual(before);expect(before).toMatchObject({isolation:'repeatable read',mode:'on'});
  const projected=await tx.execute(nativeEmployeeChoiceQuery(f.employeeCtx,input,prepared(),'project',[f.alpha.id,f.gamma.id,randomUUID()]));
  expect(projected.filter(row=>row.kind==='count').map(row=>row.total)).toEqual([1]);
  expect(projected.filter(row=>row.kind==='candidate').map(row=>row.employmentId)).toEqual([f.alpha.id]);
 },{readOnlySnapshot:true});
 await database.withTenant(f.ctx,async tx=>{
  const scope={companyIds:[f.b.companyId],employmentIds:[f.alpha.id]};
  const projected=await tx.execute(nativeEmployeeChoiceQuery(f.ctx,scope,prepared(),'project',[f.alpha.id,f.gamma.id]));
  expect(projected.filter(row=>row.kind==='count').map(row=>row.total)).toEqual([1]);
  expect(projected.filter(row=>row.kind==='candidate').map(row=>row.employmentId)).toEqual([f.alpha.id]);
 },{readOnlySnapshot:true});
 await installation!.unchanged();
},120000);

nativeIt('natively rejects malformed closed parameters and bypassed label admission without altering sibling settings',async()=>{
 const ctx=actor();
 const call=(args:{roles?:SQL;grants?:SQL;companyScope?:SQL;employeeScope?:SQL;date?:SQL;mode?:SQL;pattern?:SQL;offset?:SQL;limit?:SQL;label?:SQL;port?:SQL;matched?:SQL}={})=>
  sql`select * from app.employee_choice_native_prototype(${ctx.tenantId}::uuid,${ctx.userId}::uuid,null::uuid,
   ${args.roles??sql`array['hr_admin']::text[]`},${args.grants??sql`${JSON.stringify(ctx.grants)}::jsonb`},
   ${args.companyScope??sql`array[${b.companyId}::uuid]`},${args.date??sql`null::date`},${args.employeeScope??sql`null::uuid[]`},
   null::uuid,null::uuid,null::uuid,''::text,${args.mode??sql`'none'::text`},${args.pattern??sql`null::text`},null::uuid,
   ${args.offset??sql`0::bigint`},${args.limit??sql`25::integer`},${args.label??sql`'names'::text`},${args.port??sql`'page'::text`},${args.matched??sql`null::uuid[]`})`;
 const malformed=[{roles:sql`null::text[]`},{roles:sql`array[['hr_admin']]::text[]`},
  {companyScope:sql`null::uuid[]`},{companyScope:sql`array[null]::uuid[]`},{employeeScope:sql`array[[${b.companyId}::uuid]]`},
  {grants:sql`'{}'::jsonb`},{grants:sql`'[1]'::jsonb`},{grants:sql`'[ {"role":"hr_admin","companyId":null,"extra":true} ]'::jsonb`},
  {date:sql`'infinity'::date`},{date:sql`'0001-01-01 BC'::date`},{date:sql`'10000-01-01'::date`},
  {mode:sql`'arbitrary'::text`},{mode:sql`'ascii'::text`},{pattern:sql`'%x%'::text`},
  {offset:sql`9007199254740992::bigint`},{limit:sql`2001::integer`},{label:sql`'arbitrary'::text`},{port:sql`'arbitrary'::text`},
  {port:sql`'project'::text`},{matched:sql`array[]::uuid[]`},{port:sql`'project'::text`,matched:sql`array[null]::uuid[]`},
  {port:sql`'project'::text`,matched:sql`array[[${b.companyId}::uuid]]`},{port:sql`'project'::text`,matched:sql`array[${b.companyId}::uuid,${b.companyId}::uuid]`}];
 await database.withTenant(ctx,async tx=>{
  const [before]=await tx.execute<{pid:number;jit:string}>(sql`select pg_backend_pid() as pid,current_setting('jit') as jit`);
  for(const args of malformed){
   await expect(tx.transaction(inner=>inner.execute(call(args)))).rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='22023');
   expect((await tx.execute(sql`select pg_backend_pid() as pid,current_setting('jit') as jit`))[0]).toEqual(before);
  }
  expect((await tx.execute(call())).map(row=>row.kind)).toEqual(['count']);
 },{readOnlySnapshot:true});
 const authority=await createAssignmentAuthorityFixture();
 await expect(database.withTenant(authority.employeeCtx,tx=>tx.execute(nativeEmployeeChoiceQuery(authority.employeeCtx,{companyIds:[]},
  {...prepared(),labelMode:'labels'},'page')),{readOnlySnapshot:true})).rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='42501');
 const requested={companyIds:[authority.b.companyId],labelMode:'labels' as const};
 expect(stable(await prototype.readEmployeeChoices(authority.ctx,requested))).toEqual(stable(await current.readEmployeeChoices(authority.ctx,requested)));
 await installation!.unchanged();
},120000);

nativeIt('preserves server All2000, complete IDs beyond2000, empty population and independent selection against exact current-root facts',async()=>{
 const ctx=actor(),count=2105,personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24);
 await owner.client.begin(async tx=>{
  await tx`insert into person(id,tenant_id,full_name,primary_email) select (${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,
   'Fictional native '||lpad(n::text,5,'0'),(${personPrefix}||lpad(n::text,12,'0'))||'@example.invalid' from generate_series(1,${count}::int)n`;
  await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,terminated_on)
   select (${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,
    'NATIVE-'||lpad(n::text,5,'0'),'2020-01-01'::date,case n when 1 then '2024-01-01'::date when 2 then '2025-01-01'::date else null::date end from generate_series(1,${count}::int)n`;
  await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,valid_from,employment_type)
   select ${b.tenantId}::uuid,(${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,${b.deptA}::uuid,'2020-01-01'::date,'full_time' from generate_series(1,${count}::int)n`;
 });
 const ids=Array.from({length:count},(_,index)=>employmentPrefix+String(index+1).padStart(12,'0')),selectedId=ids.at(-1)!;
 const input={companyIds:[b.companyId],limit:2000,selectedId};
 const before=await owner.client`select md5(coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb)::text) as hash from employment e`;
 const expected=await database.withTenant(ctx,tx=>current.readEmployeeChoicesTx(tx,ctx,input),{readOnlySnapshot:true});
 const actual=await database.withTenant(ctx,tx=>prototype.readEmployeeChoicesTx(tx,ctx,input),{readOnlySnapshot:true});
 expect(stable(actual)).toEqual(stable(expected));expect(actual.rows.map(row=>row.employmentId)).toEqual(ids.slice(0,2000));expect(actual.total).toBe(count);expect(actual.selected?.employmentId).toBe(selectedId);
 const complete=await database.withTenant(ctx,tx=>prototype.readEmployeeChoiceIdsTx(tx,ctx,{companyIds:[]}),{readOnlySnapshot:true});expect(complete).toEqual(ids);
 // Independent seed identity order checks both nearer-end directions, exact and
 // partial last pages, the middle, All2000, overrun and MAX_SAFE offsets.
 const ranges:readonly[number,number][]=[[0,25],[1000,25],[2000,25],[2090,25],[2104,25],[2105,25],[Number.MAX_SAFE_INTEGER,25],[105,2000],[2104,2000]];
 for(const [offset,limit]of ranges){
  const request={...input,offset,limit},old=await database.withTenant(ctx,tx=>current.readEmployeeChoicesTx(tx,ctx,request),{readOnlySnapshot:true}),
   next=await database.withTenant(ctx,tx=>prototype.readEmployeeChoicesTx(tx,ctx,request),{readOnlySnapshot:true});
  expect(stable(next)).toEqual(stable(old));expect(next.rows.map(row=>row.employmentId)).toEqual(ids.slice(offset,offset+limit));
  expect(next.total).toBe(count);expect(next.selected?.employmentId).toBe(selectedId);expect(next.companyOptions.map(row=>row.id)).toEqual([b.companyId]);expect(next.departmentOptions.map(row=>row.id)).toEqual([b.deptA]);
 }
 // Reversed and duplicate server IDs remain membership, never page order or
 // multiplicity; undefined (nativeNULL) and explicit empty keep distinct meaning.
 for(const employmentIds of [ids.slice().reverse(),[ids[2],ids[0],ids[0]],[]]){
  const request={...input,employmentIds},old=await database.withTenant(ctx,tx=>current.readEmployeeChoicesTx(tx,ctx,request),{readOnlySnapshot:true}),
   next=await database.withTenant(ctx,tx=>prototype.readEmployeeChoicesTx(tx,ctx,request),{readOnlySnapshot:true});
  expect(stable(next)).toEqual(stable(old));expect(next.total).toBe(new Set(employmentIds).size);
  expect(await database.withTenant(ctx,tx=>prototype.readEmployeeChoiceIdsTx(tx,ctx,request),{readOnlySnapshot:true})).toEqual(ids.filter(id=>employmentIds.includes(id)));
 }

 await expect(prototype.readEmployeeChoices(ctx,input)).rejects.toThrow('Invalid employee page');
 const empty=await database.withTenant(ctx,tx=>prototype.readEmployeeChoicesTx(tx,ctx,{...input,employmentIds:[]}),{readOnlySnapshot:true});
 expect(empty.total).toBe(0);expect(empty.rows).toEqual([]);expect(empty.selected).toBeNull();expect(empty.companyOptions).toEqual([]);
 const cutoff={...input,terminatedAfter:'2024-01-01',employmentIds:ids.slice(0,3)};
 const narrow=await database.withTenant(ctx,tx=>prototype.readEmployeeChoicesTx(tx,ctx,cutoff),{readOnlySnapshot:true});
 const oldNarrow=await database.withTenant(ctx,tx=>current.readEmployeeChoicesTx(tx,ctx,cutoff),{readOnlySnapshot:true});
 expect(stable(narrow)).toEqual(stable(oldNarrow));expect(narrow.rows.map(row=>row.employmentId)).toEqual(ids.slice(1,3));expect(narrow.selected).toBeNull();
 const pastPage=await database.withTenant(ctx,tx=>prototype.readEmployeeChoicesTx(tx,ctx,{...input,offset:Number.MAX_SAFE_INTEGER}),{readOnlySnapshot:true});
 expect(pastPage.total).toBe(count);expect(pastPage.rows).toEqual([]);expect(pastPage.selected?.employmentId).toBe(selectedId);
 for(const terminatedAfter of ['0001-01-01','9999-12-31']){
  const request={...input,terminatedAfter},old=await database.withTenant(ctx,tx=>current.readEmployeeChoicesTx(tx,ctx,request),{readOnlySnapshot:true});
  const next=await database.withTenant(ctx,tx=>prototype.readEmployeeChoicesTx(tx,ctx,request),{readOnlySnapshot:true});
  expect(stable(next)).toEqual(stable(old));expect(next.total).toBe(terminatedAfter==='0001-01-01'?count:count-2);
 }
 for(const query of ['no\0person','%','_','\\','人員','\u0130','x'.repeat(20000)]){
  const request={companyIds:[b.companyId],query,selectedId},old=await current.readEmployeeChoices(ctx,request),next=await prototype.readEmployeeChoices(ctx,request);
  expect(stable(next)).toEqual(stable(old));expect(next.total).toBe(0);expect(next.selected?.employmentId).toBe(selectedId);
 }
 const names=['İstanbul Example','i\u0307zmir Example','STRASSE Example','Straße Example','Literal % _ \\ Example','人員 😀 Example','Tied 人員 Name','Tied 人員 Name'];
 for(const [index,name]of names.entries())await owner.client`update person set full_name=${name} where id=${personPrefix+String(index+3).padStart(12,'0')}::uuid`;
 const ordered=await owner.client`select e.id as id,p.full_name as name from employment e join person p on p.id=e.person_id
  where e.id=any(${ids.slice(2,2+names.length)}::uuid[]) order by p.full_name,e.id`;
 const peopleBefore=await owner.client`select md5(coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb)::text) as hash from person p`;
 for(const query of ['i\u0307','\u0307','strasse','ß','%','_','\\','人員','😀','Tied']){
  const expectedIds=ordered.filter(row=>row.name.toLowerCase().includes(query.toLowerCase())).map(row=>row.id);
  expect(expectedIds.length).toBeGreaterThan(0);
  const request={companyIds:[b.companyId],query,selectedId},old=await current.readEmployeeChoices(ctx,request),next=await prototype.readEmployeeChoices(ctx,request);
  expect(stable(next)).toEqual(stable(old));expect(next.rows.map(row=>row.employmentId)).toEqual(expectedIds);expect(next.total).toBe(expectedIds.length);
  expect(await database.withTenant(ctx,tx=>prototype.readEmployeeChoiceIdsTx(tx,ctx,request),{readOnlySnapshot:true})).toEqual(expectedIds);
 }
 for(const offset of [0,3,7,8,Number.MAX_SAFE_INTEGER]){
  const request={companyIds:[b.companyId],employmentIds:ids.slice(2,2+names.length).reverse(),offset,limit:3,selectedId};
  const next=await database.withTenant(ctx,tx=>prototype.readEmployeeChoicesTx(tx,ctx,request),{readOnlySnapshot:true}),
   old=await database.withTenant(ctx,tx=>current.readEmployeeChoicesTx(tx,ctx,request),{readOnlySnapshot:true});
  expect(stable(next)).toEqual(stable(old));expect(next.rows.map(row=>row.employmentId)).toEqual(ordered.slice(offset,offset+3).map(row=>row.id));
  expect(next.total).toBe(names.length);expect(next.selected).toBeNull();
 }
 const tiedIds=ordered.filter(row=>row.name==='Tied 人員 Name').map(row=>row.id);expect(tiedIds).toHaveLength(2);
 const tiedRequest={companyIds:[b.companyId],query:'Tied',offset:1,limit:1,selectedId};
 const tied=await prototype.readEmployeeChoices(ctx,tiedRequest);expect(stable(tied)).toEqual(stable(await current.readEmployeeChoices(ctx,tiedRequest)));
 expect(tied.rows.map(row=>row.employmentId)).toEqual(tiedIds.slice(1));expect(tied.total).toBe(2);expect(tied.selected?.employmentId).toBe(selectedId);
 const completeBroad=await database.withTenant(ctx,tx=>prototype.readEmployeeChoiceIdsTx(tx,ctx,{companyIds:[],query:'native'}),{readOnlySnapshot:true});
 const expectedBroad=await owner.client`select e.id from employment e join person p on p.id=e.person_id where e.tenant_id=${b.tenantId}::uuid order by p.full_name,e.id`;
 expect(completeBroad).toEqual(expectedBroad.map(row=>row.id));expect(completeBroad.length).toBe(count);
 expect(await owner.client`select md5(coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb)::text) as hash from person p`).toEqual(peopleBefore);
 expect(await owner.client`select md5(coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb)::text) as hash from employment e`).toEqual(before);
 await installation!.unchanged();
},120000);

nativeIt('rejects malformed exact ASCII parameters natively with the unchanged native authority and sibling settings',async()=>{
 const ctx=actor(),input={companyIds:[b.companyId]};
 const call=(q:string|null)=>sql`select * from app.employee_choice_native_prototype(${ctx.tenantId}::uuid,${ctx.userId}::uuid,null::uuid,
  array['hr_admin']::text[],${JSON.stringify(ctx.grants)}::jsonb,array[${b.companyId}::uuid],null::date,null::uuid[],null::uuid,null::uuid,null::uuid,''::text,
  'exact-ascii'::text,${q}::text,null::uuid,0::bigint,25::integer,'names'::text,'page'::text,null::uuid[])`;
 await database.withTenant(ctx,async tx=>{
  const before=(await tx.execute(sql`select pg_backend_pid()as pid,current_setting('jit')as jit,current_setting('transaction_read_only')as mode`))[0];
  for(const q of [null,'','UPPER','é','İ','😀'])await expect(tx.transaction(inner=>inner.execute(call(q)))).rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='22023');
  for(const q of ['%','_','\\','i','k','\u0001','\u007f'])expect((await tx.execute(call(q))).filter(row=>row.kind==='count').map(row=>row.total)).toEqual([0]);
  expect((await tx.execute(sql`select pg_backend_pid()as pid,current_setting('jit')as jit,current_setting('transaction_read_only')as mode`))[0]).toEqual(before);
 },{readOnlySnapshot:true});
 await installation!.unchanged();
});

nativeIt('matches literal binary ASCII and unchanged fallback against independent ordered real names codes facets and selection',async()=>{
 const f=await createAssignmentAuthorityFixture(),people=[f.alpha,f.beta,f.gamma,f.unassigned,f.transferred],names=['İA','KA','X%_\\Y','A\u0307B','\u0001A\u007f'];
 for(const [index,person]of people.entries()){
  await owner.client`update public.person set full_name=${names[index]} where id=${person.personId}::uuid`;
  await owner.client`update public.employment set employee_code=${'X'+String(index).padStart(5,'0')} where id=${person.id}::uuid`;
 }
 const rows=await owner.client`select e.id,p.full_name as name,e.employee_code as code,a.department_id as department from public.employment e join public.person p on p.id=e.person_id left join public.assignment a on a.employment_id=e.id and a.valid_to is null and a.superseded_at is null where e.tenant_id=${f.b.tenantId}::uuid order by p.full_name,e.id`;
 const snapshot=async()=>(await owner.client`select jsonb_build_object('people',(select jsonb_agg(to_jsonb(p)order by p.id)from public.person p),'employment',(select jsonb_agg(to_jsonb(e)order by e.id)from public.employment e),'assignments',(select jsonb_agg(to_jsonb(a)order by a.id)from public.assignment a),'events',(select jsonb_agg(to_jsonb(e)order by e.id)from public.domain_event e))as value`)[0].value;
 const before=await snapshot(),pageSpy=vi.spyOn(legacy,'readEmployeeChoicesTx'),idsSpy=vi.spyOn(legacy,'readEmployeeChoiceIdsTx');
 await preserveDiagnosticFailure(async()=>{
  for(const query of ['%','_','\\','i','ia','k','ka','ab','a','\u0001','\u007f','K',' İ ','😀','i\u0307','no\0match','  ']){
   const input={companyIds:[],departmentId:f.b.deptA,query,limit:1,selectedId:f.transferred.id},q=query.trim().toLowerCase(),expected=rows.filter(row=>row.department===f.b.deptA&&(row.name.toLowerCase().includes(q)||(row.code??'').toLowerCase().includes(q))).map(row=>row.id);
   const pageCalls=pageSpy.mock.calls.length,idsCalls=idsSpy.mock.calls.length,expectedFallback=q===''||query.includes('\0')||!/^[\x01-\x7f]*$/.test(q);
   const old=await current.readEmployeeChoices(f.ctx,input),page=await prototype.readEmployeeChoices(f.ctx,input);
   expect(stable(page)).toEqual(stable(old));expect(page.rows.map(row=>row.employmentId)).toEqual(expected.slice(0,1));expect(page.total).toBe(expected.length);expect(page.filters.query).toBe(query);expect(page.selected?.employmentId).toBe(f.transferred.id);
   expect(page.companyOptions.map(row=>row.id).sort()).toEqual([f.b.companyId,f.otherCompany].sort());expect(page.allDepartmentOptions.map(row=>row.id).sort()).toEqual([f.b.deptA,f.b.deptB].sort());
   expect(await database.withTenant(f.ctx,tx=>prototype.readEmployeeChoiceIdsTx(tx,f.ctx,{companyIds:[],departmentId:f.b.deptA,query}),{readOnlySnapshot:true})).toEqual(expected);
   expect(pageSpy.mock.calls.length-pageCalls).toBe(expectedFallback?1:0);expect(idsSpy.mock.calls.length-idsCalls).toBe(expectedFallback?1:0);
   if(!expectedFallback)expect(exactAsciiPrototypeRuntimeEvidence()).toMatchObject({status:'qualified',contexts:85});
  }
  expect(await snapshot()).toEqual(before);await installation!.unchanged();
 },async()=>{await preserveDiagnosticFailure(async()=>{pageSpy.mockRestore();},async()=>{idsSpy.mockRestore();});});
},120000);
