/** Storage-owner readers of the System Labels catalogue while an import is staged (migration 9961). The owner
 * connection bypasses row security, so every reader there that enumerates a catalogue table filters staged codes
 * explicitly (core/system-label-visibility.ts); readers that follow a stored reference cannot meet one. The audit
 * ledger is in docs/adr/2026-11-10-system-label-import-staged-job.md. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import * as s from '../db/schema';
import {createJobGrade} from '../core/admin';
import {previewSystemLabelImport} from '../core/system-label-import';
import {startSystemLabelImportJob} from '../core/system-label-import-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {releasedLabelRows,type SystemLabelCatalogueTable} from '../core/system-label-visibility';
import {buildSystemLabelWorkbook} from '../lib/system-label-workbook';
import {approvalRuleLabelNames} from '../scripts/lib/approval-rule-label-names';
import {resetHealthGrades} from '../scripts/reset-entitlement-configuration';
import {loadCriteriaCatalogues} from '../scripts/entitlement-criteria-words';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

vi.hoisted(()=>{process.env.SYSTEM_LABEL_IMPORT_CHUNK_BUDGET_MS='1';});
let b:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();await createJobGrade(adminCtx(b),{code:'OWN_BASE',name:'Fictional owner-reader base grade',rank:1});});
afterAll(closeAll);

const tables:[string,SystemLabelCatalogueTable][]=[['department',s.department],['position',s.position],['cost_center',s.costCenter],['business_unit',s.businessUnit],
 ['label_company_assignment',s.labelCompanyAssignment],['profile_option',s.profileOption],['job_grade',s.jobGrade],['grade_group',s.gradeGroup],['grade_group_member',s.gradeGroupMember]];
const tick=()=>runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS});
async function stage(){
 const org=(code:string)=>({Code:code,Label:`Fictional ${code}`,Description:`Fictional ${code} description`,Company:b.companyId,Criteria:'companies','Criteria Companies':b.companyId,Status:'Active'});
 const bytes=await buildSystemLabelWorkbook({kinds:['department','position','cost_center','business_unit','division','grades','grade_groups'],includeStatus:true,references:{companies:[],grades:[],employees:[]},rows:{
  department:[org('OWN_DEPT')],position:[org('OWN_POS')],cost_center:[org('OWN_CC')],business_unit:[org('OWN_BU')],
  division:[{Code:'OWN_DIV',Label:'Fictional owner division',Status:'Active'}],grades:[{Code:'OWN_G1',Label:'Fictional owner grade',Rank:'2',Status:'Active'}],
  grade_groups:[{Name:'Fictional owner group','Grade Codes':'OWN_BASE'}]}});
 const ctx=adminCtx(b),preview=await previewSystemLabelImport(ctx,bytes);expect(preview.valid).toBe(true);
 const {job}=await startSystemLabelImportJob(ctx,{bytes,token:preview.token,operationKey:randomUUID()});
 const state=async()=>(await owner.client<{state:string}[]>`select state from bulk_job where id=${job.id}::uuid`)[0].state;
 const until=async(want:string[])=>{for(let i=0;i<600;i++){const now=await state();if(want.includes(now))return now;if(!await tick())await new Promise(r=>setTimeout(r,30));}throw new Error('job stuck');};
 expect(await until(['finalizing'])).toBe('finalizing');
 return{release:async()=>expect(await until(['completed','failed'])).toBe('completed')};
}
const ownCodes=(names:Iterable<string>)=>[...names].filter(n=>/OWN_(DEPT|POS|CC|BU|G1|DIV)|Fictional owner (grade|group|division)/.test(n)).sort();

describe('storage-owner readers while a System Labels import is staged',{timeout:240_000},()=>{
 it('filters staged rows in all nine catalogue tables through the shared owner-side predicate',async()=>{
  const {release}=await stage();
  for(const [name,table] of tables){
   const [physical]=await owner.client.unsafe<{n:number}[]>(`select count(*)::int n from public.${name==='position'?'"position"':name} where tenant_id=$1 and import_pending_attempt_id is not null`,[b.tenantId]);
   expect(physical.n,name).toBeGreaterThan(0);
   const visible=await owner.db.select({n:sql<number>`count(*)::int`}).from(table).where(and(eq(table.tenantId,b.tenantId),releasedLabelRows(table),sql`${sql.identifier(name)}.import_pending_attempt_id is not null`));
   expect(visible[0].n,name).toBe(0);
  }
  await release();
  for(const [name,table] of tables){
   const visible=await owner.db.select({n:sql<number>`count(*)::int`}).from(table).where(and(eq(table.tenantId,b.tenantId),releasedLabelRows(table),sql`${sql.identifier(name)}.import_pending_attempt_id is not null`));
   expect(visible[0].n,name).toBeGreaterThan(0);
  }
 });

 it('keeps staged codes out of the unreachable-approval-rules report names until release',async()=>{
  const {release}=await stage();
  const staged=await approvalRuleLabelNames(owner.db,b.tenantId);
  expect(ownCodes(Object.values(staged).flatMap(map=>[...map.values()]))).toEqual([]);
  expect(staged.departmentId.size).toBeGreaterThan(0);
  await release();
  const released=await approvalRuleLabelNames(owner.db,b.tenantId);
  expect(ownCodes(Object.values(released).flatMap(map=>[...map.values()]))).toEqual(['Fictional OWN_BU description','Fictional owner grade','Fictional owner group','OWN_DEPT','OWN_POS'].sort());
 });

 it('keeps staged grades and codes out of the entitlement-reset health and criteria catalogues until release',async()=>{
  const {release}=await stage();
  const names=async()=>{
   const grades=(await resetHealthGrades(owner.db,b.tenantId)).map(g=>g.name);
   const c=await owner.db.transaction(tx=>loadCriteriaCatalogues(tx,b.tenantId));
   return{grades,catalogues:[...c.departments.map(x=>x.name),...c.grades.map(x=>x.name),...c.positions.map(x=>x.title),...c.costCenters.map(x=>x.code),
    ...c.businessUnits.map(x=>x.code),...Object.values(c.profileOptions).flatMap(list=>(list??[]).map(o=>o.value))]};
  };
  const before=await names();
  expect(ownCodes(before.grades)).toEqual([]);expect(ownCodes(before.catalogues)).toEqual([]);
  expect(before.grades).toContain('Fictional owner-reader base grade');
  await release();
  const after=await names();
  expect(ownCodes(after.grades)).toEqual(['Fictional owner grade']);
  expect(ownCodes(after.catalogues)).toEqual(['Fictional owner grade','OWN_BU','OWN_CC','OWN_DEPT','OWN_DIV','OWN_POS'].sort());
 });

 it('pairs every catalogue read of the changed owner-connection readers with the staged-row predicate',()=>{
  const read=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
  const fromCatalogue=/\.from\((department|position|costCenter|businessUnit|labelCompanyAssignment|profileOption|jobGrade|gradeGroup|gradeGroupMember)\)/g;
  const slice=(text:string,start:string)=>{const i=text.indexOf(start);expect(i,start).toBeGreaterThan(-1);const j=text.indexOf('\n}',i);return text.slice(i,j);};
  for(const [path,fn] of [['../scripts/lib/approval-rule-label-names.ts','export async function approvalRuleLabelNames('],
   ['../scripts/reset-entitlement-configuration.ts','export async function resetHealthGrades('],['../scripts/entitlement-criteria-words.ts','export async function loadCriteriaCatalogues(']] as const){
   const body=slice(read(path),fn);
   const reads=[...body.matchAll(fromCatalogue)].map(m=>m[1]);
   expect(reads.length,fn).toBeGreaterThan(0);
   for(const table of reads)expect(body,`${fn} ${table}`).toContain(`releasedLabelRows(${table})`);
  }
  // The report no longer reads the catalogue itself; it uses the filtered helper.
  const report=read('../scripts/report-unreachable-approval-rules.ts');
  expect(report).not.toMatch(fromCatalogue);expect(report).toContain('approvalRuleLabelNames(owner.db, t.id)');
 });
});
