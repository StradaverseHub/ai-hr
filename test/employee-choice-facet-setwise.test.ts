/** Native parity for the represented facet query; source shape is never a speed result. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {eq,sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import * as database from '../db/client';
import {readEmployeeChoices,readEmployeeChoiceIdsTx} from '../core/employee-choice';
import * as current from '../core/employee-choice';
import * as baseline from './performance/employee-choice-facet-baseline';
import {roleAssignment} from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb} from './harness';
import {createFacetRepresentationFixture} from './performance/employee-choice-facet-fixture';
import {createAssignmentAuthorityFixture,assertAssignmentAuthority} from './performance/employee-choice-assignment-authority';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {employeeChoiceActualCardinalities,employeeChoiceAuthorizedPopulationFacts,employeeChoicePlanWork} from './performance/employee-choice-plan-work';

beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
const stable=({contextId:_contextId,...page}:Awaited<ReturnType<typeof readEmployeeChoices>>)=>page;
it('pins exact frozen1de4d904 independently of the candidate',()=>{
 expect(createHash('sha256').update(readFileSync('test/performance/employee-choice-facet-baseline.ts')).digest('hex')).toBe('d938403de31ac827b000b83d04642afbe649aa09850d53ec17dce02bfc804a0e');
});
it('preserves complete unfiltered native facets, NULLs, historical pairs, labels and server populations across many empty catalogues',async()=>{
 const f=await createFacetRepresentationFixture();
 const cases:(Parameters<typeof current.readEmployeeChoicesTx>[2]&{companyIds:string[]})[]=[
  {companyIds:[],selectedId:f.unassigned.id},
  {companyIds:[],query:'never matches',status:'active',departmentId:f.emptyDepartments[0].id,businessUnitId:f.emptyUnits[0].id,offset:200,selectedId:f.gamma.id},
  {companyIds:[],companyId:f.otherCompany,query:'never matches',selectedId:f.unassigned.id,labelMode:'labels'},
  {companyIds:[],companyId:f.emptyCompany,labelMode:'labels'},
  {companyIds:[f.b.companyId],status:'ended',labelMode:'labels'},
  {companyIds:[],labelMode:'labels'},
  {companyIds:[],employmentIds:[f.transferred.id,f.nullEmployment],labelMode:'labels'},
  {companyIds:[],employmentIds:[]},
  {companyIds:[],terminatedAfter:'2025-01-01'},
  {companyIds:[f.foreign.companyId],selectedId:f.alpha.id},
 ];
 for(const input of cases){
  const next=await database.withTenant(f.ctx,tx=>current.readEmployeeChoicesTx(tx,f.ctx,input),{readOnlySnapshot:true});expect(stable(next)).toEqual(stable(await database.withTenant(f.ctx,tx=>baseline.readEmployeeChoicesTx(tx,f.ctx,input),{readOnlySnapshot:true})));
  const scope=f.members.filter(m=>(!input.companyIds.length||input.companyIds.includes(m.companyId))&&(input.employmentIds===undefined||input.employmentIds.includes(m.id))&&(!input.terminatedAfter||!m.ended||m.ended>input.terminatedAfter));
  const selectedCompany=scope.filter(m=>!input.companyId||m.companyId===input.companyId);
  const unique=(values:(string|null)[])=>[...new Set(values.filter((v):v is string=>v!==null))].sort();
  expect(next.companyOptions.map(r=>r.id).sort()).toEqual(unique(scope.map(m=>m.companyId)));
  expect(next.allDepartmentOptions.map(r=>r.id).sort()).toEqual(unique(scope.map(m=>m.departmentId)));
  expect(next.departmentOptions.map(r=>r.id).sort()).toEqual(unique(selectedCompany.map(m=>m.departmentId)));
  expect(next.businessUnitOptions.map(r=>r.id).sort()).toEqual(unique(selectedCompany.map(m=>m.unitId)));
 }
 const all=await readEmployeeChoices(f.ctx,{companyIds:[],labelMode:'labels'});
 expect(all.total).toBe(6);expect(all.rows.map(r=>r.employmentId)).not.toContain(f.hiddenEmployment);
 expect(all.rows.find(r=>r.employmentId===f.nullEmployment)).toMatchObject({departmentId:null,businessUnitId:null});
 const [native]=await owner.client`select (select attnotnull from pg_attribute where attrelid='public.assignment'::regclass and attname='department_id') as required,
  (select count(*)::int from public.assignment where employment_id=${f.nullEmployment}::uuid and valid_to is null and superseded_at is null) as current`;
 expect(native).toEqual({required:true,current:0});
 expect(all.allDepartmentOptions.map(r=>r.name)).toEqual(['Shared department (D-A)','Shared department (D-B)','Shared department (D-END)']);
 expect(all.businessUnitOptions.map(r=>r.name)).toEqual(['Shared unit (U-A)','Shared unit (U-END)']);
 const transferred=await readEmployeeChoices(f.ctx,{companyIds:[],companyId:f.otherCompany,labelMode:'labels',selectedId:f.transferred.id});
 expect(transferred.departmentOptions).toEqual([{id:f.b.deptB,name:'Shared department'}]);expect(transferred.businessUnitOptions).toEqual([{id:f.unit,name:'Shared unit'}]);expect(transferred.selected?.companyId).toBe(f.otherCompany);
 for(const partner of f.partners){const page=await readEmployeeChoices(partner,{companyIds:[f.otherCompany]});expect(page.total).toBe(1);expect(page.companyOptions.map(r=>r.id)).toEqual([f.otherCompany]);expect(page.allDepartmentOptions).toEqual([]);expect(page.businessUnitOptions).toEqual([]);}
 for(const reader of [readEmployeeChoiceIdsTx,baseline.readEmployeeChoiceIdsTx])expect(await database.withTenant(f.ctx,tx=>reader(tx,f.ctx,{companyIds:[],companyId:f.otherCompany,departmentId:f.b.deptB}),{readOnlySnapshot:true})).toEqual([f.transferred.id]);
},30000);

it('captures actual native sparse multi-company work and buffers before enforcing bounded complexity',async()=>{
 const f=await createFacetRepresentationFixture(),native=database.withTenant,queries:SQL[]=[],dialect=new PgDialect();
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:database.SessionContext,read:(tx:database.Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(ctx,async tx=>{
  await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
  return read(new Proxy(tx,{get(target,key,receiver){if(key==='execute')return async(query:SQL)=>{const text=dialect.sqlToQuery(query).sql;if(text.includes('employee_choice_employments as materialized'))queries.push(query);return target.execute(query);};const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;}}));
 },options));
 let page:Awaited<ReturnType<typeof readEmployeeChoices>>;
 try{page=await readEmployeeChoices(f.ctx,{companyIds:[]});}finally{spy.mockRestore();}
 const wholeFixture=await employeeChoiceActualCardinalities(owner.db),plans:Record<string,unknown>[]=[];
 const report:Record<string,unknown>={kind:'NATIVE_SPARSE_EMPLOYEE_CHOICE_COMPLEXITY',releaseEligible:false,
  scope:'Owned fictional database, all fixture tenants; native authorized server population is recorded separately',
  wholeFixture,expectedMembers:f.members,observedPage:stable(page!),capturedQueries:queries.length,plans,complete:false,
  limitations:'Rejection envelope only; neither its success nor synthetic models establish speed, worker capacity or acceptance.'};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'employee-choice-sparse-plan.json'),JSON.stringify(report,null,2));};save();
 await native(f.ctx,async tx=>{await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
  await assertAiPresentationPrincipalTx(tx,f.ctx);
  const facts=await employeeChoiceAuthorizedPopulationFacts(tx,f.ctx.tenantId,[]);report.authorizedServerPopulation=facts;save();
  for(const query of queries){
   const started=performance.now(),actual=Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${query}`));
   const entry:Record<string,unknown>={sql:dialect.sqlToQuery(query).sql,wallMs:performance.now()-started,actual};plans.push(entry);save();
   // Preserve the complete native document before parsing or enforcing any counter.
   const doc=(actual[0]as unknown as {'QUERY PLAN':{Plan:Record<string,unknown>}[]})['QUERY PLAN'][0];
   const work=employeeChoicePlanWork(doc.Plan,wholeFixture);entry.work=work;save();
   expect(work.rejectionReasons).toEqual([]);expect(work.nodes.some(node=>node.relation==='assignment')).toBe(true);
   expect(Number(doc.Plan['Actual Rows'])).toBe(17);
  }
  const pairs=(kind:'departmentId'|'unitId')=>new Set(f.members.filter(row=>row[kind]!==null).map(row=>row.companyId+':'+row[kind])).size;
  expect(facts.population).toEqual({identities:f.members.length,companies:new Set(f.members.map(row=>row.companyId)).size,departmentPairs:pairs('departmentId'),unitPairs:pairs('unitId')});
 },{readOnlySnapshot:true});
 expect(page!.total).toBe(6);expect(queries).toHaveLength(1);report.complete=true;save();
},30000);

it('retains every native authority/history/refusal control and freshly revokes retained contexts',async()=>{
 const f=await createAssignmentAuthorityFixture(),port=vi.spyOn(current,'readEmployeeChoices').mockImplementation(baseline.readEmployeeChoices);let original:Awaited<ReturnType<typeof assertAssignmentAuthority>>;
 try{original=await assertAssignmentAuthority(f);}finally{port.mockRestore();}
 expect(await assertAssignmentAuthority(f)).toEqual(original!);
 expect((await readEmployeeChoices(f.employeeCtx,{companyIds:[]})).companyOptions.map(r=>r.id)).toEqual([f.b.companyId]);
 await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,f.employeeUser));
 for(const reader of [readEmployeeChoices,baseline.readEmployeeChoices])await expect(reader(f.employeeCtx,{companyIds:[]})).rejects.toThrow('calling authority');
 expect((await readEmployeeChoices(adminCtx(f.foreign),{companyIds:[f.b.companyId]})).companyOptions).toEqual([]);
},30000);
