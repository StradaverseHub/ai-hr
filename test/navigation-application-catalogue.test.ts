import {describe,expect,it} from 'vitest';
import {declaredApplicationNavigationCatalogue,declaredNavigationCatalogue} from '../lib/navigation/catalogue';
import {MODULE_SUBMENU_REGISTRIES} from '../lib/navigation/module-submenus';
import {CENTRE_TABS,CENTRE_SECTIONS,PAYROLL_CYCLE_PAGES} from '../lib/ai-centre/centre-nav';
import {SECURITY_PAGES} from '../lib/security-center-navigation';
import {PERFORMANCE_AREA_TABS} from '../packs/performance/onehr/tab-model';
describe('composed application navigation declarations, not permission or execution proof',()=>{
 it('preserves every existing shell identity and composes published owner references',()=>{
  const app=declaredApplicationNavigationCatalogue(),shell=declaredNavigationCatalogue();
  // Common baseline 221 + Offboarding postings + Recruitment + employee referrals: retain every durable identity.
  expect(app.issues).toEqual([]);expect(app.declarations).toHaveLength(225);
  expect(app.declarations.slice(0,shell.declarations.length)).toEqual(shell.declarations);
  expect(app.declarations.find(row=>row.id==='shell.contractPersonnelPostings')).toMatchObject({sourceOwner:'lib/navigation/shell-inventory.ts',sourceKey:'shell-slot:contractPersonnelPostings',declaredHref:'/lifecycle/contracts/postings'});
  expect(app.declarations.find(row=>row.id==='shell.offboardingPostings')).toMatchObject({sourceOwner:'lib/navigation/shell-inventory.ts',sourceKey:'shell-slot:offboardingPostings',declaredHref:'/lifecycle/offboarding/postings'});
  expect(app.declarations.find(row=>row.id==='shell.recruitment')).toMatchObject({sourceOwner:'packs/recruitment/index.ts',sourceKey:'shell-slot:recruitment',declaredHref:'/recruitment'});
  expect(app.declarations.find(row=>row.id==='shell.myReferrals')).toMatchObject({sourceOwner:'lib/navigation/shell-inventory.ts',sourceKey:'shell-slot:myReferrals',declaredHref:'/me/referrals'});
  const sources:object[]=[...CENTRE_TABS,...Object.values(CENTRE_SECTIONS).flat(),...PAYROLL_CYCLE_PAGES,...SECURITY_PAGES,...PERFORMANCE_AREA_TABS];
  for(const registry of MODULE_SUBMENU_REGISTRIES)sources.push(...registry.items);
  expect(sources).toHaveLength(59);
  for(const descriptor of sources)expect(app.declarations.filter(row=>row.descriptor===descriptor)).toHaveLength(1);
  expect(new Set(app.declarations.map(row=>row.id)).size).toBe(225);
  expect(new Set(app.declarations.map(row=>row.sourceKey)).size).toBe(225);
  expect(app.declarations.find(row=>row.id==='shell.rewardsAllReviews')).toMatchObject({
   sourceOwner:'packs/rewards/index.ts',sourceKey:'shell-slot:rewardsAllReviews',declaredHref:'/rewards/reviews',
  });
  expect(app.declarations.find(row=>row.id==='shell.rewardsPromotions')).toMatchObject({
   sourceOwner:'packs/rewards/index.ts',sourceKey:'shell-slot:rewardsPromotions',declaredHref:'/rewards/promotions',
  });
  expect(app.declarations.find(row=>row.id==='shell.rewardsSharedConfiguration')).toMatchObject({sourceKey:'shell-slot:rewardsSharedConfiguration',declaredHref:'/admin/rewards/review-plans'});
  expect(app.declarations.find(row=>row.id==='shell.rewardsHistoryUpload')).toMatchObject({sourceKey:'shell-slot:rewardsHistoryUpload',declaredHref:'/rewards/history-upload'});
  expect(app.declarations.some(row=>row.id==='shell.rewardsReviewCycles'||row.id.startsWith('submenu.rewards.'))).toBe(false);
 });
 it('names the actual static-tab renderers while retaining their native policy owners',()=>{
  const app=declaredApplicationNavigationCatalogue();
  for(const registry of MODULE_SUBMENU_REGISTRIES)for(const descriptor of registry.items){
   const row=app.declarations.find(row=>row.id===descriptor.id)!;
   expect(row.descriptor).toBe(descriptor);expect(row.navigationHref).toBe(descriptor.href);
   expect(row.sourceOwner).toBe('lib/navigation/module-submenus.ts');expect(row.rendererOwner).toBe(registry.rendererOwner);
  }
  expect(app.declarations.find(row=>row.id==='submenu.holidays.groups')?.placement).toBeDefined();
 });
 it('refuses a new published key without an explicit reviewed durable identity',()=>{
  const tabs=CENTRE_TABS as unknown as {key:string;href:string}[];
  tabs.push({key:'unreviewed-automatic-id',href:'/ai-centre/unreviewed'});
  try{expect(declaredApplicationNavigationCatalogue().issues).toContainEqual({code:'unmapped-submenu-declaration',detail:'ai/tab/unreviewed-automatic-id'});}
  finally{tabs.pop();}
 });
 it('does not call the Performance visibility gates while inventorying declarations',()=>{
  const tab=PERFORMANCE_AREA_TABS[0],original=tab.gate;
  Object.assign(tab,{gate:()=>{throw Error('A metadata inventory cannot resolve permission');}});
  try{expect(declaredApplicationNavigationCatalogue().issues).toEqual([]);}finally{Object.assign(tab,{gate:original});}
 });
});
