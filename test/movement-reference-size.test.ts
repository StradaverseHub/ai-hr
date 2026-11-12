/**
 * Movement template Reference size (production: "Download template" refused with
 * movement_reference_catalog_too_large for 42 companies). A value every company in the template offers — a global
 * position, department or business unit, a tenant-wide grade or profile option — is listed ONCE under "All companies";
 * company-scoped labels, locations and managers stay per company. The Reference sheet is documentation: the upload
 * never reads it and the signature binds the movement-type catalogue, so a fresh download uploads unchanged.
 * Synthetic fixtures only (fictional companies, codes and people).
 */
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import * as XLSX from 'xlsx';
import {buildMovementWorkbook,movementReferenceSheet,readMovementSource,MOVEMENT_WORKBOOK_SHEET_ROWS,type MovementTemplateCompany} from '../lib/movement-workbook.server';
import {movementColumnCaptions,movementSystemFields} from '../lib/movement-import-rows';
import {movementImportIssueText} from '../lib/movement-import-issues';
import type {MovementImportCatalog,MovementImportOption} from '../core/movement-import';
import type {MovementFormField} from '../lib/movement-form-contract';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

const tenant='11111111-1111-4111-8111-111111111111';
const BEHAVIOURS=['increment','salaryAdjustment','promotion','demotion','confirmation','probationExtension','actingPosition','secondment','transfer','orgAssignmentChange','entityTransfer','employmentTypeChange','reportingLineChange','resignation','termination','blacklist'];
const types=BEHAVIOURS.map(behaviour=>({code:behaviour.toLowerCase(),label:behaviour[0].toUpperCase()+behaviour.slice(1),behaviour}));
const fallback=(_key:string,text:string)=>text;
const messages=(bundle:unknown)=>(key:string,text:string)=>{const v=key.split('.').reduce<unknown>((o,k)=>(o as Record<string,unknown>)?.[k],bundle);return typeof v==='string'?v:text;};
const ORG_FIELDS=['orgDivision','employmentCategory','orgRegion','orgBranch','orgTeam','orgSection','orgLine','orgBase'] as const;
const REFERENCE_FIELDS:MovementFormField[]=['businessUnitId','departmentId','positionId','gradeId','locationId','managerEmploymentId',...ORG_FIELDS];
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const companyId=(i:number)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
const companyCode=(i:number)=>`FIC${String(i+1).padStart(3,'0')}`;
type Shape={companies:number;positions:number;departments:number;grades:number;units:number;orgOptions:number;managers:number;locationsPerCompany:number};
/** Production on 12 November 2026: 42 companies, every one of 1,156 positions global, 28 global departments, 26 grades,
 * about 213 organisation profile options and 3,498 managers. Business units and locations per company are assumed. */
const PRODUCTION:Shape={companies:42,positions:1156,departments:28,grades:26,units:8,orgOptions:213,managers:3498,locationsPerCompany:2};
const FOUR_TIMES:Shape={companies:168,positions:4624,departments:112,grades:104,units:32,orgOptions:852,managers:13_992,locationsPerCompany:2};
const list=(n:number,prefix:string,label:string):MovementImportOption[]=>Array.from({length:n},(_,i)=>({value:`${prefix.toLowerCase()}-${i}`,codes:[`${prefix}${String(i+1).padStart(5,'0')}`],label:`${label} ${i+1}`}));
/** A tenant shaped like the catalogue core/movement-import.ts assembles: global label lists are the same for every
 * company, profile options and grades are tenant-wide, locations are the company's own, and every catalogue holds
 * the tenant's managers with their company (the template keeps only the company's own eligible ones). */
function tenantShape(shape:Shape):MovementTemplateCompany[]{
 const positions=list(shape.positions,'P','Fictional position'),departments=list(shape.departments,'D','Fictional department'),grades=list(shape.grades,'G','Fictional grade'),units=list(shape.units,'U','Fictional unit');
 const managers:MovementImportOption[]=Array.from({length:shape.managers},(_,i)=>({value:`manager-${i}`,codes:[`E${String(i+1).padStart(6,'0')}`],label:`Fictional manager ${i+1}`,companyId:companyId(i%shape.companies),eligible:true,isTestRecord:false}));
 const org=Object.fromEntries(ORG_FIELDS.map((field,f)=>[field,Array.from({length:Math.floor(shape.orgOptions/ORG_FIELDS.length)+(f<shape.orgOptions%ORG_FIELDS.length?1:0)},(_,i)=>({value:`${field}-${i}`,label:`Fictional ${field} ${i+1}`}))]));
 const companies=Array.from({length:shape.companies},(_,c)=>({value:companyId(c),label:`Fictional Company ${c+1}`}));
 return companies.map((company,c)=>({companyId:company.value,code:companyCode(c),name:company.label,catalog:{types,companies,fields:{businessUnitId:units,departmentId:departments,positionId:positions,gradeId:grades,managerEmploymentId:managers,locationId:list(shape.locationsPerCompany,`L${c}-`,`Fictional site ${c+1}`),...org}} satisfies MovementImportCatalog}));
}
const captions=(resolve=fallback)=>movementColumnCaptions(resolve);
const sheetOf=(companies:MovementTemplateCompany[],resolve=fallback)=>movementReferenceSheet({types,companies,resolve,captions:captions(resolve)});
/** The allowed values a company documents for a field, derived from the fixture independently of the generator. */
function expectedValues(company:MovementTemplateCompany,field:MovementFormField){
 return (company.catalog.fields[field]??[]).filter(o=>field!=='managerEmploymentId'||o.companyId===company.companyId&&o.eligible&&!o.isTestRecord).map(o=>[o.codes?.[0]??o.value,o.label||o.codes?.[0]||o.value].join('|'));
}
/** Rows of the "Allowed values" block that name a company cell (Company ID or All companies). */
function valueRows(reference:string[][]){
 const at=reference.findIndex(r=>r[2]==='Value to enter in After');expect(at).toBeGreaterThan(0);
 return reference.slice(at+1).filter(r=>r[0]);
}
/** What the previous generator wrote: the same sheet with every company's full list repeated under its Company ID. */
function previousRowCount(companies:MovementTemplateCompany[],reference:string[][],fieldLabels:Map<string,string>){
 const repeated=companies.reduce((sum,company)=>sum+REFERENCE_FIELDS.filter(f=>fieldLabels.has(f)).reduce((n,f)=>n+expectedValues(company,f).length,0),0);
 return reference.length-valueRows(reference).length+repeated;
}
function assertSameAllowedValues(companies:MovementTemplateCompany[],reference:string[][],fieldLabels:Map<string,string>,all='All companies'){
 const rows=valueRows(reference),codes=new Set(companies.map(c=>c.code));
 expect(rows.every(r=>r[0]===all||codes.has(r[0]))).toBe(true);
 for(const company of companies)for(const field of REFERENCE_FIELDS){
  const label=fieldLabels.get(field);if(!label)continue;
  const shared=rows.filter(r=>r[0]===all&&r[1]===label).map(r=>r[2]+'|'+r[3]),own=rows.filter(r=>r[0]===company.code&&r[1]===label).map(r=>r[2]+'|'+r[3]);
  // Exactly the company's allowed set: the shared rows plus its own rows, nothing listed twice and nothing extra.
  expect(new Set([...shared,...own])).toEqual(new Set(expectedValues(company,field)));
  expect(own.filter(v=>shared.includes(v))).toEqual([]);
 }
}
async function fill(bytes:Buffer,values:string[][]){const wb=XLSX.read(bytes,{type:'buffer',cellFormula:true});const sheet=wb.Sheets.Movements;values.forEach((row,r)=>row.forEach((v,c)=>{sheet[XLSX.utils.encode_cell({r:r+1,c})]={t:'s',v};}));const range=XLSX.utils.decode_range(sheet['!ref']!);range.e.r=Math.max(range.e.r,values.length);sheet['!ref']=XLSX.utils.encode_range(range);return Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}));}
const source=(bytes:Buffer)=>readMovementSource('movement-import.xlsx',bytes,{tenantId:tenant,types,resolve:fallback});
beforeEach(()=>{vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY',Buffer.alloc(32,5).toString('base64url'));vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY_ID','public-fixture-only');});
afterEach(()=>{vi.unstubAllEnvs();});

describe('Movement template Reference size',()=>{
 it('fits the production shape well inside the Reference bound; the previous layout did not fit',()=>{
  const companies=tenantShape(PRODUCTION),{reference,fieldLabels}=sheetOf(companies);
  for(const field of ['businessUnitId','departmentId','positionId','gradeId','locationId','managerEmploymentId'])expect(fieldLabels.has(field)).toBe(true);
  const before=previousRowCount(companies,reference,fieldLabels),after=reference.length;
  console.info(`[movement reference rows] production shape: before ${before}, after ${after}, bound ${MOVEMENT_WORKBOOK_SHEET_ROWS.Reference}`);
  expect(before).toBeGreaterThan(MOVEMENT_WORKBOOK_SHEET_ROWS.Reference);
  expect(after).toBeLessThan(MOVEMENT_WORKBOOK_SHEET_ROWS.Reference/4);
  const rows=valueRows(reference),position=fieldLabels.get('positionId')!,manager=fieldLabels.get('managerEmploymentId')!,site=fieldLabels.get('locationId')!;
  expect(rows.filter(r=>r[1]===position).every(r=>r[0]==='All companies')).toBe(true);expect(rows.filter(r=>r[1]===position)).toHaveLength(PRODUCTION.positions);
  expect(rows.filter(r=>r[1]===manager).every(r=>r[0]!=='All companies')).toBe(true);expect(rows.filter(r=>r[1]===manager)).toHaveLength(PRODUCTION.managers);
  expect(rows.filter(r=>r[1]===site&&r[0]===companyCode(7))).toHaveLength(PRODUCTION.locationsPerCompany);
  assertSameAllowedValues(companies,reference,fieldLabels);
  expect(reference.flat().some(v=>UUID.test(v))).toBe(false);
 });

 it('stays under half the Reference bound for a tenant four times the production shape',()=>{
  const companies=tenantShape(FOUR_TIMES),{reference,fieldLabels}=sheetOf(companies);
  const before=previousRowCount(companies,reference,fieldLabels),after=reference.length;
  console.info(`[movement reference rows] 4x production shape: before ${before}, after ${after}, bound ${MOVEMENT_WORKBOOK_SHEET_ROWS.Reference}`);
  expect(after).toBeLessThan(MOVEMENT_WORKBOOK_SHEET_ROWS.Reference/2);
  assertSameAllowedValues(companies,reference,fieldLabels);
 });

 // Measured on a standard GitHub runner (run 43183657279): production-shape round trip 1.8 s, four-times build and read 4.0 s.
 it('downloads the production-shape template and uploads it back unchanged, and with one valid entered row',async()=>{
  const companies=tenantShape(PRODUCTION),bytes=await buildMovementWorkbook({tenantId:tenant,types,companies,resolve:fallback});
  const wb=XLSX.read(bytes,{type:'buffer'});expect(wb.SheetNames).toEqual(['Instructions','Movements','Reference','Lists','_meta']);
  const reference=XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Reference,{header:1,defval:''});
  const position=movementSystemFields(types.find(t=>t.behaviour==='promotion')!,fallback).find(f=>f.key==='positionId')!.label;
  // The value to enter is documented once, under All companies, and is in every company's own catalogue.
  expect(reference.filter(r=>r[2]==='P00001').map(r=>r.slice(0,2))).toEqual([['All companies',position]]);
  expect(companies.every(c=>c.catalog.fields.positionId!.some(o=>o.codes?.[0]==='P00001'))).toBe(true);
  expect(await source(bytes)).toEqual({records:[],fileErrors:['no_movement_entries']});
  const one=await source(await fill(bytes,[[companyCode(41),'E1001','Alex Example','01-Jan-2027','Promotion',position,'','P00001']]));
  expect(one.fileErrors).toEqual([]);expect(one.records).toHaveLength(1);
  expect(one.records[0]).toMatchObject({row:2,companyCode:companyCode(41),employeeCode:'E1001',errors:[],cells:{kind:'promotion',positionId:'P00001'}});
 },60_000);

 it('builds and reads back the four-times template inside the archive, cell and byte budgets',async()=>{
  const bytes=await buildMovementWorkbook({tenantId:tenant,types,companies:tenantShape(FOUR_TIMES),resolve:fallback});
  expect(await source(bytes)).toEqual({records:[],fileErrors:['no_movement_entries']});
 },60_000);

 it('lists shared values once and company-scoped values per company when a tenant mixes global and company labels',()=>{
  const options=(...rows:[string,string][])=>rows.map(([code,label])=>({value:code.toLowerCase(),codes:[code],label}));
  const ids=[0,1,2].map(companyId),codes=['FICA','FICB','FICC'];
  const companies:MovementTemplateCompany[]=[
   options(['G1','Global one'],['G2','Global two'],['A1','Only A'],['AB','A and B'],['X','Same code']),
   options(['AB','A and B'],['G1','Global one'],['G2','Global two'],['X','Same code']),
   options(['G2','Global two'],['G1','Global one'],['X','Other meaning']),
  ].map((positions,c)=>({companyId:ids[c],code:codes[c],name:`Fictional ${codes[c]}`,catalog:{types,companies:[],fields:{
   positionId:positions,departmentId:options(['D1','Shared department']),locationId:options([`S${c}`,`Site ${c}`]),
   managerEmploymentId:[...ids.map((id,i)=>({value:`m${i}`,codes:[`E${i}`],label:`Manager ${i}`,companyId:id,eligible:true})),{value:'mt',codes:['ET'],label:'Test manager',companyId:ids[c],eligible:true,isTestRecord:true},{value:'mx',codes:['EX'],label:'Left',companyId:ids[c],eligible:false}],
  }}}));
  const {reference,fieldLabels}=sheetOf(companies),label=(f:string)=>fieldLabels.get(f)!;
  expect(valueRows(reference)).toEqual([
   ['All companies',label('departmentId'),'D1','Shared department'],
   ['All companies',label('positionId'),'G1','Global one'],['All companies',label('positionId'),'G2','Global two'],
   ['FICA',label('positionId'),'A1','Only A'],['FICA',label('positionId'),'AB','A and B'],['FICA',label('positionId'),'X','Same code'],['FICA',label('locationId'),'S0','Site 0'],['FICA',label('managerEmploymentId'),'E0','Manager 0'],
   ['FICB',label('positionId'),'AB','A and B'],['FICB',label('positionId'),'X','Same code'],['FICB',label('locationId'),'S1','Site 1'],['FICB',label('managerEmploymentId'),'E1','Manager 1'],
   ['FICC',label('positionId'),'X','Other meaning'],['FICC',label('locationId'),'S2','Site 2'],['FICC',label('managerEmploymentId'),'E2','Manager 2'],
  ]);
  assertSameAllowedValues(companies,reference,fieldLabels);
  // Only the companies in the template are compared and listed: a company the admin cannot maintain never appears.
  const two=sheetOf(companies.slice(0,2));expect(valueRows(two.reference).some(r=>r[0]==='FICC'||r[3]==='Other meaning'||r[2]==='S2')).toBe(false);
  expect(valueRows(two.reference).filter(r=>r[0]==='All companies').map(r=>r[2])).toEqual(['D1','G1','G2','AB','X']);
 });

 it('keeps a single-company template under its own Company ID',()=>{
  const [company]=tenantShape({...PRODUCTION,companies:1,positions:3,managers:2});const {reference}=sheetOf([company]);
  const rows=valueRows(reference);expect(rows.length).toBeGreaterThan(0);expect(rows.every(r=>r[0]===company.code)).toBe(true);
 });

 it('uploads a template whose Reference sheet has the previous per-company layout exactly as before: the sheet is not signed',async()=>{
  const companies=tenantShape({...PRODUCTION,companies:3,positions:4,managers:3}),bytes=await buildMovementWorkbook({tenantId:tenant,types,companies,resolve:fallback});
  const wb=XLSX.read(bytes,{type:'buffer'}),reference=XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Reference,{header:1,defval:''});
  const previous=reference.flatMap(r=>r[0]==='All companies'?companies.map(c=>[c.code,...r.slice(1)]):[r]);
  wb.Sheets.Reference=XLSX.utils.aoa_to_sheet(previous);
  const rewritten=Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}));
  expect(await source(rewritten)).toEqual({records:[],fileErrors:['no_movement_entries']});
 },60_000);

 it('uses fixed translated copy for All companies and the template-size refusal in every maintained locale',async()=>{
  const bundles={en,ms,ta,th,vi:vi_,zh};
  for(const [locale,bundle]of Object.entries(bundles)){
   const m=(bundle as unknown as {people:{import:{movement:{sheet:Record<string,string>;issues:Record<string,string>}}}}).people.import.movement;
   expect(m.sheet.allCompanies,locale).toMatch(/\S/);
   expect(m.issues.movement_template_too_large,locale).toMatch(/\S/);
   expect(m.issues.movement_template_too_large,locale).not.toBe(m.issues.movement_reference_catalog_too_large);
   expect(movementImportIssueText(['movement_template_too_large'],messages(bundle)),locale).toBe(m.issues.movement_template_too_large);
  }
  expect(en.people.import.movement.issues.movement_template_too_large).toMatch(/template is too large to build/i);
  expect(en.people.import.movement.issues.movement_template_too_large).not.toMatch(/Personnel/);
  const companies=tenantShape({...PRODUCTION,companies:2,positions:2,managers:2});
  expect(valueRows(sheetOf(companies,messages(en)).reference).some(r=>r[0]==='All companies')).toBe(true);
  const malay=sheetOf(companies,messages(ms)).reference;
  expect(malay.some(r=>r[0]===ms.people.import.movement.sheet.allCompanies)).toBe(true);expect(malay.some(r=>r[0]==='All companies')).toBe(false);
 });
});
