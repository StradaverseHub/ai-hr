/** AP008/009: already authorized Criteria projections replace company-by-company reads. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import * as s from '../db/schema';
import {listDepartments} from '../core/read';
import {bulkSaveLabels,listPositions,listCostCenters,listBusinessUnits} from '../core/admin';
import {labelIdsForCompany,setLabelCriteria} from '../core/system-labels';
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
 const spy=vi.spyOn(database,'withTenant');
 try{
  for(let index=0;index<4;index++){
   const read=readers[index],kind=kinds[index];
   const rows=await read(ctx);const csv=labelCompanyCsv(rows,companies);
   spy.mockClear();
   for(const companyId of companies){
    const old=await read(ctx,{companyIds:[companyId]});
    expect(labelsInCompanyScope(rows,new Set([companyId]))).toEqual(old);
    const legacyIds=new Set(await labelIdsForCompany(ctx,kind,companyId));
    for(const row of rows)expect(csv.get(row.id)?.split(',').includes(companyId)??false).toBe(legacyIds.has(row.id));
   }
   expect(spy).toHaveBeenCalledTimes(140);spy.mockClear();
   const catalogue=await read(ctx);for(const companyId of companies)labelsInCompanyScope(catalogue,new Set([companyId]));labelCompanyCsv(catalogue,companies);
   expect(spy).toHaveBeenCalledTimes(1);
   for(const role of s.roleEnum.enumValues)for(const companyId of role==='super_admin'?[null]:[null,b.companyId]){
    const userId=await createAppUser(b.tenantId,people[0].id,'employee');
    await owner.db.update(s.roleAssignment).set({role,companyId}).where(eq(s.roleAssignment.appUserId,userId));
    const who={...ctx,userId,personId:people[0].id,roles:[role],grants:[{role,companyId}]};
    const all=await read(who);
    for(const id of [b.companyId,companies[1]])expect(labelsInCompanyScope(all,new Set([id]))).toEqual(await read(who,{companyIds:[id]}));
   }
  }
 }finally{spy.mockRestore();}
 // Native reads above establish membership; the client helper never expands the supplied company set.
 expect(labelCompanyCsv([{id:'g',companyId:'origin',isGlobal:true,assignedCompanyIds:[]}],['b','a','b'])).toEqual(new Map([['g','a,b']]));
 expect(labelCompanyCsv([],companies)).toEqual(new Map());
 expect(labelCompanyCsv([{id:'x',companyId:companies[0],isGlobal:false,assignedCompanyIds:[companies[1]]}],[companies[0]])).toEqual(new Map());
 // 70-company native oracles and real role assignments require headroom over the default30s.
},240000);
