/** Native behavior parity for set-wise organization membership; no permission mocks. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as choices from '../core/employee-choice';
import * as baseline from './performance/employee-choice-org-baseline';
import {withTenant} from '../db/client';
import * as database from '../db/client';
import {person} from '../db/schema';
import {createAssignmentAuthorityFixture,assertAssignmentAuthority} from './performance/employee-choice-assignment-authority';
import {closeAll,migrateTestDb,owner,resetDb} from './harness';
beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
const currentRead=choices.readEmployeeChoices;
const stable=({contextId:_contextId,...page}:Awaited<ReturnType<typeof currentRead>>)=>page;
it('pins the reviewed original reader independently of the candidate',()=>{
 expect(createHash('sha256').update(readFileSync('test/performance/employee-choice-org-baseline.ts')).digest('hex')).toBe('deadc95a4acf06359f2d338f2c5611fb94672ae3b18ba99bbabf9f09dc9fc299');
});
it('retains current-company, future/open/history, independent selection, facets and complete server populations',async()=>{
 const f=await createAssignmentAuthorityFixture();
 const [constraint]=await owner.client`select contype,condeferrable,condeferred,convalidated from pg_constraint where conrelid='public.assignment'::regclass and conname='assignment_no_overlap'`;
 expect(constraint).toEqual({contype:'x',condeferrable:false,condeferred:false,convalidated:true});
 const inputs:Parameters<typeof currentRead>[1][]=[
  {companyIds:[],departmentId:f.b.deptA,businessUnitId:f.unit,selectedId:f.unassigned.id},
  {companyIds:[f.otherCompany],departmentId:f.b.deptB,selectedId:f.transferred.id},
  {companyIds:[f.b.companyId],departmentId:f.b.deptA,companyId:f.otherCompany,selectedId:f.alpha.id},
  {companyIds:[],departmentId:f.b.deptA,offset:1,limit:1,selectedId:f.beta.id},
  {companyIds:[],departmentId:f.b.deptA,offset:200,selectedId:f.unassigned.id},
 ];
 for(const input of inputs)expect(stable(await currentRead(f.ctx,input))).toEqual(stable(await baseline.readEmployeeChoices(f.ctx,input)));
 const a=await currentRead(f.ctx,inputs[0]);expect(a.total).toBe(2);expect(a.rows.map(row=>row.employmentId)).toEqual([f.alpha.id,f.gamma.id]);expect(a.selected?.employmentId).toBe(f.unassigned.id);expect(a.selected?.departmentId).toBeNull();
 const transferred=await currentRead(f.ctx,inputs[1]);expect(transferred.total).toBe(1);expect(transferred.rows.map(row=>row.employmentId)).toEqual([f.transferred.id]);expect(transferred.rows[0].companyId).toBe(f.otherCompany);
 const independent=await currentRead(f.ctx,inputs[2]);expect(independent.total).toBe(0);expect(independent.selected?.employmentId).toBe(f.alpha.id);
 for(const reader of [choices.readEmployeeChoiceIdsTx,baseline.readEmployeeChoiceIdsTx]){
  const ids=await withTenant(f.ctx,tx=>reader(tx,f.ctx,{companyIds:[f.b.companyId],departmentId:f.b.deptA,businessUnitId:f.unit}),{readOnlySnapshot:true});expect(ids).toEqual([f.alpha.id,f.gamma.id]);
  const none=await withTenant(f.ctx,tx=>reader(tx,f.ctx,{companyIds:[],departmentId:f.b.deptA,employmentIds:[]}),{readOnlySnapshot:true});expect(none).toEqual([]);
  const subset=await withTenant(f.ctx,tx=>reader(tx,f.ctx,{companyIds:[],departmentId:f.b.deptA,employmentIds:[f.gamma.id,f.unassigned.id],terminatedAfter:'2025-01-01'}),{readOnlySnapshot:true});expect(subset).toEqual([f.gamma.id]);
 }
});
it('retains exact Unicode and literal search with organization filters and names/labels projections',async()=>{
 const f=await createAssignmentAuthorityFixture();
 await owner.db.update(person).set({fullName:'İnci 人員 %_\\ 😀'}).where(eq(person.id,f.alpha.personId));
 await owner.db.update(person).set({fullName:'Kelvin K Straße'}).where(eq(person.id,f.gamma.personId));
 for(const query of ['i','İ','i\u0307','人','%','_','\\','😀','K','STRASSE','Straße','absent'])for(const labelMode of ['names','labels']as const){
  const input={companyIds:[f.b.companyId],departmentId:f.b.deptA,businessUnitId:f.unit,query,labelMode,selectedId:f.unassigned.id};
  const result=await currentRead(f.ctx,input);expect(stable(result)).toEqual(stable(await baseline.readEmployeeChoices(f.ctx,input)));
  const needle=query.trim().toLowerCase(),expected=[{id:f.alpha.id,name:'İnci 人員 %_\\ 😀'},{id:f.gamma.id,name:'Kelvin K Straße'}].filter(row=>row.name.toLowerCase().includes(needle)).map(row=>row.id).sort();
  expect(result.total).toBe(expected.length);expect(result.rows.map(row=>row.employmentId).sort()).toEqual(expected);
 }
});
it('preserves the independent native authority matrix before and after query adoption',async()=>{
 const f=await createAssignmentAuthorityFixture(),spy=vi.spyOn(choices,'readEmployeeChoices').mockImplementation(baseline.readEmployeeChoices);
 let original:Awaited<ReturnType<typeof assertAssignmentAuthority>>;
 try{original=await assertAssignmentAuthority(f);}finally{spy.mockRestore();}
 expect(await assertAssignmentAuthority(f)).toEqual(original!);
});
it('finishes the filtered read while actual Access and History writer barriers remain held',async()=>{
 const f=await createAssignmentAuthorityFixture();
 const native=database.withTenant,spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:database.SessionContext,read:(tx:database.Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(ctx,async tx=>{
  await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);return read(tx);
 },options));
 try{
 for(const key of ['access-configuration:'+f.b.tenantId,'audit-chain:'+f.b.tenantId]){
  let release!:()=>void,entered!:()=>void,writerPid=0;const ready=new Promise<void>(r=>{entered=r;}),done=new Promise<void>(r=>{release=r;});
  const writer=owner.client.begin(async tx=>{
   if(key.startsWith('audit-chain:'))await tx`select pg_advisory_xact_lock(hashtext(${key}))`;
   else await tx`select pg_advisory_xact_lock(hashtextextended(${key},0))`;
   const [identity]=await tx`select pg_backend_pid() as pid`;writerPid=identity.pid;entered();await done;
  });
  try{
   await Promise.race([ready,writer.then(()=>{throw Error('Writer ended before acquiring its barrier');})]);
   const input={companyIds:[f.b.companyId],departmentId:f.b.deptA,businessUnitId:f.unit,selectedId:f.unassigned.id};
   const old=await baseline.readEmployeeChoices(f.ctx,input),next=await currentRead(f.ctx,input);
   expect(stable(next)).toEqual(stable(old));expect(next.total).toBe(2);expect(next.rows.map(row=>row.employmentId)).toEqual([f.alpha.id,f.gamma.id]);
   const [held]=await owner.client`select exists(select 1 from pg_locks where locktype='advisory' and granted and pid=${writerPid}) as held`;
   expect(held.held).toBe(true);
  }finally{release();await writer;}
 }
 }finally{spy.mockRestore();}
});
