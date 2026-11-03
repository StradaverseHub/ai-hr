/** AI v2 W1 — the capability catalogue cannot go stale silently. A new registry action, import owner, import surface or
 * destination that the catalogue has not classified fails here; so does an import whose declared access is not the guard
 * its own page uses. Also the semantic declaration of product_capabilities and the pure tool result. Reads source and
 * registries only; no database. */
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {describe,expect,it} from 'vitest';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {LINKABLE_PAGES,productDestinations} from '../lib/product-context/destinations';
import {MODULE_CATALOG} from '../packs/catalog';
import {ACTION_PURPOSE,SUGGESTABLE_ACTIONS} from '../core/product-context/actions';
import {IMPORT_OWNERS,IMPORT_PAGES,IMPORT_SUPPORT_FILES,MAX_CAPABILITY_ENTRIES,MODULE_AREA,PREPARED_ACTIONS,PRODUCT_CAPABILITIES_SPEC,areaOf,
 capabilitiesInput,capabilitiesResult,searchWords,type CatalogueEntry} from '../core/product-context/capability-catalogue';
import {CAPABILITY_KINDS,CATALOGUE_ENTITIES,CATALOGUE_READS} from '../core/semantic-model/entities-catalogue';
import {SEMANTIC_ACTIONS} from '../core/semantic-model/entities';
import {describeRead,terasEntities,terasEntity} from '../core/semantic-model/generate';
import type {SemanticField} from '../core/semantic-model/types';
import {registeredWorkers} from '../core/agent-registry/workers';

const root=process.cwd(),read=(file:string)=>readFileSync(join(root,file),'utf8');
function files(dir:string):string[]{const path=join(root,dir);if(!existsSync(path))return[];
 return readdirSync(path,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(dir,entry.name)):[join(dir,entry.name)]);}
const exportsName=(file:string,name:string)=>new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`).test(read(file));

describe('registry actions',()=>{
 it('classifies every registry action exactly once: an action entry, an import, or an automatic reminder',()=>{
  const imports=new Set(IMPORT_OWNERS.flatMap(row=>row.action?[row.action]:[])),suggestable=new Set<string>(SUGGESTABLE_ACTIONS.map(row=>row.id));
  const classified=AGENT_ACTIONS.map(action=>{
   if(imports.has(action.id))return[action.id,'import'];
   if(action.policy.tier==='automatic'||action.permission.actor==='agent_principal')return[action.id,'reminder'];
   return[action.id,suggestable.has(action.id)?'action':'unclassified'];
  });
  expect(classified.filter(([,kind])=>kind==='unclassified')).toEqual([]);
  // Every import action is a suggestable registry action, so it is offered by the same per-caller owner.
  for(const id of imports)expect(suggestable.has(id),id).toBe(true);
  // Every action entry has its plain title, and every registry module has an area.
  for(const action of SUGGESTABLE_ACTIONS){expect(ACTION_PURPOSE[action.id],action.id).toMatch(/^[A-Z].{8,}\.$/);expect(MODULE_AREA[action.module],action.module).toBeDefined();}
  for(const module of MODULE_CATALOG.map(row=>row.code))expect(MODULE_AREA[module],module).toBeDefined();
 });
 it('prepares exactly the actions the semantic model declares a proposal preparer for, each a registry action',()=>{
  expect([...PREPARED_ACTIONS].sort()).toEqual(SEMANTIC_ACTIONS.filter(action=>action.proposal!==null).map(action=>action.id).sort());
  expect([...PREPARED_ACTIONS]).toEqual(expect.arrayContaining(['leave.apply','leave.cancel','approvals.leave.decide']));
  for(const id of PREPARED_ACTIONS)expect(SUGGESTABLE_ACTIONS.some(action=>action.id===id),id).toBe(true);
 });
});

/** Every app file that serves an import: its import (whose access its guard must admit) or why it is not one. */
type Surface=string|readonly string[]|Readonly<{support:string}>;
const support=(why:string):Surface=>({support:why});
/** The imports a surface serves; none for support. */
const servedBy=(value:Surface):readonly string[]=>typeof value==='string'?[value]:'support' in value?[]:value;
const PERSONNEL_PAGE=['employee_records','employee_profile','employee_movement','bank_statutory','employee_family','employee_qualifications','employee_emergency_contacts','cost_allocation','information_correction'];
const SURFACES:Readonly<Record<string,Surface>>={
 'app/admin/card-assignment/import/route.ts':'clocking_cards',
 'app/admin/leave-config/bf-import/actions.ts':'leave_brought_forward',
 'app/admin/leave-config/bf-import/page.tsx':'leave_brought_forward',
 'app/admin/leave-config/data-import/page.tsx':['leave_history','leave_brought_forward'],
 'app/admin/leave-config/history-import/actions.ts':'leave_history',
 'app/admin/leave-config/history-import/page.tsx':'leave_history',
 'app/admin/leave-config/import/page.tsx':'leave_balances',
 'app/admin/leave/import/actions.ts':'leave_balances',
 'app/admin/leave/import/page.tsx':support('Redirect to the leave balance import page.'),
 'app/admin/pay-components/import/route.ts':'pay_codes',
 'app/admin/personnel/import/actions.ts':'employee_records',
 'app/admin/personnel/import/assistance-actions.ts':support('Header-mapping assistance of the employee import; its owner re-checks the caller.'),
 'app/admin/personnel/import/bank-statutory/jobs/[jobId]/errors/route.ts':'bank_statutory',
 'app/admin/personnel/import/bank-statutory/jobs/[jobId]/route.ts':'bank_statutory',
 'app/admin/personnel/import/bank-statutory/jobs/route.ts':'bank_statutory',
 'app/admin/personnel/import/bank-statutory/upload/route.ts':'bank_statutory',
 'app/admin/personnel/import/cost-allocation-actions.ts':'cost_allocation',
 'app/admin/personnel/import/cost-allocation/upload/route.ts':'cost_allocation',
 'app/admin/personnel/import/employee/upload/route.ts':'employee_records',
 'app/admin/personnel/import/history/[attemptId]/page.tsx':support('Shared personnel import history and revert.'),
 'app/admin/personnel/import/history/[attemptId]/source/route.ts':support('Shared personnel import history and revert.'),
 'app/admin/personnel/import/history/actions.ts':support('Shared personnel import history and revert.'),
 'app/admin/personnel/import/history/import-history-views.tsx':support('Shared personnel import history views.'),
 'app/admin/personnel/import/history/page.tsx':support('Shared personnel import history and revert.'),
 'app/admin/personnel/import/information-correction-template/route.ts':'information_correction',
 'app/admin/personnel/import/movement/route.ts':'employee_movement',
 'app/admin/personnel/import/page.tsx':PERSONNEL_PAGE,
 'app/admin/settings/system-labels/import-actions.ts':'system_labels',
 'app/admin/settings/system-labels/import/route.ts':'system_labels',
 'app/assistant/file-import-actions.ts':support('AI Centre file preparation (core/assistant-import.ts); it imports nothing.'),
 'app/assistant/import-privacy-actions.ts':support('AI Centre import privacy controls.'),
 'app/attendance/import/actions.ts':'attendance_clockings',
 'app/attendance/import/logs/[runId]/page.tsx':'attendance_clockings',
 'app/attendance/import/logs/page.tsx':'attendance_clockings',
 'app/attendance/import/page.tsx':'attendance_clockings',
 'app/lifecycle/actions.ts':support('Lifecycle server actions; the onboarding owner checks the staff level itself (asserted below).'),
 'app/lifecycle/onboarding/import/page.tsx':'onboarding_new_hires',
 'app/lifecycle/onboarding/import/template/route.ts':support('A blank onboarding template; it holds no data.'),
 'app/payroll/[batchId]/import-actions.ts':'run_pay_components',
 'app/payroll/history-import/logs/[attemptId]/page.tsx':'payroll_history',
 'app/payroll/history-import/logs/[attemptId]/report/route.ts':'payroll_history',
 'app/payroll/history-import/logs/[attemptId]/source/route.ts':'payroll_history',
 'app/payroll/history-import/logs/page.tsx':'payroll_history',
 'app/payroll/history-import/page.tsx':'payroll_history',
 'app/payroll/history-import/upload/route.ts':'payroll_history',
 'app/payroll/transactions/import-components/page.tsx':'run_pay_components',
 'app/payroll/transactions/import-excel/actions.ts':'fixed_transactions',
 'app/payroll/transactions/import-excel/individual-actions.ts':'individual_transactions',
 'app/payroll/transactions/individual/imports/[attemptId]/page.tsx':'individual_transactions',
 'app/payroll/transactions/individual/imports/page.tsx':'individual_transactions',
 'app/performance/onehr-actions.ts':support('Record-scoped KPI and panel imports inside one OneHR cycle, admitted per cycle; not listed.'),
 'app/rewards/actions.ts':support('Record-scoped facts import inside one rewards unit, admitted per unit; not listed.'),
 'app/roster/import/actions.ts':'shift_roster',
 'app/roster/import/page.tsx':'shift_roster',
};
/** The guard each access names, as the page and server action source spells it. */
const GUARD:Readonly<Record<string,RegExp>>={admin:/\b(?:requireAdmin|scopedAdmin)\(|\bisAdmin\(/,lifecycle_agent:/\blifecycleSession\(\s*LEVEL\.agent\s*\)/};
/** A page's source with every layout above it, below app/. */
function pageSource(path:string):string{
 const dir=join(root,'app',path),page=join(dir,'page.tsx');if(!existsSync(page))return'';
 let source=readFileSync(page,'utf8');for(let at=dir;at!==join(root,'app')&&at.startsWith(join(root,'app'));at=dirname(at)){const layout=join(at,'layout.tsx');if(existsSync(layout))source+=readFileSync(layout,'utf8');}
 return source;
}

describe('import owners',()=>{
 it('classifies every import-named core and pack file as an import owner or as support',()=>{
  const named=[...files('core'),...files('packs')].filter(file=>/\.ts$/.test(file)&&!/\.test\.ts$/.test(file)&&/import/i.test(file.split('/').pop()!)).sort();
  const owners=new Set(IMPORT_OWNERS.map(row=>row.owner.split('#')[0]));
  expect(named.filter(file=>!owners.has(file)&&!IMPORT_SUPPORT_FILES[file]),'unclassified import files').toEqual([]);
  for(const file of Object.keys(IMPORT_SUPPORT_FILES)){expect(existsSync(join(root,file)),file).toBe(true);expect(owners.has(file),file+' is an owner and support').toBe(false);}
  for(const row of IMPORT_OWNERS){const [file,name]=row.owner.split('#');expect(existsSync(join(root,file)),row.owner).toBe(true);expect(exportsName(file,name),row.owner).toBe(true);}
 });
 it('classifies every app import surface, and each serves real imports',()=>{
  const surfaces=files('app').filter(file=>/\.tsx?$/.test(file)&&((/^(page|route)\.tsx?$/.test(file.split('/').pop()!)&&file.split('/').slice(1,-1).some(part=>/import/i.test(part)))
   ||/export\s+async\s+function\s+\w*[Ii]mport\w*/.test(read(file)))).sort();
  expect(surfaces).toEqual(Object.keys(SURFACES).sort());
  const known=new Set(IMPORT_OWNERS.map(row=>row.id));
  for(const [file,value] of Object.entries(SURFACES))for(const id of servedBy(value))expect(known.has(id),file+' -> '+id).toBe(true);
  // Every import owner is served by at least one classified surface or its own page.
  for(const row of IMPORT_OWNERS)expect(Object.values(SURFACES).some(value=>servedBy(value).includes(row.id))||existsSync(join(root,'app',row.page.split('?')[0],'page.tsx')),row.id).toBe(true);
 });
 it('admits each import by the guard its own page and server actions use, and gates it by the page\'s module',()=>{
  for(const row of IMPORT_OWNERS){
   const path=row.page.split(/[?#]/)[0],source=pageSource(path);
   expect(source.length,row.id+' page '+path).toBeGreaterThan(0);
   expect(source,row.id+' page guard').toMatch(GUARD[row.access]);
   const gated=source.match(/\bmoduleLayout\(\s*'([a-z_-]+)'\s*\)|\brequireModule\(\s*'([a-z_-]+)'\s*\)/);
   const pageModule=gated?(gated[1]??gated[2]):GUARD.lifecycle_agent.test(source)?'lifecycle':null;
   // The catalogue may be stricter than the page (a module the page leaves to its service), never looser.
   if(pageModule!==null)expect(row.module,row.id+' module').toBe(pageModule);
   if(row.template!==null)expect(existsSync(join(root,'app',row.template,'route.ts')),row.id+' template '+row.template).toBe(true);
  }
  for(const [file,value] of Object.entries(SURFACES))
   for(const id of servedBy(value)){const row=IMPORT_OWNERS.find(item=>item.id===id)!;expect(read(file),file+' guard for '+id).toMatch(GUARD[row.access]);}
  // The onboarding owner refuses anyone below the lifecycle staff level, whichever action calls it.
  expect(read('core/lifecycle-cases.ts')).toMatch(/requireLevel\(tx,\s*p\.companyId,\s*LEVEL\.agent,\s*'only staff create onboarding cases'\)/);
 });
 it('gives each import a unique id and a distinct plain title',()=>{
  expect(new Set(IMPORT_OWNERS.map(row=>row.id)).size).toBe(IMPORT_OWNERS.length);
  expect(new Set(IMPORT_OWNERS.map(row=>row.title)).size).toBe(IMPORT_OWNERS.length);
  for(const row of IMPORT_OWNERS)expect(row.title,row.id).toMatch(/^(Import|Upload) [a-z]/);
  // Import-only pages are listed as imports; none of them is a destination page again.
  expect([...IMPORT_PAGES].sort()).toEqual(['/admin/leave-config/data-import','/admin/leave-config/import','/admin/personnel/import','/attendance/import',
   '/lifecycle/onboarding/import','/payroll/history-import','/payroll/transactions/import-components','/roster/import']);
 });
});

/** Destinations the catalogue never lists as a page, each with why. Any other destination must be placeable. */
const NOT_A_PAGE:Readonly<Record<string,string>>={
 '/assistant':'AI Centre itself: the person is already in it, and it is never a link target.',
 '/mobile-preview':'An administrator\'s device preview, never a link target.',
};
describe('destinations',()=>{
 it('classifies every destination as a page, a report, an import, a database-decided workspace or a named exception',()=>{
  const linkable=new Set(LINKABLE_PAGES.map(([path])=>path));
  const classified=productDestinations().map(row=>{const path=row.href.split(/[?#]/)[0]||'/';
   const kind=row.source==='lifecycle_v9'?'v9':path==='/reports'||path.startsWith('/reports/')?'report':IMPORT_PAGES.has(path)?'import':linkable.has(path)?'page':NOT_A_PAGE[path]?'exception':'unclassified';
   return{href:row.href,kind,area:areaOf(row.module,path)};});
  expect(classified.filter(row=>row.kind==='unclassified')).toEqual([]);
  for(const path of Object.keys(NOT_A_PAGE))expect(classified.some(row=>row.href===path),path+' is still a destination').toBe(true);
  // Every listed page has a plain area; only the home page and Feedback are general.
  expect(classified.filter(row=>row.kind==='page'&&row.area==='general').map(row=>row.href).sort()).toEqual(['/','/feedback']);
 });
});

const walk=(fields:readonly SemanticField[]):SemanticField[]=>fields.flatMap(field=>[field,...(field.of?walk(field.of):[])]);
describe('the semantic declaration',()=>{
 it('declares product_capability with every field full, and the conversation worker reads it',()=>{
  const entity=terasEntity('product_capability');
  expect(terasEntities().filter(row=>row.id==='product_capability')).toHaveLength(1);
  expect(entity).toBe(CATALOGUE_ENTITIES[0]);
  expect(walk(entity.fields).map(field=>field.disclosure)).toEqual(walk(entity.fields).map(()=>'full'));
  expect(walk(entity.fields).map(field=>field.name)).toEqual(['entries','id','kind','mode','area','title','page','template','areas','area','actions','imports','reports','pages','examples']);
  expect(registeredWorkers().find(worker=>worker.id==='conversation')?.readScope).toContain('product_capability');
  for(const anchor of entity.owners){const [file,name]=anchor.split('#');expect(existsSync(join(root,file)),anchor).toBe(true);expect(exportsName(file,name),anchor).toBe(true);}
  expect(existsSync(join(root,'app',entity.page,'page.tsx')),entity.page).toBe(true);
 });
 it('generates the tool spec from the declaration, with both filters optional',()=>{
  const declared=CATALOGUE_READS[0];
  expect(PRODUCT_CAPABILITIES_SPEC.name).toBe('product_capabilities');
  expect(PRODUCT_CAPABILITIES_SPEC.description).toBe(describeRead(declared,CATALOGUE_ENTITIES[0]));
  expect(PRODUCT_CAPABILITIES_SPEC.description).toMatch(/never guessed/);
  expect(PRODUCT_CAPABILITIES_SPEC.inputSchema).toEqual({type:'object',additionalProperties:false,required:[],properties:{
   kind:{type:'string',enum:['action','import','report','page'],description:'Only this kind.'},
   area:{type:'string',maxLength:60,description:'Words for the area or subject, such as payroll history or leave; matched against titles and areas.'}}});
 });
});

// ── The tool result, pure, over a fictional catalogue ──
const entry=(id:string,kind:CatalogueEntry['kind'],area:CatalogueEntry['area'],title:string,mode:CatalogueEntry['mode']='open'):CatalogueEntry=>({id,kind,mode,area,title});
const FIXTURE:readonly CatalogueEntry[]=[
 entry('leave.apply','action','leave','Apply for leave for yourself.','prepare'),
 entry('claims.submit','action','claims','Submit your own expense claim draft for approval.'),
 entry('import:payroll_history','import','payroll','Import payroll history (past payslips from a previous system)'),
 entry('import:leave_history','import','leave','Import leave history (leave already taken) from a previous system'),
 entry('import:employee_records','import','people','Import new employees with every detail from a spreadsheet'),
 entry('report:payroll_register','report','payroll','Payroll register'),
 entry('page:/leave/details','page','leave','Leave details'),
];
describe('the product_capabilities result',()=>{
 it('summarises areas with counts and examples, and lists what can be prepared, with no filter',()=>{
  const result=capabilitiesResult(FIXTURE,{});
  expect(result).toMatchObject({ok:true,returnedRows:1,totalRows:1});if(!result.ok)return;
  expect(result.entries.map(row=>row.id)).toEqual(['leave.apply']);
  expect(result.areas).toEqual([
   {area:'people',actions:0,imports:1,reports:0,pages:0,examples:['Import new employees with every detail from a spreadsheet']},
   {area:'leave',actions:1,imports:1,reports:0,pages:1,examples:['Apply for leave for yourself.','Import leave history (leave already taken) from a previous system','Leave details']},
   {area:'claims',actions:1,imports:0,reports:0,pages:0,examples:['Submit your own expense claim draft for approval.']},
   {area:'payroll',actions:0,imports:1,reports:1,pages:0,examples:['Import payroll history (past payslips from a previous system)','Payroll register']},
  ]);
 });
 it('filters by kind and by area words, every word first and then any word',()=>{
  const ids=(input:Parameters<typeof capabilitiesResult>[1])=>{const result=capabilitiesResult(FIXTURE,input);return result.ok?result.entries.map(row=>row.id):null;};
  expect(ids({kind:'import'})).toEqual(['import:payroll_history','import:leave_history','import:employee_records']);
  expect(ids({kind:'import',area:'payroll history'})).toEqual(['import:payroll_history']);
  expect(ids({area:'history'})).toEqual(['import:payroll_history','import:leave_history']);
  // No entry has both words: any of them.
  expect(ids({kind:'import',area:'payroll employees'})).toEqual(['import:payroll_history','import:employee_records']);
  // Nothing matches: the whole kind, never a false "not available".
  const miss=capabilitiesResult(FIXTURE,{kind:'import',area:'导入工资'});
  expect(miss.ok&&miss.entries.length).toBe(3);expect(miss.ok&&miss.note).toMatch(/Never say something is unavailable/);
  const missAll=capabilitiesResult(FIXTURE,{area:'zzz unknown'});expect(missAll.ok&&missAll.areas?.length).toBe(4);
  // A kind the person has none of says so.
  const none=capabilitiesResult(FIXTURE.filter(row=>row.kind!=='import'),{kind:'import'});
  expect(none).toMatchObject({ok:true,entries:[],totalRows:0});expect(none.ok&&none.note).toMatch(/nothing of this kind/);
 });
 it('caps the entries it returns and says more exist',()=>{
  const many=Array.from({length:MAX_CAPABILITY_ENTRIES+5},(_,index)=>entry('page:/p'+index,'page','settings','Page '+index));
  const result=capabilitiesResult(many,{kind:'page'});
  expect(result).toMatchObject({ok:true,returnedRows:MAX_CAPABILITY_ENTRIES,totalRows:MAX_CAPABILITY_ENTRIES+5,truncated:true});
  expect(result.ok&&result.note).toMatch(/More match than are listed/);
 });
 it('accepts only the declared input, and turns words into search words',()=>{
  expect(capabilitiesInput({})).toEqual({});expect(capabilitiesInput({kind:null,area:null})).toEqual({});
  expect(capabilitiesInput({kind:'import',area:' payroll '})).toEqual({kind:'import',area:' payroll '});
  for(const bad of [null,[],'import',{kind:'everything'},{area:7},{area:'x'.repeat(61)},{other:true}])expect(capabilitiesInput(bad),JSON.stringify(bad)).toBeNull();
  expect(searchWords('Help me import the payroll data, please')).toEqual(['import','payroll']);
  expect(searchWords('导入 工资')).toEqual(['导入','工资']);
  expect(CAPABILITY_KINDS).toEqual(['action','import','report','page']);
 });
});
