/** ADR 0181 / docs/SCALE-AND-RELEASE-RULES.md rules 2 and 3: the Personnel import page (app/admin/personnel/import/page.tsx)
 * reads its catalogs once, never once per company.
 *
 * Staging (25 November 2026) measured about 320 transactions per load of /admin/personnel/import on a group of 300+
 * companies, and the same again after a section import (commitSectionAction revalidates the page): the page read four
 * System Label lists PER VISIBLE COMPANY. It now reads each list once in one read-only snapshot transaction
 * (core/personnel-import-reference.ts) and partitions them by company in memory.
 *
 * On the fictional 71-company / 1,000-employment group fixture (test/helpers/ai-centre-scale-fixture.ts), with System
 * Labels that are Global, company-scoped, shared to several companies, archived, and hidden from a company administrator,
 * this proves:
 *  - equivalence with the previous reader: for every administrator role and every company it sees, each company's
 *    departments, positions, cost centres and business units are the same rows in the same order as the former
 *    per-company reads (`listX(ctx, {companyIds:[company]})`);
 *  - scale: the page render for 71 companies costs no more transactions or statements than for one company, and stays
 *    within BUDGET; the previous per-company reader's cost is printed beside it for the release notes;
 *  - authorization: a non-administrator is redirected before any catalog is read, and a single-company administrator's
 *    render names only that company and never a label it cannot see.
 * Every measurement is printed as one `IMPORT_PAGE_BUDGET {json}` line. All names are invented. */
import {createElement} from 'react';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({session:undefined as unknown,cookies:{} as Record<string,string>}));
vi.mock('next/headers',()=>({
 headers:async()=>new Headers({'x-pathname':'/admin/personnel/import'}),
 cookies:async()=>({get:(name:string)=>name in state.cookies?{name,value:state.cookies[name]}:undefined,
  getAll:()=>Object.entries(state.cookies).map(([name,value])=>({name,value})),has:(name:string)=>name in state.cookies}),
}));
vi.mock('next-intl/server',()=>{
 const translator=(namespace?:string)=>{
  const t=(key:string,values?:Record<string,unknown>)=>`${namespace?namespace+'.':''}${key}${values?JSON.stringify(values):''}`;
  return Object.assign(t,{rich:t,markup:t,raw:(key:string)=>key,has:()=>true});
 };
 return {getLocale:async()=>'en',getTranslations:async(arg?:string|{namespace?:string})=>translator(typeof arg==='string'?arg:arg?.namespace)};
});
vi.mock('../lib/session',async importOriginal=>({...await importOriginal<typeof import('../lib/session')>(),
 getSession:async()=>state.session,getBrowserCommandSession:async()=>state.session}));

import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import ImportPage from '../app/admin/personnel/import/page';
import {listCompanies,listDepartments} from '../core/read';
import {bulkSaveLabels,listBusinessUnits,listCostCenters,listPositions} from '../core/admin';
import {organisationLabelsForCompany,readPersonnelImportCatalogs} from '../core/personnel-import-reference';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';
import {serverTreeSnapshot} from './helpers/server-tree-snapshot';

/** Recorded page budget at "All companies" on the 71-company fixture: one read-only snapshot transaction for every
 * catalog. Budgets only go down; raising one needs an ADR note (docs/plans/2026-11-24-database-read-cost-phase-0-1.md). */
const BUDGET={transactions:1,statements:9};

let b:Base,fixture:ScaleFixture;
let personas:Record<'group'|'multi'|'single',SessionContext>;
/** A label kept from the single-company administrator: scoped only to a company it does not administer. */
let hiddenFromSingle:string;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1000,events:200});
 personas={...fixture.personas};
 // System Labels across the group, created through the native owner so every row has real Criteria: Global labels,
 // labels scoped to their own company, labels shared to two or three companies, and archived labels.
 const admin=adminCtx(b),companies=fixture.companyIds;
 const kinds=['department','position','cost_center','business_unit'] as const;
 for(const kind of kinds){
  const creates=Array.from({length:48},(_,i)=>{
   const origin=companies[(i*5+1)%companies.length];
   const shared=i%6===2?[origin,companies[(i*7+3)%companies.length],fixture.singleCompanyId]:i%6===4?[origin,companies[(i*11+2)%companies.length]]:[origin];
   const text=`FX ${kind.replace('_',' ')} ${String(i).padStart(2,'0')}`;
   return {key:`${kind}-${i}`,companyId:origin,isGlobal:i%8===0,companyIds:i%8===0?[]:[...new Set(shared)],archived:i%9===5,
    name:text,title:text,code:`FX-${kind.toUpperCase()}-${String(i).padStart(2,'0')}`,label:i%3===0?`L${i}`:undefined,description:i%4===1?`Fictional ${kind} ${i}`:undefined};
  });
  const saved=await bulkSaveLabels(admin,kind,{creates,updates:[]});
  expect(saved.created).toBe(creates.length);
 }
 // One department scoped only to a company the single-company administrator does not administer.
 const other=companies.find(id=>id!==fixture.singleCompanyId&&id!==b.companyId)!;
 const hidden=await bulkSaveLabels(admin,'department',{creates:[{key:'hidden',companyId:other,isGlobal:false,companyIds:[other],name:'FX hidden from single',code:'FX-HIDDEN'}],updates:[]});
 hiddenFromSingle=hidden.createdIds[0].id;
 await owner.db.execute(sql`analyze public.department, public.position, public.cost_center, public.business_unit, public.label_company_assignment`);
},300_000);
afterAll(closeAll);

/** The page's former company-specific reads, kept verbatim as the previous reader: four owner reads per company. */
async function previousOrganisationLabels(ctx:SessionContext,companyIds:readonly string[]){
 return Object.fromEntries(await Promise.all(companyIds.map(async id=>{
  const [departments,positions,costCenters,businessUnits]=await Promise.all([listDepartments(ctx,{companyIds:[id]}),listPositions(ctx,{companyIds:[id]}),
   listCostCenters(ctx,{companyIds:[id]}),listBusinessUnits(ctx,{companyIds:[id]})]);
  return [id,{departments,positions,costCenters,businessUnits}] as const;
 })));
}
/** What the page renders from a label: its identity, code and display text, in order. `inUse` is never shown here. */
const shown=(rows:readonly {id:string;code:string|null;label:string|null;isGlobal:boolean;assignedCompanyIds:readonly string[]}[])=>
 rows.map(({id,code,label,isGlobal,assignedCompanyIds})=>({id,code,label,isGlobal,assignedCompanyIds}));

type Measured={persona:string;transactions:number;statements:number;ms:number;output:unknown};
async function render(persona:keyof typeof personas|SessionContext,label=typeof persona==='string'?persona:'custom'):Promise<Measured>{
 state.session=typeof persona==='string'?personas[persona]:persona;state.cookies={};
 const observed=await observeStatements(()=>serverTreeSnapshot(createElement(ImportPage))
  .catch((error:unknown)=>{const digest=(error as {digest?:unknown})?.digest;if(typeof digest==='string'&&digest.startsWith('NEXT_'))return {redirect:digest};throw error;}));
 const measured={persona:label,transactions:observed.transactions,statements:observed.statements.length,ms:Math.round(observed.ms),output:observed.result};
 console.log('IMPORT_PAGE_BUDGET '+JSON.stringify({reader:'page',persona:label,transactions:measured.transactions,statements:measured.statements,ms:measured.ms}));
 return measured;
}
/** The ImportWorkbench element's props in a rendered page (a client component, recorded as a leaf with its props). */
function workbenchProps(output:unknown):{companies:{id:string;name:string}[];reference:{organisationOptionsByCompany:Record<string,unknown>}}{
 let found:unknown;
 const walk=(node:unknown)=>{
  if(found||node===null||typeof node!=='object')return;
  if(Array.isArray(node)){node.forEach(walk);return;}
  const record=node as Record<string,unknown>;
  if(record.type==='ImportWorkbench'&&record.props){found=record.props;return;}
  Object.values(record).forEach(walk);
 };
 walk(output);
 if(!found)throw new Error('ImportWorkbench not rendered');
 return found as ReturnType<typeof workbenchProps>;
}

describe('Personnel import page: catalogs read once, not once per company',()=>{
 it.each(['group','multi','single'] as const)('gives %s the same company labels, rows and order as the previous per-company reader',async persona=>{
  const ctx=personas[persona];
  const catalogs=await readPersonnelImportCatalogs(ctx);
  const companyIds=(await listCompanies(ctx,{adminOnly:true})).map(company=>company.id);
  expect(catalogs.companies.map(company=>company.id)).toEqual(companyIds);
  expect(companyIds.length).toBe(persona==='single'?1:fixture.companyIds.length);
  const previous=await previousOrganisationLabels(ctx,companyIds);
  let compared=0;
  for(const id of companyIds){
   const now=organisationLabelsForCompany(catalogs,id),before=previous[id];
   for(const kind of ['departments','positions','costCenters','businessUnits'] as const){
    expect(shown(now[kind] as never),`${persona} ${id} ${kind}`).toEqual(shown(before[kind] as never));
    compared+=before[kind].length;
   }
  }
  // Nonempty slices: the comparison covered real labels in every kind, including Global and shared ones.
  expect(compared).toBeGreaterThan(companyIds.length*4);
  if(persona==='single'){
   const own=organisationLabelsForCompany(catalogs,fixture.singleCompanyId);
   expect(own.departments.map(row=>row.id)).not.toContain(hiddenFromSingle);
   expect(own.departments.some(row=>row.isGlobal)).toBe(true);
   expect(own.departments.some(row=>!row.isGlobal&&row.companyId!==fixture.singleCompanyId)).toBe(true);
  }
 },180_000);

 it('renders 71 companies in no more transactions or statements than one company, within budget',async()=>{
  await render('group');
  const all=await render('group'),multi=await render('multi'),one=await render('single');
  for(const measured of [all,multi,one])expect(JSON.stringify(measured.output).length).toBeGreaterThan(2000);
  expect(Object.keys(workbenchProps(all.output).reference.organisationOptionsByCompany)).toHaveLength(fixture.companyIds.length);
  expect(Object.keys(workbenchProps(one.output).reference.organisationOptionsByCompany)).toEqual([fixture.singleCompanyId]);
  expect(all.transactions,'group transactions').toBeLessThanOrEqual(one.transactions);
  expect(all.statements,'group statements').toBeLessThanOrEqual(one.statements);
  expect(multi.transactions,'multi transactions').toBeLessThanOrEqual(one.transactions);
  expect(multi.statements,'multi statements').toBeLessThanOrEqual(one.statements);
  for(const measured of [all,multi,one]){
   expect(measured.transactions,`${measured.persona} transactions`).toBeLessThanOrEqual(BUDGET.transactions);
   expect(measured.statements,`${measured.persona} statements`).toBeLessThanOrEqual(BUDGET.statements);
  }
  // The previous reader's cost on the same fixture, for the release notes: it grew with the number of companies.
  for(const persona of ['group','single'] as const){
   const ctx=personas[persona],ids=(await listCompanies(ctx,{adminOnly:true})).map(company=>company.id);
   const before=await observeStatements(()=>previousOrganisationLabels(ctx,ids));
   console.log('IMPORT_PAGE_BUDGET '+JSON.stringify({reader:'previous-company-labels',persona,companies:ids.length,transactions:before.transactions,statements:before.statements.length,ms:Math.round(before.ms)}));
   expect(before.transactions).toBe(ids.length*4);
  }
 },180_000);

 it('renders the same page twice (the measurement compares like with like)',async()=>{
  const first=await render('multi'),again=await render('multi');
  expect(again.output).toEqual(first.output);
 },120_000);

 it('redirects a non-administrator before reading any catalog',async()=>{
  const employee:SessionContext={...personas.single,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  const measured=await render(employee,'employee');
  expect(measured.output).toEqual({redirect:expect.stringContaining('NEXT_REDIRECT')});
  expect(measured.transactions).toBe(0);
 },60_000);

 it('names only the single-company administrator\'s company and keeps labels scoped elsewhere out of its guidance',async()=>{
  const one=await render('single'),props=workbenchProps(one.output);
  expect(props.companies.map(company=>company.id)).toEqual([fixture.singleCompanyId]);
  const [hidden]=await owner.db.select({name:schema.department.name,companyId:schema.department.companyId}).from(schema.department).where(sql`${schema.department.id}=${hiddenFromSingle}::uuid`);
  expect(hidden?.name).toBe('FX hidden from single');
  const values=(guidance:unknown)=>((guidance as {department:{value:string}[]}).department).map(option=>option.value);
  const own=values(props.reference.organisationOptionsByCompany[fixture.singleCompanyId]);
  expect(own.length).toBeGreaterThan(0);
  expect(own).not.toContain('FX hidden from single');
  // The group administrator sees it, and only under the company its Criteria name.
  const group=workbenchProps((await render('group')).output).reference.organisationOptionsByCompany;
  expect(values(group[hidden.companyId])).toContain('FX hidden from single');
  expect(values(group[fixture.singleCompanyId])).not.toContain('FX hidden from single');
 },120_000);
});
