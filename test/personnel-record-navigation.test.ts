/** Source/metadata controls only; native records, permissions and usable content remain unbound. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {PERSONNEL_RECORD_TABS,PERSONNEL_RECORD_RETIRED_NAVIGATION} from '../lib/personnel-record-navigation';
import {NAVIGATION_HARNESS_ROOTS} from '../scripts/performance/navigation-protocol';
import {RETIRED_PERSONNEL_TABS} from '../lib/personnel-tab-sections';
import {declaredApplicationNavigationCatalogue,declaredParameterizedNavigationCatalogue} from '../lib/navigation/catalogue';
const keys=['profile','family','job','careerMovement','attendance','bankStatutory','payroll','leave','documents','qualification'];
describe('canonical unbound Personnel record navigation metadata',()=>{
 it('retains exact ten-tab order, literal identities and translation keys',()=>{
  expect(PERSONNEL_RECORD_TABS.map(tab=>tab.key)).toEqual(keys);
  expect(PERSONNEL_RECORD_TABS.map(tab=>tab.id)).toEqual(keys.map(key=>'personnel-record.'+key));
  expect(PERSONNEL_RECORD_TABS.map(tab=>tab.labelKey)).toEqual(keys.map(key=>'tabs.'+key));
  for(const locale of ['en','ms','zh','ta','th','vi']){
   const translations=JSON.parse(readFileSync(new URL('../messages/'+locale+'.json',import.meta.url),'utf8'));
   for(const tab of PERSONNEL_RECORD_TABS)expect(translations.people.detail.tabs[tab.key]).toBeTypeOf('string');
  }
 });
 it('reuses the actual retired redirect owner without reintroducing a rendered Others tab',()=>{
  expect(PERSONNEL_RECORD_RETIRED_NAVIGATION).toHaveLength(1);
  expect(PERSONNEL_RECORD_RETIRED_NAVIGATION[0]).toMatchObject({id:'personnel-record.others',key:'others',targetKey:'profile'});
  expect(PERSONNEL_RECORD_RETIRED_NAVIGATION[0].redirectOwner).toBe(RETIRED_PERSONNEL_TABS);
  expect(PERSONNEL_RECORD_TABS.some(tab=>(tab.key as string)==='others')).toBe(false);
 });
 it('composes the exact descriptor objects separately from all static destination addresses',()=>{
  const records=declaredParameterizedNavigationCatalogue(),statics=declaredApplicationNavigationCatalogue();
  expect(statics.declarations).toHaveLength(222);expect(statics.issues).toEqual([]);
  expect(records.declarations).toHaveLength(10);expect(records.retired).toHaveLength(1);
  for(const descriptor of PERSONNEL_RECORD_TABS){
   const row=records.declarations.find(row=>row.id===descriptor.id)!;expect(row.descriptor).toBe(descriptor);
   expect(row).toMatchObject({sourceOwner:'lib/personnel-record-navigation.ts',pageOwner:'app/admin/personnel/[employmentId]/page.tsx',rendererOwner:'components/personnel-tabs.tsx',family:'personnel-record',kind:'client-tab',routeTemplate:'/admin/personnel/[employmentId]',queryKey:'tab',choiceKey:descriptor.key,nativeBinding:'unbound',nativeDisposition:'unresolved'});
   expect(row).not.toHaveProperty('navigationHref');expect(statics.declarations.some(row=>row.id===descriptor.id)).toBe(false);
  }
  for(const path of ['lib/personnel-record-navigation.ts','components/personnel-tabs.tsx','app/admin/personnel/[employmentId]/page.tsx'])expect(NAVIGATION_HARNESS_ROOTS).toContain(path);
  expect(records.retired[0].descriptor).toBe(PERSONNEL_RECORD_RETIRED_NAVIGATION[0]);
  expect(records).toMatchObject({remainingFamilies:'uncomposed',runtimeAcceptance:false,releaseAuthorized:false});
 });
 it('retains the native page policy/retired redirect and builds labels from canonical references',()=>{
  const page=readFileSync(new URL('../app/admin/personnel/[employmentId]/page.tsx',import.meta.url),'utf8');
  expect(page).toContain('PERSONNEL_RECORD_TABS.map(tab => ({key:tab.key,label:t(tab.labelKey)}))');
  expect(page).toContain("rawSearchParams.tab === 'others' ? RETIRED_PERSONNEL_TABS.others : undefined");
  expect(page).toContain('requireWorkforceAccess(');expect(page).toContain('tabs={tabs}');expect(page).toContain('panels={panels}');
 });
});
