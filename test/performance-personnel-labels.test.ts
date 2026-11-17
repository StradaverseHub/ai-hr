/** AP008/009: already authorized Criteria projections replace company-by-company reads. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import * as s from '../db/schema';
import {listDepartments} from '../core/read';
import {bulkSaveLabels,listPositions,listCostCenters,listBusinessUnits} from '../core/admin';
import {businessUnitCriteriaForIds,labelIdsForCompany,setLabelCriteria} from '../core/system-labels';
import {hireOptionVisible} from '../lib/hire-form-filter';
import {labelCompanyCsv,labelsInCompanyScope} from '../lib/system-label-scope';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('retains native per-company availability/order for all roles, shared/global/archived labels at group scale',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const rest=await owner.db.insert(s.company).values(Array.from({length:69},(_,i)=>({tenantId:b.tenantId,legalName:'Fictional label company '+i}))).returning({id:s.company.id});
 const companies=[b.companyId,...rest.map(r=>r.id)];
 const people=await owner.db.insert(s.person).values(Array.from({length:1000},(_,i)=>({tenantId:b.tenantId,fullName:'Fictional label person '+i,primaryEmail:randomUUID()+'@fixture.invalid'}))).returning({id:s.person.id});
 await owner.db.insert(s.employment).values(people.map((p,i)=>({tenantId:b.tenantId,personId:p.id,companyId:companies[i%70],employeeCode:'LP-'+i,hiredOn:'2020-01-01'})));
 const readers=[listDepartments,listPositions,listCostCenters,listBusinessUnits] as const;
 const kinds=['department','position','cost_center','business_unit'] as const;
 for(const kind of kinds){
  const result=await bulkSaveLabels(ctx,kind,{creates:companies.map((companyId,i)=>({key:kind+i,companyId,companyIds:[companyId,companies[(i+1)%70]],isGlobal:i%5===0,archived:i%7===0,name:'Fictional '+i,title:'Fictional '+i,code:'L'+i,label:'Readable '+i})),updates:[]});
  expect(result.createdIds).toHaveLength(70);
  await setLabelCriteria(ctx,{kind,labelId:result.createdIds[1].id,isGlobal:false,companyIds:[companies[2]]});
 }
 // Active departments retain their cascade relationship when the referenced BU is archived.
 const linkedBu=(await bulkSaveLabels(ctx,'business_unit',{creates:[{key:'linked',companyId:b.companyId,companyIds:[b.companyId],code:'LINKED',name:'Referenced unit'}],updates:[]})).createdIds[0].id;
 const linkedDept=(await bulkSaveLabels(ctx,'department',{creates:[{key:'linked-dept',companyId:b.companyId,companyIds:[b.companyId],name:'Linked active department',businessUnitId:linkedBu}],updates:[]})).createdIds[0].id;
 await bulkSaveLabels(ctx,'business_unit',{creates:[],updates:[{key:linkedBu,id:linkedBu,code:'LINKED',name:'Referenced unit',archived:true}]});
 expect((await listBusinessUnits(ctx)).some(row=>row.id===linkedBu)).toBe(false);
 expect((await listDepartments(ctx)).find(row=>row.id===linkedDept)?.businessUnitId).toBe(linkedBu);
 const metadata=await businessUnitCriteriaForIds(ctx,[linkedBu]);
 const preservedCsv=labelCompanyCsv(metadata,companies).get(linkedBu)!;
 expect(preservedCsv).toBe(b.companyId);expect(await labelIdsForCompany(ctx,'business_unit',b.companyId)).toContain(linkedBu);
 expect(hireOptionVisible({optCompanies:b.companyId,optBusinessUnit:linkedBu,optBuCompanies:preservedCsv,selectedCompany:b.companyId,selectedBusinessUnit:randomUUID()})).toBe(false);
 expect(hireOptionVisible({optCompanies:b.companyId,optBusinessUnit:linkedBu,optBuCompanies:preservedCsv,selectedCompany:b.companyId,selectedBusinessUnit:linkedBu})).toBe(true);
 const spy=vi.spyOn(database,'withTenant');
 try{
  for(let index=0;index<4;index++){
   const read=readers[index],kind=kinds[index];
   const rows=await read(ctx);const csv=labelCompanyCsv(rows,companies);
   const completeCriteria=index===3?await businessUnitCriteriaForIds(ctx,(await listBusinessUnits(ctx,{includeArchived:true})).map(row=>row.id)):[];
   const completeCsv=labelCompanyCsv(completeCriteria,companies);
   spy.mockClear();
   for(const companyId of companies){
    const old=await read(ctx,{companyIds:[companyId]});
    expect(labelsInCompanyScope<(typeof rows)[number]>(rows,new Set([companyId]))).toEqual(old);
    const legacyIds=new Set(await labelIdsForCompany(ctx,kind,companyId));
    for(const row of rows)expect(csv.get(row.id)?.split(',').includes(companyId)??false).toBe(legacyIds.has(row.id));
    for(const row of completeCriteria)expect(completeCsv.get(row.id)?.split(',').includes(companyId)??false).toBe(legacyIds.has(row.id));
   }
   expect(spy).toHaveBeenCalledTimes(140);spy.mockClear();
   const catalogue=await read(ctx);for(const companyId of companies)labelsInCompanyScope<(typeof catalogue)[number]>(catalogue,new Set([companyId]));labelCompanyCsv(catalogue,companies);
   expect(spy).toHaveBeenCalledTimes(1);
   for(const role of s.roleEnum.enumValues)for(const companyId of role==='super_admin'?[null]:[null,b.companyId]){
    const userId=await createAppUser(b.tenantId,people[0].id,'employee');
    await owner.db.update(s.roleAssignment).set({role,companyId}).where(eq(s.roleAssignment.appUserId,userId));
    const who={...ctx,userId,personId:people[0].id,roles:[role],grants:[{role,companyId}]};
    const all=await read(who);
    for(const id of [b.companyId,companies[1]])expect(labelsInCompanyScope<(typeof all)[number]>(all,new Set([id]))).toEqual(await read(who,{companyIds:[id]}));
   }
  }
 }finally{spy.mockRestore();}
 // Native reads above establish membership; the client helper never expands the supplied company set.
 expect(labelCompanyCsv([{id:'g',companyId:'origin',isGlobal:true,assignedCompanyIds:[]}],['b','a','b'])).toEqual(new Map([['g','a,b']]));
 expect(labelCompanyCsv([],companies)).toEqual(new Map());
 expect(labelCompanyCsv([{id:'x',companyId:companies[0],isGlobal:false,assignedCompanyIds:[companies[1]]}],[companies[0]])).toEqual(new Map());
 // 70-company native oracles and real role assignments require headroom over the default30s.
},240000);
