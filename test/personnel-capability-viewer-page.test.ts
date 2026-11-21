/** A Workforce viewer admitted by the published workforce.view capability alone (an ordinary employee,
 * no HR, payroll or rewards role) opens the real Personnel page and sees exactly its own companies'
 * employees. Before migration 5020 the page failed for that viewer: the company filter choices read
 * organisation tags through a company-read check that does not recognise the capability (42501), and
 * the page's photo predicate took a lock that refuses the page's read-only snapshot. */
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({shared:((globalThis as {__personnelPageDiagnostic?:{session?:unknown;scopeCookie?:string}}).__personnelPageDiagnostic??={})}));
vi.mock('../lib/session',async importOriginal=>({...(await importOriginal<typeof import('../lib/session')>()),getSession:async()=>state.shared.session}));
vi.mock('next/cache',()=>({revalidatePath:()=>{},revalidateTag:()=>{}}));
vi.mock('next/navigation',()=>({
 redirect:(path:string)=>{throw new Error('NEXT_REDIRECT:'+path);},notFound:()=>{throw new Error('NEXT_NOT_FOUND');},
 useRouter:()=>({refresh:()=>{},push:()=>{},replace:()=>{}}),usePathname:()=>'/admin/personnel',useSearchParams:()=>new URLSearchParams(),
}));
vi.mock('next/headers',()=>({
 cookies:async()=>({get:(name:string)=>name==='company_scope'&&state.shared.scopeCookie!==undefined?{value:state.shared.scopeCookie}:undefined}),
 headers:async()=>new Headers(),
}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator}=await import('next-intl');
 const {readFileSync}=await import('node:fs');
 const {fileURLToPath}=await import('node:url');
 const messages=JSON.parse(readFileSync(fileURLToPath(new URL('../messages/en.json',import.meta.url)),'utf8'));
 return {getLocale:async()=>'en',getTranslations:async(ns?:string|{namespace?:string})=>createTranslator({locale:'en',messages,
  namespace:(typeof ns==='string'?ns:ns?.namespace) as never,onError:()=>{}})};
});
import type {SessionContext} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {closeAll,migrateTestDb,owner} from './harness';
import {installPreMigrationOwners,restoreWorkforceCapabilityCatalogue,seedPersonnelScaleFixture,type PersonnelScaleFixture} from './performance/personnel-scale-fixture';
import {capabilityOnlyViewer,renderPersonnelPage} from './performance/personnel-page-reads-harness';

let fixture:PersonnelScaleFixture;
let viewer:SessionContext;
beforeAll(async()=>{await migrateTestDb();fixture=await seedPersonnelScaleFixture(160);viewer=await capabilityOnlyViewer(fixture);},180_000);
afterAll(async()=>{try{await restoreWorkforceCapabilityCatalogue();}finally{await closeAll();}},120_000);

describe('Personnel page for a capability-only Workforce viewer',()=>{
 it('renders exactly the viewer\'s own company employees, with photos read from the page snapshot',async()=>{
  const [expected]=await owner.client<{total:number;ids:string[]}[]>`select count(*)::int as total,coalesce(array_agg(id order by id),'{}') as ids
   from employment where tenant_id=${fixture.base.tenantId}::uuid and company_id=${fixture.companies.b}::uuid and voided_at is null`;
  expect(expected.total).toBeGreaterThan(20);
  // The viewer's face is on file, so the non-administrator photo predicate runs over a non-empty page.
  await owner.client`insert into person_photo(tenant_id,person_id,content,file_name,mime_type,size_bytes)
   values(${fixture.base.tenantId}::uuid,${viewer.personId!}::uuid,${Buffer.from([137,80,78,71,13,10,26,10])},'fictional.png','image/png',8)`;
  state.shared.session=viewer;
  for(const sp of [{size:'100'},{dept:fixture.departments.b[1],size:'100'},{sort:'reportingTo',direction:'asc',size:'100'}] as Record<string,string>[]){
   const page=await renderPersonnelPage(sp);
   expect(page.ids.length,JSON.stringify(sp)).toBeGreaterThan(0);
   expect(page.ids.every(id=>expected.ids.includes(id)),JSON.stringify(sp)).toBe(true);
   if(!sp.dept){expect(page.cards.total).toBe(expected.total);expect(page.ids.length).toBe(Math.min(100,expected.total));}
  }
  // An HR administrator still sees every company on the same page.
  state.shared.session=fixture.admin;
  const admin=await renderPersonnelPage({size:'100'});
  const [all]=await owner.client<{total:number}[]>`select count(*)::int as total from employment where tenant_id=${fixture.base.tenantId}::uuid and voided_at is null`;
  expect(admin.cards.total).toBe(all.total);
 },180_000);

 it('before 5020 the same page refused the viewer with 42501 (the defect this fixes)',async()=>{
  const reapply=await installPreMigrationOwners();
  try{
   state.shared.session=viewer;
   await expect(renderPersonnelPage({size:'100'})).rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='42501');
  }finally{await reapply();}
  state.shared.session=viewer;
  expect((await renderPersonnelPage({size:'100'})).ids.length).toBeGreaterThan(0);
 },180_000);

 it('a principal without the capability is still turned away',async()=>{
  const [user]=await owner.client<{id:string}[]>`insert into app_user(tenant_id,workos_user_id) values(${fixture.base.tenantId}::uuid,${'fictional-outsider-'+Date.now()}) returning id`;
  state.shared.session={tenantId:fixture.base.tenantId,userId:user.id,roles:[],grants:[],entitlements:fixture.admin.entitlements};
  await expect(renderPersonnelPage({})).rejects.toThrow('NEXT_REDIRECT:/');
 },60_000);
});
