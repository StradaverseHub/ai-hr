/** AP001: destination options use one native catalogue transaction, with per-company Criteria retained. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {listDepartments} from '../core/read';
import {bulkSaveLabels,listPositions,listBusinessUnits} from '../core/admin';
import {createLocation,listLocations} from '../core/location';
import {movementOrganisationChoices,type MovementOrganisationChoices} from '../core/movement-organisation-choices';
import {organisationChoiceLabels} from '../lib/organisation-choice-label';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
async function legacy(ctx:SessionContext,id:string):Promise<MovementOrganisationChoices>{
 return database.withTenant(ctx,async tx=>{
  const [departments,positions,businessUnits,locations]=await Promise.all([listDepartments(ctx,{companyIds:[id]},tx),listPositions(ctx,{companyIds:[id]},tx),listBusinessUnits(ctx,{companyIds:[id]},tx),listLocations(ctx,[id],{},tx)]);
  return {departments:organisationChoiceLabels(departments).map(row=>({id:row.id,name:row.displayLabel})),positions:organisationChoiceLabels(positions).map(row=>({id:row.id,name:row.displayLabel})),businessUnits:organisationChoiceLabels(businessUnits).map(row=>({id:row.id,name:row.displayLabel})),locations:locations.map(row=>({id:row.id,name:`${row.name} (${row.code})`}))};
 });
}
it('preserves exact destination choices and disambiguation across native roles, company visibility and Criteria',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const rest=await owner.db.insert(s.company).values(Array.from({length:69},(_,i)=>({tenantId:b.tenantId,legalName:'Fictional destination '+i}))).returning({id:s.company.id});
 const companies=[b.companyId,...rest.map(row=>row.id)];
 const people=await owner.db.insert(s.person).values(Array.from({length:1000},(_,i)=>({tenantId:b.tenantId,fullName:'Fictional destination person '+i,primaryEmail:randomUUID()+'@fixture.invalid'}))).returning({id:s.person.id});
 await owner.db.insert(s.employment).values(people.map((p,i)=>({tenantId:b.tenantId,personId:p.id,companyId:companies[i%70],employeeCode:'MO-'+i,hiredOn:'2020-01-01'})));
 for(const kind of ['department','position','business_unit'] as const){
  await bulkSaveLabels(ctx,kind,{creates:companies.map((companyId,i)=>({key:kind+i,companyId,companyIds:[companyId,companies[(i+1)%70]],isGlobal:i%5===0,archived:i%7===0,code:'C'+i,name:'Fictional code '+i,title:'Fictional code '+i,label:'Readable '+i})),updates:[]});
  // Same code/label in disjoint company Criteria: format after narrowing, as each old singleton does.
  await bulkSaveLabels(ctx,kind,{creates:companies.slice(0,2).map((companyId,i)=>({key:'duplicate'+i,companyId,companyIds:[companyId],isGlobal:false,code:'REPEATED',name:'REPEATED',title:'REPEATED',label:'Repeated caption'})),updates:[]});
 }
 for(const companyId of companies)await createLocation(ctx,{companyId,code:'HQ',name:'Fictional headquarters',country:'MY'});
 const spy=vi.spyOn(database,'withTenant');
 const expected=new Map(await Promise.all(companies.map(async id=>[id,await legacy(ctx,id)] as const)));
 expect(spy).toHaveBeenCalledTimes(70);spy.mockRestore();
 expect(expected.get(b.companyId)!.locations).toHaveLength(1);expect(expected.get(b.companyId)!.departments.length).toBeGreaterThan(1);
 const native=database.withTenant,carriers:{readOnly:string;mode:string}[]=[];
 const batched=vi.spyOn(database,'withTenant').mockImplementation(<T>(who:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(who,async tx=>{
  const result=await read(tx);const [mode]=await tx.execute<{readOnly:string;mode:string}>(sql`select current_setting('transaction_read_only') as "readOnly",app.access_lock_mode_held(${who.tenantId}::uuid) as mode`);carriers.push(mode);return result;
 },options));
 try{expect(await movementOrganisationChoices(ctx,companies)).toEqual(expected);expect(batched).toHaveBeenCalledTimes(1);expect(carriers).toEqual([{readOnly:'on',mode:'S'}]);}finally{batched.mockRestore();}
 for(const role of s.roleEnum.enumValues)for(const companyId of role==='super_admin'?[null]:[null,b.companyId]){
  const userId=await createAppUser(b.tenantId,people[0].id,'employee');await owner.db.update(s.roleAssignment).set({role,companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const who={...ctx,userId,personId:people[0].id,roles:[role],grants:[{role,companyId}]};
  for(const ids of [companies,[b.companyId],[companies[1]], [b.companyId,randomUUID()]])expect(await movementOrganisationChoices(who,ids)).toEqual(new Map(await Promise.all(ids.map(async id=>[id,await legacy(who,id)] as const))));
 }
 const aliases=[companies[1].toUpperCase(),'{'+companies[1]+'}',companies[1].replaceAll('-','')];
 expect(await movementOrganisationChoices(ctx,aliases)).toEqual(new Map(aliases.map(id=>[id,expected.get(companies[1])!])));
 expect(await movementOrganisationChoices(ctx,[])).toEqual(new Map());
 const other=await seedBase();expect(await movementOrganisationChoices(adminCtx(other),companies)).toEqual(new Map(companies.map(id=>[id,{departments:[],positions:[],businessUnits:[],locations:[]}])));
 // Native70-company/1000-employment role oracles and canonical configuration writers need headroom.
},300000);
