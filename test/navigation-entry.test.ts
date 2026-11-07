import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {declaredApplicationNavigationCatalogue} from '../lib/navigation/catalogue';
import {DIRECT_CONTENT_ROUTES,navigationScenarioEntry} from '../scripts/performance/navigation-entry';
import {validateNavigationScenarioPlan} from '../scripts/performance/navigation-protocol';
const readPlan=()=>JSON.parse(readFileSync(new URL('../scripts/performance/navigation-scenarios.json',import.meta.url),'utf8'));
describe('native menu interaction and direct module content remain distinct',()=>{
 it('binds every reviewed source scenario address to the canonical declared identity',()=>{
  const plan=validateNavigationScenarioPlan(readPlan()),catalogue=declaredApplicationNavigationCatalogue();
  for(const scenario of plan.scenarios){
   expect(catalogue.declarations.find(row=>row.id===scenario.destinationId)?.navigationHref).toBe(scenario.href);
   const entry=navigationScenarioEntry(scenario);if(entry.kind==='direct-route-content')expect(entry.selector).toBeNull();else expect(entry.selector).toContain('a[');
  }
  const native=plan.scenarios.filter(row=>row.entry!=='direct-route-content'),direct=plan.scenarios.filter(row=>row.entry==='direct-route-content');
  expect(native).toHaveLength(40);expect(new Set(native.map(row=>row.destinationId)).size).toBe(10);
  expect(direct).toHaveLength(8);expect(new Set(direct.map(row=>row.destinationId))).toEqual(new Set(Object.keys(DIRECT_CONTENT_ROUTES)));
 });
 it('refuses arbitrary direct navigation, unbound AI hrefs and unknown entry modes',()=>{
  for(const edit of [(plan:any)=>{Object.assign(plan.scenarios[0],{entry:'direct-route-content'});},
   (plan:any)=>{Object.assign(plan.scenarios[0],{entry:'ai-centre-tab'});},
   (plan:any)=>{Object.assign(plan.scenarios[0],{entry:'http-200-only'});}]){
   const plan=readPlan();edit(plan);expect(()=>validateNavigationScenarioPlan(plan)).toThrow();
  }
 });
});
