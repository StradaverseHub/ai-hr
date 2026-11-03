/** ADR-0170 §3.12, step 5c — the definition of done, as a test (not a workflow change).
 *
 * Every registry action and linkable page needs a semantic entry, a guide link, a readiness check where its
 * module has a setup stage, and at least one corpus turn (core/improvement/definition-of-done.ts). Today's gaps
 * are a shrink-only allowlist (core/improvement/definition-of-done-gaps.ts): a new gap fails, a closed gap left
 * on the list fails, and the list's size is pinned. No database. */
import {describe,expect,it} from 'vitest';
import {DONE_REQUIREMENTS,definitionOfDoneGaps,guideReferences,routeOfScreen,type DoneInputs} from '../core/improvement/definition-of-done';
import {DEFINITION_OF_DONE_GAPS} from '../core/improvement/definition-of-done-gaps';
import {definitionOfDoneInputs} from './definition-of-done-inputs';

/** Ceilings at the allowlist's creation (claude/teras-integration a2a39018). Lower them as gaps close; never raise. */
// Re-baselined at integration against released main 50ea2471: +1 entry (page:/admin/settings/entra, semantic+guide+corpus).
const CEILING={entries:359,semantic:355,guide:236,readiness:4,corpus:339} as const;

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
 it('reads the live registries',()=>{
  expect(inputs.actions.length).toBeGreaterThanOrEqual(71);expect(inputs.pages.length).toBeGreaterThanOrEqual(293);
  expect(inputs.guideBodies.length).toBeGreaterThan(40);expect(inputs.corpus.length).toBeGreaterThan(150);
  expect(inputs.semanticActions).toEqual(new Set(['leave.apply','leave.cancel','approvals.leave.decide','attendance.correction.request','attendance.overtime.request','claims.submit','claims.cancel','ess.profile.request','toil.replacement.request']));
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
  expect(done).toEqual(expect.arrayContaining(['action:leave.apply','action:leave.cancel','page:/leave','page:/attendance/my-records','page:/control-tower/readiness']));
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
 it('a new action or page without its pieces fails the allowlist',()=>{
  const live=definitionOfDoneInputs();
  const grown=definitionOfDoneGaps({...live,actions:[...live.actions,base.actions[0]],pages:[...live.pages,base.pages[0]]});
  expect(compare(grown,allowed()).fresh).toEqual(expect.arrayContaining(['action:fictional.action semantic','page:/fictional readiness']));
 });
});
