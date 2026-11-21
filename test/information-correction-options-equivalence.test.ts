/** Information-only correction options at group scale (SCALE rules 2 and 3, 12 November 2026).
 *
 * The organisation catalogue (department, position and business unit usable by each company) used to run three
 * statements per company. It now runs one statement per kind for every company at once and expands per company in
 * TypeScript. This suite proves the new reader answers EXACTLY as the per-company reader did (the reference below is a
 * verbatim copy of its companies query and loop at b05eb83d3), on the fictional group fixture (71 companies, 1,000
 * employments; test/helpers/ai-centre-scale-fixture.ts) plus a varied label catalogue: Global, assigned to a few
 * companies, assigned to its creation company only, archived, and blank or missing short codes. It compares the whole
 * company list and catalogue, order included, as a group administrator, an HR administrator granted every company one
 * by one, and an HR administrator of one company, and pins that the statement count no longer grows with the number of
 * companies. Every name and code is invented. */
import {and,asc,eq,isNull,sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {businessUnit,company,department,position} from '../db/schema';
import {informationCorrectionOptions} from '../core/information-correction';
import {allocationCompanyCode} from '../core/cost-allocation-import';
import {visibleLabelIdsCondition} from '../core/system-labels';
import type {InformationOptions} from '../lib/information-correction';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

/** The previous reader's company list and organisation catalogue, verbatim (core/information-correction.ts at b05eb83d3). */
function legacyCompaniesAndOrganisation(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const companies=await tx.select({id:company.id,label:company.companyLabel,registration:company.registrationNo,name:company.legalName}).from(company).where(and(eq(company.tenantId,ctx.tenantId),isNull(company.archivedAt),sql`app.principal_snapshot_current() and app.is_admin_for(${company.id}) and app.access_workforce_company(${company.id},'workforce.maintain')`));
 const coded=companies.map(c=>({id:c.id,name:c.name,code:allocationCompanyCode(c)}));
 const organisation:NonNullable<InformationOptions['organisation']>=[];
 for(const co of coded){
  const departments=await tx.select({id:department.id,code:department.name,label:department.label}).from(department).where(and(eq(department.tenantId,ctx.tenantId),isNull(department.archivedAt),visibleLabelIdsCondition(department,'department',[co.id]))).orderBy(asc(department.name),asc(department.id));
  const positions=await tx.select({id:position.id,code:position.title,label:position.label}).from(position).where(and(eq(position.tenantId,ctx.tenantId),isNull(position.archivedAt),visibleLabelIdsCondition(position,'position',[co.id]))).orderBy(asc(position.title),asc(position.id));
  const units=await tx.select({id:businessUnit.id,code:businessUnit.code,label:businessUnit.name}).from(businessUnit).where(and(eq(businessUnit.tenantId,ctx.tenantId),isNull(businessUnit.archivedAt),visibleLabelIdsCondition(businessUnit,'business_unit',[co.id]))).orderBy(asc(businessUnit.name),asc(businessUnit.id));
  for(const [kind,rows] of [['department',departments],['position',positions],['business_unit',units]] as const)for(const row of rows)if(row.code)organisation.push({companyId:co.id,companyCode:co.code,kind,id:row.id,code:row.code,name:row.label?.trim()||row.code});
 }
 return {companies:coded,organisation};
});}

const LABELS_PER_KIND=60;
const pad=(n:number)=>String(n).padStart(3,'0');
let b:Base,fixture:ScaleFixture;
const personas=()=>Object.entries(fixture.personas) as [string,SessionContext][];

/** Per kind: every tenth label Global, the rest assigned to about a seventh of the companies, every ninth from the
 * fifth left with only the creation company the criteria trigger seeds, and every thirteenth from the seventh
 * archived. Short codes are missing, blank or set in turn, so the name fallback is exercised. Written as the owner
 * under the group administrator's tenant context, which Global criteria require. */
async function labelCatalogue(){
 const companies=fixture.companyIds,archivedAt=new Date();
 const shape=(i:number)=>({tenantId:b.tenantId,companyId:companies[(i*5)%companies.length]!,isGlobal:i%10===0,archivedAt:i%13===6?archivedAt:null});
 const shortCode=(i:number)=>i%4===0?null:i%4===1?'  ':`FX${pad(i)}`;
 const range=Array.from({length:LABELS_PER_KIND},(_,i)=>i);
 const group=adminCtx(b);
 const departments=await owner.withTenant(group,tx=>tx.insert(schema.department).values(range.map(i=>({...shape(i),name:`Fictional Scale Department ${pad(i)}`,label:shortCode(i)}))).returning({id:schema.department.id}));
 const positions=await owner.withTenant(group,tx=>tx.insert(schema.position).values(range.map(i=>({...shape(i),title:`Fictional Scale Position ${pad(i)}`,label:shortCode(i+1)}))).returning({id:schema.position.id}));
 const units=await owner.withTenant(group,tx=>tx.insert(schema.businessUnit).values(range.map(i=>({...shape(i),code:`FXBU${pad(i)}`,name:`Fictional Scale Unit ${pad(LABELS_PER_KIND-i)}`,label:shortCode(i+2)}))).returning({id:schema.businessUnit.id}));
 const assignments=([['department',departments],['position',positions],['business_unit',units]] as const).flatMap(([labelKind,rows])=>rows.flatMap((row,i)=>
  i%10===0||i%9===5?[]:companies.flatMap((companyId,j)=>(i+j)%7===0?[{tenantId:b.tenantId,labelKind,labelId:row.id,companyId}]:[])));
 // The creation company is already seeded for a scoped label.
 for(let i=0;i<assignments.length;i+=500)await owner.withTenant(group,tx=>tx.insert(schema.labelCompanyAssignment).values(assignments.slice(i,i+500)).onConflictDoNothing());
 await owner.db.execute(sql`analyze public.department, public.position, public.business_unit, public.label_company_assignment`);
 return assignments.length;
}

let assigned=0;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();
 b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1000,events:0});
 assigned=await labelCatalogue();
},300_000);
afterAll(closeAll);

describe('information correction options read set-wise answer exactly as the per-company reader did',()=>{
 it('returns the same companies and organisation catalogue, order included, for every persona',async()=>{
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);
  expect(fixture.employmentIds.length).toBeGreaterThanOrEqual(1000);
  expect(assigned).toBeGreaterThan(0);
  for(const [name,ctx] of personas()){
   const now=await informationCorrectionOptions(ctx),before=await legacyCompaniesAndOrganisation(ctx);
   expect({companies:now.companies,organisation:now.organisation},name).toEqual(before);
  }
  // The fixture is not trivial: "All companies" covers every company and each kind; one company sees only its own.
  const group=await informationCorrectionOptions(fixture.personas.group),single=await informationCorrectionOptions(fixture.personas.single);
  expect(group.companies.length).toBe(fixture.companyIds.length);
  expect(single.companies.map(row=>row.id)).toEqual([fixture.singleCompanyId]);
  for(const kind of ['department','position','business_unit'] as const){
   expect(group.organisation!.filter(row=>row.kind===kind).length,kind).toBeGreaterThan(fixture.companyIds.length);
   expect(single.organisation!.some(row=>row.kind===kind),kind).toBe(true);
  }
  expect(new Set(group.organisation!.map(row=>row.companyId)).size).toBe(fixture.companyIds.length);
  // A blank short code falls back to the name, as before.
  expect(group.organisation!.some(row=>row.kind==='department'&&row.name===row.code&&row.code.startsWith('Fictional Scale Department'))).toBe(true);
 },120_000);

 it('reads the catalogue in a fixed number of statements, however many companies the persona sees',async()=>{
  const group=await observeStatements(()=>informationCorrectionOptions(fixture.personas.group));
  const multi=await observeStatements(()=>informationCorrectionOptions(fixture.personas.multi));
  const single=await observeStatements(()=>informationCorrectionOptions(fixture.personas.single));
  expect(group.statements.length).toBe(single.statements.length);
  expect(multi.statements.length).toBe(single.statements.length);
  // The previous reader ran three statements per company.
  const legacyGroup=await observeStatements(()=>legacyCompaniesAndOrganisation(fixture.personas.group));
  const legacySingle=await observeStatements(()=>legacyCompaniesAndOrganisation(fixture.personas.single));
  expect(legacyGroup.statements.length-legacySingle.statements.length).toBe(3*(fixture.companyIds.length-1));
 },120_000);
});
