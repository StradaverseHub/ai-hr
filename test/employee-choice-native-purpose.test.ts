/** Actual app LOGIN/RLS and borrowed native RRRO controls; no mocked data or providers. */
import {randomUUID} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import * as current from '../core/employee-choice';
import * as prototype from './performance/employee-choice-native-purpose-reader';
import {installEmployeeChoiceNativePrototype} from './performance/employee-choice-native-purpose-owner';
import {createAssignmentAuthorityFixture,assertAssignmentAuthority} from './performance/employee-choice-assignment-authority';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let installation:Awaited<ReturnType<typeof installEmployeeChoiceNativePrototype>>|undefined,b:Base;
beforeAll(async()=>{await migrateTestDb();installation=await installEmployeeChoiceNativePrototype();},300000);
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(async()=>{try{await installation?.remove();}finally{await closeAll();}});
const stable=({contextId:_contextId,...page}:Awaited<ReturnType<typeof current.readEmployeeChoices>>)=>page;
const actor=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const prepared=(limit=25,offset=0)=>({filters:{query:'',companyId:'',departmentId:'',businessUnitId:'',status:''},offset,limit,labelMode:'names' as const,q:''});

it('matches the actual current root across native role/history/current-company/revocation and unrelated bank controls',async()=>{
 const fixture=await createAssignmentAuthorityFixture(),expected=await assertAssignmentAuthority(fixture);
 const port=vi.spyOn(current,'readEmployeeChoices').mockImplementation(prototype.readEmployeeChoices);
 try{expect(await assertAssignmentAuthority(fixture)).toEqual(expected);}finally{port.mockRestore();}
 await installation!.unchanged();
},120000);

it('restores JIT within the same borrowed native transaction after success and savepoint error, including a queued sibling',async()=>{
 const ctx=actor(),input={companyIds:[b.companyId]};
 const events=await owner.client`select md5(coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb)::text) as hash from domain_event e`;
 await database.withTenant(ctx,async tx=>{
  const [before]=await tx.execute<{role:string;login:string;pid:number;jit:string;isolation:string;mode:string;advisory:boolean}>(sql`select current_user as role,session_user as login,pg_backend_pid() as pid,
   current_setting('jit') as jit,current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as mode,
   exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted) as advisory`);
  expect(before).toMatchObject({role:'ai_hr_app',login:'ai_hr_app',jit:'on',isolation:'repeatable read',mode:'on',advisory:false});
  const [page,sibling]=await Promise.all([prototype.readEmployeeChoicesTx(tx,ctx,input),tx.execute<{jit:string}>(sql`select current_setting('jit') as jit`)]);
  expect(page.total).toBe(0);expect(sibling[0].jit).toBe('on');
  await expect(tx.transaction(inner=>inner.execute(prototype.nativeEmployeeChoiceQuery(ctx,input,prepared(0),'page')))).rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='22023');
  const [after]=await tx.execute<{pid:number;jit:string;mode:string}>(sql`select pg_backend_pid() as pid,current_setting('jit') as jit,current_setting('transaction_read_only') as mode`);
  expect(after).toEqual({pid:before.pid,jit:before.jit,mode:'on'});
  expect((await prototype.readEmployeeChoicesTx(tx,ctx,input)).total).toBe(0);
 },{readOnlySnapshot:true});
 expect(await owner.client`select md5(coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb)::text) as hash from domain_event e`).toEqual(events);
 await installation!.unchanged();
});

it('natively refuses wrong actor/person and read-committed callers before exposing any purpose data',async()=>{
 const ctx=actor(),input={companyIds:[b.companyId]};
 for(const altered of [{...ctx,userId:randomUUID()},{...ctx,tenantId:randomUUID()},{...ctx,personId:randomUUID()}]){
  await expect(database.withTenant(ctx,tx=>tx.execute(prototype.nativeEmployeeChoiceQuery(altered,input,prepared(),'page')),{readOnlySnapshot:true}))
   .rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='42501');
 }
 await expect(database.withTenant(ctx,tx=>tx.execute(prototype.nativeEmployeeChoiceQuery(ctx,input,prepared(),'page'))))
  .rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='42501');
 await expect(database.withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.agent_principal_id',${randomUUID()},true)`);
  return tx.execute(prototype.nativeEmployeeChoiceQuery(ctx,input,prepared(),'page'));},{readOnlySnapshot:true}))
  .rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='42501');
 expect((await prototype.readEmployeeChoices(ctx,input)).rows).toEqual([]);
 await installation!.unchanged();
});

it('keeps candidate matching and exact native projection in one snapshot and independently re-admits every submitted identity',async()=>{
 const f=await createAssignmentAuthorityFixture(),input={companyIds:[f.b.companyId],query:'fictional',selectedId:f.gamma.id};
 await database.withTenant(f.employeeCtx,async tx=>{
  const observe=async()=>(await tx.execute(sql`select pg_backend_pid()as pid,txid_current_snapshot()::text as snapshot,
   current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as mode`))[0];
  const before=await observe(),page=await prototype.readEmployeeChoicesTx(tx,f.employeeCtx,input);
  expect(page.rows.map(row=>row.employmentId)).toEqual([f.alpha.id]);expect(page.total).toBe(1);expect(page.selected).toBeNull();
  expect(await observe()).toEqual(before);expect(before).toMatchObject({isolation:'repeatable read',mode:'on'});
  const projected=await tx.execute(prototype.nativeEmployeeChoiceQuery(f.employeeCtx,input,prepared(),'project',[f.alpha.id,f.gamma.id,randomUUID()]));
  expect(projected.filter(row=>row.kind==='count').map(row=>row.total)).toEqual([1]);
  expect(projected.filter(row=>row.kind==='candidate').map(row=>row.employmentId)).toEqual([f.alpha.id]);
 },{readOnlySnapshot:true});
 await database.withTenant(f.ctx,async tx=>{
  const scope={companyIds:[f.b.companyId],employmentIds:[f.alpha.id]};
  const projected=await tx.execute(prototype.nativeEmployeeChoiceQuery(f.ctx,scope,prepared(),'project',[f.alpha.id,f.gamma.id]));
  expect(projected.filter(row=>row.kind==='count').map(row=>row.total)).toEqual([1]);
  expect(projected.filter(row=>row.kind==='candidate').map(row=>row.employmentId)).toEqual([f.alpha.id]);
 },{readOnlySnapshot:true});
 await installation!.unchanged();
},120000);

it('natively rejects malformed closed parameters and bypassed label admission without altering sibling settings',async()=>{
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
 await expect(database.withTenant(authority.employeeCtx,tx=>tx.execute(prototype.nativeEmployeeChoiceQuery(authority.employeeCtx,{companyIds:[]},
  {...prepared(),labelMode:'labels'},'page')),{readOnlySnapshot:true})).rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='42501');
 const requested={companyIds:[authority.b.companyId],labelMode:'labels' as const};
 expect(stable(await prototype.readEmployeeChoices(authority.ctx,requested))).toEqual(stable(await current.readEmployeeChoices(authority.ctx,requested)));
 await installation!.unchanged();
},120000);

it('preserves server All2000, complete IDs beyond2000, empty population and independent selection against exact current-root facts',async()=>{
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
