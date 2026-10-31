import { readFileSync } from 'node:fs';
import { describe,it,expect } from 'vitest';
const source=(path:string)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
describe('preserved onboarding process navigation',()=>{
 it('opens legacy history on the legacy list and returns old tools and details to that process',()=>{
  expect(source('app/(app)/lifecycle/page.tsx')).toContain("{ href: '/lifecycle/onboarding/legacy', label: t('onboarding.legacyTitle'), n: onb.length }");
  expect(source('app/(app)/lifecycle/_ui.tsx')).toContain("{ key: 'onboarding', href: '/lifecycle/onboarding/legacy', min: LEVEL.agent }");
  const listing=source('app/(app)/lifecycle/onboarding/legacy/page.tsx');
  expect(listing).toContain('href="/lifecycle/onboarding/legacy?view=history"');
  expect(listing).not.toContain('href="/lifecycle/onboarding?view=history"');
  for(const path of ['[number]','new','import']){
   const page=source('app/(app)/lifecycle/onboarding/'+path+'/page.tsx');
   expect(page).toContain("href: '/lifecycle/onboarding/legacy', label: t('onboarding.legacyTitle')");
   expect(page).not.toContain('href="/lifecycle/onboarding"');
  }
 });
 it('labels the previous process and preserved history in all supported locales',()=>{
  expect(source('app/(app)/lifecycle/onboarding/legacy/page.tsx')).toContain("description={t('onboarding.legacyHint')}");
  expect(source('app/(app)/lifecycle/onboarding/[number]/page.tsx')).toContain("{t('onboarding.legacyHint')}");
  for(const locale of ['en','ms','zh','ta','th','vi']){
   const copy=JSON.parse(source('messages/'+locale+'.json')).lifecycle.onboarding;
   expect(copy.legacyTitle.trim().length).toBeGreaterThan(0);
   expect(copy.legacyHint.trim().length).toBeGreaterThan(0);
  }
 });
});
