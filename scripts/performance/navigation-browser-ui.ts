/** Shared native DOM interaction/check work. These raw check results do not
 * authenticate a page, actor, session, source, fixture issuer or load interval.
 * The caller retains the one original deadline and all evidence lifecycle work. */
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {fixtureNavigationActor,navigationExpectedText,type NavigationScenario,type NavigationFixtureTextBindings,type NavigationObservation} from './navigation-protocol';
import {NAVIGATION_EXPECTED_ACTORS,type NavigationExpectedInputs} from './navigation-expected-inputs';

/** Existing legacy bindings and decoded public inputs share THIS implementation.
 * remaining is an ordinary UI timeout dependency, never a load-state issuer. */
export async function observeNavigationUIContent(page:Page,scenario:NavigationScenario,actorIndex:number,bindings:Readonly<NavigationFixtureTextBindings>,remaining:()=>number):Promise<NavigationObservation['checks']>{
  for(const step of scenario.steps){
   const details=page.locator(step.selector);
   await details.first().waitFor({state:'visible',timeout:remaining()});
   assert(await details.count()===1,'Native disclosure missing or ambiguous');
   assert(await details.evaluate(element=>element.tagName==='DETAILS'),'Only native read disclosure steps are permitted');
   if(await details.getAttribute('open',{timeout:remaining()})===null){
    const summary=details.locator(':scope > summary');
    await summary.first().waitFor({state:'visible',timeout:remaining()});
    assert(await summary.count()===1&&await summary.isEnabled({timeout:remaining()}),'Native disclosure trigger missing, ambiguous or unavailable');
    await summary.click({timeout:remaining()});
   }
  }
  const checks:NavigationObservation['checks']=[];
  for(const check of scenario.checks){
   const matches=page.locator(check.selector);await matches.first().waitFor({state:'visible',timeout:remaining()});
   const visible=[];for(const match of await matches.all())if(await match.isVisible())visible.push(match);
   assert(visible.length>0,'Reviewed usable-content selector has no visible result');
   if(check.kind==='count'||check.kind==='fixture-roster-rows')assert(visible.length>=check.minimum&&(check.maximum===undefined||visible.length<=check.maximum),'Usable-content count differs');
   if(check.kind==='fixture-roster-rows'){
    const ids=new Set<string>();
    for(const row of visible){
     const id=await row.getAttribute('data-roster-employment-id',{timeout:remaining()});
     assert(id&&!ids.has(id)&&Object.hasOwn(bindings.rosterScope,id),'Roster rendered an unknown, duplicate or out-of-scope native fixture employment');ids.add(id);
     const expected=bindings.rosterScope[id];if(expected!==null)assert((await row.innerText({timeout:remaining()})).includes(expected),'Roster omitted the independently seeded employee identity');
    }
   }else if(check.kind==='enabled'){
    assert(await visible[0].evaluate(element=>element.tagName.toLowerCase())===check.tag&&await visible[0].isEnabled(),'Reviewed native control is unavailable');
   }else if(check.kind==='text-exact')assert((await visible[0].innerText({timeout:remaining()})).trim()===navigationExpectedText(check.expected,actorIndex,bindings),'Expected exact native fixture content differs');
   else if(check.kind==='text')assert((await visible[0].innerText({timeout:remaining()})).includes(navigationExpectedText(check.expected,actorIndex,bindings)),'Expected independent fixture content missing');
   else if(check.kind==='value')assert(await visible[0].inputValue({timeout:remaining()})===navigationExpectedText(check.expected,actorIndex,bindings),'Expected native control value differs');
   else if(check.kind==='attribute')assert(await visible[0].getAttribute(check.name)===check.expected,'Reviewed native control attribute differs');
   checks.push({id:check.id,passed:true,observedCount:visible.length});
  }
  return checks;
}

/** Adapt ONLY an already decoded row from the one public codec. No second
 * parser/serializer, build/source claim, private fixture or transport is created. */
export async function observePublicNavigationUIContent(page:Page,scenario:NavigationScenario,input:Readonly<NavigationExpectedInputs['actorInputs'][number]>,remaining:()=>number):Promise<NavigationObservation['checks']>{
 assert(input&&NAVIGATION_EXPECTED_ACTORS.some(index=>index===input.actorIndex),'Decoded fictional navigation actor input required');
 const actor=fixtureNavigationActor(input.actorIndex),targets=input.routeTargets.filter(row=>row.destinationId===scenario.destinationId);
 assert(input.roleLabel===actor.role&&input.actorName===actor.name&&scenario.role===actor.role&&targets.length===1&&targets[0].href===scenario.href,'Public fictional actor/scenario expectations differ');
 const bindings:NavigationFixtureTextBindings={actorName:input.actorName,actorEmployeeCode:input.actorEmployeeCode,firstCompanyPersonName:input.firstCompanyPersonName,
  activeHeadcount:input.activeHeadcount,historicalPayrollMonth:input.historicalPayrollMonth,seedToday:input.seedToday,seedMonth:input.seedMonth,
  ...(input.history.kind==='saved'?{firstSavedHistoryTitle:input.history.firstSavedHistoryTitle}:{}),
  rosterScope:Object.fromEntries(input.rosterScope.map(row=>[row.employmentId,row.expectedName]))};
 return observeNavigationUIContent(page,scenario,input.actorIndex,bindings,remaining);
}
