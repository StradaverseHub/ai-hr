/** ADR-0170 §3.12, step 5c — the definition of done, as a test (not a workflow change).
 *
 * Every registry action and linkable page needs a semantic entry, a guide link, a readiness check where its
 * module has a setup stage, and at least one corpus turn (core/improvement/definition-of-done.ts). Today's gaps
 * are a shrink-only allowlist (core/improvement/definition-of-done-gaps.ts): a new gap fails, a closed gap left
 * on the list fails, and the list's size is pinned. No database. */
import {describe,expect,it} from 'vitest';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DONE_REQUIREMENTS,PRIVATE_BY_DESIGN,definitionOfDoneGaps,guideReferences,routeOfScreen,type DoneInputs} from '../core/improvement/definition-of-done';
import {SEMANTIC_ACTIONS,SEMANTIC_READS} from '../core/semantic-model/entities';
import {TERAS_READS,contextToolSpecs,referencedPages,terasEntities,terasEntity,terasToolSpecs} from '../core/semantic-model/generate';
import {ASSISTANT_TOOL_CATALOGUE} from '../lib/ai/assistant-tool-catalogue';
import {LINKABLE_PAGES} from '../lib/product-context/destinations';
import {DEFINITION_OF_DONE_GAPS} from '../core/improvement/definition-of-done-gaps';
import {definitionOfDoneInputs} from './definition-of-done-inputs';

/** Ceilings at the allowlist's creation (claude/teras-integration a2a39018). Lower them as gaps close; never raise. */
// Re-baselined at integration against released main 50ea2471: +1 entry (page:/admin/settings/entra, semantic+guide+corpus).
// AI Centre restructure (4 Nov 2026): lowered to the counts after it (356/344/236/4/339 before, 352/341/233/4/335 after).
const CEILING={entries:352,semantic:341,guide:233,readiness:4,corpus:335} as const;

const allowed=():Map<string,string[]>=>{const map=new Map<string,string[]>();
 for(const [signature,keys] of Object.entries(DEFINITION_OF_DONE_GAPS))for(const key of keys){
  expect(map.has(key),key+' is listed twice').toBe(false);map.set(key,signature.split(','));}
 return map;};
/** Gaps present but not allowed, and allowed gaps that have closed. */
function compare(gaps:Readonly<Record<string,readonly string[]>>,list:ReadonlyMap<string,readonly string[]>){
 const fresh:string[]=[],closed:string[]=[];
 for(const [key,missing] of Object.entries(gaps)){const ok=list.get(key)??[];for(const requirement of missing)if(!ok.includes(requirement))fresh.push(key+' '+requirement);}
 for(const [key,ok] of list)for(const requirement of ok)if(!(gaps[key]??[]).includes(requirement))closed.push(key+' '+requirement);
 return{fresh,closed};
}

describe('definition of done',()=>{
 const inputs=definitionOfDoneInputs(),gaps=definitionOfDoneGaps(inputs),list=allowed();
 it('covers organisation review with its literal semantic owner, guide and corpus without a new gap',()=>{expect(inputs.pages.some(page=>page.path==='/admin/organization/organisation-tagging')).toBe(true);expect(gaps['page:/admin/organization/organisation-tagging']).toBeUndefined();});
 it('reads the live registries',()=>{
  expect(inputs.actions.length).toBeGreaterThanOrEqual(71);expect(inputs.pages.length).toBeGreaterThanOrEqual(293);
  expect(inputs.guideBodies.length).toBeGreaterThan(40);expect(inputs.corpus.length).toBeGreaterThan(150);
  expect(inputs.semanticActions).toEqual(new Set(['leave.apply','leave.cancel','approvals.leave.decide','attendance.correction.request','attendance.overtime.request','claims.submit','claims.cancel','ess.profile.request','toil.replacement.request','approvals.claim.decide','approvals.attendance.decide']));
  expect([...inputs.moduleStages.keys()].sort()).toEqual(['attendance','claims','leave','payroll']);
 });
 it('has no gap outside the allowlist',()=>{
  const {fresh}=compare(gaps,list);
  expect(fresh,'Ship these with their semantic entry, guide link, readiness check and corpus turn; the allowlist only shrinks').toEqual([]);
 });
 it('lists no gap that has closed (remove it in the same change)',()=>{
  expect(compare(gaps,list).closed).toEqual([]);
 });
 it('only shrinks: counts stay at or below the recorded ceilings',()=>{
  const counts=Object.fromEntries(DONE_REQUIREMENTS.map(requirement=>[requirement,[...list.values()].filter(missing=>missing.includes(requirement)).length]));
  expect(list.size).toBeLessThanOrEqual(CEILING.entries);
  for(const requirement of DONE_REQUIREMENTS)expect(counts[requirement],requirement).toBeLessThanOrEqual(CEILING[requirement]);
  for(const signature of Object.keys(DEFINITION_OF_DONE_GAPS))expect(signature.split(',').every(part=>(DONE_REQUIREMENTS as readonly string[]).includes(part)),signature).toBe(true);
 });
 it('counts what is already done',()=>{
  const done=[...inputs.actions.map(action=>'action:'+action.id),...inputs.pages.map(page=>'page:'+page.path)].filter(key=>!(key in gaps));
  // AI Centre restructure: the setup co-pilot's page is /payroll/setup (its stages), and a person's payroll readiness is
  // its own page; Record readiness lost the co-pilot's mistaken pointer and is listed (no read describes it yet).
  expect(done).toEqual(expect.arrayContaining(['action:leave.apply','action:leave.cancel','page:/leave','page:/attendance/my-records','page:/payroll/setup','page:/me/payroll-readiness']));
 });
});

describe('the rules fail when they should',()=>{
 const base:DoneInputs={actions:[{id:'fictional.action',module:'leave',reviewRoute:'/assistant/fictional',nativeScreen:'app/fictional/page.tsx',evaluationCases:[]}],
  pages:[{path:'/fictional',module:'claims'}],semanticActions:new Set(),semanticPages:new Set(),readPages:new Map(),guideBodies:['See [Leave](/leave#apply).'],
  moduleStages:new Map([['leave','leave_setup'],['claims','claims_setup']]),stagesWithoutOwner:new Set(['claims_setup']),corpus:[]};
 it('names every missing requirement',()=>{
  expect(definitionOfDoneGaps(base)).toEqual({'action:fictional.action':['semantic','guide','corpus'],'page:/fictional':['semantic','guide','readiness','corpus']});
 });
 it('clears each requirement from its own evidence',()=>{
  const met:DoneInputs={...base,semanticActions:new Set(['fictional.action']),semanticPages:new Set(['/fictional']),readPages:new Map([['fictional_read','/fictional']]),
   guideBodies:['Open [it](/fictional) or the [review](/assistant/fictional?x=1).'],stagesWithoutOwner:new Set(),
   corpus:[{id:'t1',conversation:'c',ideal:{mode:'propose',action:'fictional.action'}},{id:'t2',conversation:'c',ideal:{mode:'answer',reads:['fictional_read']}}]};
  expect(definitionOfDoneGaps(met)).toEqual({});
  expect(definitionOfDoneGaps({...met,corpus:[],actions:[{...met.actions[0],evaluationCases:['t9']}]})['action:fictional.action']).toEqual(['corpus']);
 });
 it('matches guide links and screen routes exactly',()=>{
  expect(guideReferences('See [x](/leave/tracker).','/leave')).toBe(false);
  expect(guideReferences('See [x](/leave).','/leave')).toBe(true);
  expect(guideReferences('Go to /leave to apply.','/leave')).toBe(true);
  expect(guideReferences('Any /path at all','/')).toBe(false);
  expect(routeOfScreen('app/(employee)/leave/tracker/page.tsx')).toBe('/leave/tracker');
  expect(routeOfScreen('app/page.tsx')).toBe('/');
  expect(routeOfScreen('app/admin/x/actions.ts')).toBeNull();
 });
 it('exempts a private-by-design page from the semantic and corpus requirements only',()=>{
  const page='/me/cases';expect(PRIVATE_BY_DESIGN[page]).toBe('ADR-0173: the AI never sees case words.');
  const unguided:DoneInputs={...base,actions:[],pages:[{path:page,module:null},{path:'/fictional',module:null}],guideBodies:[]};
  expect(definitionOfDoneGaps(unguided)).toEqual({'page:/fictional':['semantic','guide','corpus'],[`page:${page}`]:['guide']});
  expect(definitionOfDoneGaps({...unguided,guideBodies:[`Open [it](${page}).`]})).toEqual({'page:/fictional':['semantic','guide','corpus']});
  expect(definitionOfDoneGaps({...unguided,pages:[{path:page,module:'claims'}],guideBodies:[`Open [it](${page}).`]})).toEqual({[`page:${page}`]:['readiness']});
 });
 it('a new action or page without its pieces fails the allowlist',()=>{
  const live=definitionOfDoneInputs();
  const grown=definitionOfDoneGaps({...live,actions:[...live.actions,base.actions[0]],pages:[...live.pages,base.pages[0]]});
  expect(compare(grown,allowed()).fresh).toEqual(expect.arrayContaining(['action:fictional.action semantic','page:/fictional readiness']));
 });
});

/** The private-by-design classification is a guard, not debt: none of its pages has an AI semantic surface. */
describe('private by design: no AI semantic surface',()=>{
 const pages=Object.keys(PRIVATE_BY_DESIGN);
 const root=fileURLToPath(new URL('..',import.meta.url));
 const names=(path:string)=>new RegExp('(?<![A-Za-z0-9/_-])'+path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![A-Za-z0-9/_-])');
 it('keeps the private case pages and own job description linkable with explicit read boundaries',()=>{
  const casePages=['/admin/privacy/case-handlers','/cases','/me/cases','/me/cases/new'];
  expect(pages.sort()).toEqual([...casePages,'/me/job-description']);
  const linkable=new Set(LINKABLE_PAGES.map(([path])=>path));
  for(const page of pages)expect(linkable.has(page),page).toBe(true);
  for(const page of casePages)expect(PRIVATE_BY_DESIGN[page]).toMatch(/^ADR-0173: /);
  expect(PRIVATE_BY_DESIGN['/me/job-description']).toMatch(/native owner alone reads/);
 });
 it('gives none of them a semantic entity, a declared action or a read',()=>{
  const entityPages=new Set(terasEntities().map(entity=>entity.page));
  const readPages=new Set([...SEMANTIC_READS,...TERAS_READS].map(read=>terasEntity(read.entity).page));
  for(const page of pages){
   expect(entityPages.has(page),page+' is an entity page').toBe(false);expect(readPages.has(page),page+' is a read\'s page').toBe(false);
   expect(referencedPages(),page).not.toContain(page);expect(SEMANTIC_ACTIONS.some(action=>action.reviewRoute===page),page+' is a review route').toBe(false);
   expect(definitionOfDoneInputs().semanticPages.has(page),page).toBe(false);
  }
 });
 it('names none of them in any tool the model is offered',()=>{
  const specs=[...ASSISTANT_TOOL_CATALOGUE,...contextToolSpecs(),...terasToolSpecs()];expect(specs.length).toBeGreaterThan(10);
  for(const page of pages)for(const spec of specs)expect(JSON.stringify(spec),spec.name+' names '+page).not.toMatch(names(page));
 });
 it('keeps private case storage out of the harness and every protected page out of the semantic model',()=>{
  const files=(dir:string)=>readdirSync(join(root,dir)).filter(name=>/\.tsx?$/.test(name)).map(name=>join(dir,name));
  const model=files('core/semantic-model'),harness=files('core/harness');expect(model.length).toBeGreaterThan(10);expect(harness.length).toBeGreaterThan(5);
  // The harness may one day link the case form from a routed reply (ADR-0173 §3); it must never read a case.
  for(const file of [...model,...harness])expect(readFileSync(join(root,file),'utf8'),file).not.toMatch(/private-cases['"]|private_case\b|private_case_/);
  for(const file of model){const source=readFileSync(join(root,file),'utf8');for(const page of pages)expect(source,file+' names '+page).not.toMatch(names(page));}
 });
 it('still needs, and has, a guide for each page',()=>{
  const gaps=definitionOfDoneGaps(definitionOfDoneInputs());
  for(const page of pages)expect(gaps['page:'+page],page).toBeUndefined();
 });
});
