/** ADR-0169 phase B: the Assistant's destination registry must stay complete, real and labelled. */
import {readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {describe,expect,it} from 'vitest';
import '@/packs/register-all';
import {listPacks,type ModulePack} from '@/packs/registry';
import {V9_NAVIGATION} from '@/lib/lifecycle-v9-navigation';
import {SECURITY_PAGES} from '@/lib/security-center-navigation';
import {DESTINATION_PURPOSE,FORWARD_STUBS,NATIVE_SCOPE_ONLY_PAGES,destinationsFor,productDestinations} from '@/lib/product-context/destinations';
import {AI_FEATURES} from '@/lib/ai/features';
import type {SessionContext} from '@/db/client';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import vi from '../messages/vi.json';import ta from '../messages/ta.json';import th from '../messages/th.json';

const app=join(process.cwd(),'app');
function pageRoutes(){const found:RegExp[]=[];const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);
 if(entry.isDirectory())walk(path);else if(entry.name==='page.tsx'){const route='/'+relative(app,dir).split('/').filter(part=>part&&!/^\(.*\)$/.test(part)).join('/');
  found.push(new RegExp('^'+route.replace(/\/$/,'').replace(/\[\[?\.\.\.[^\]]+\]?\]/g,'.+').replace(/\[[^\]]+\]/g,'[^/]+')+'/?$'));}}};walk(app);return found;}
const pathOf=(href:string)=>href.split(/[?#]/)[0]||'/';
const sidebarSource=readFileSync(join(process.cwd(),'lib','navigation','shell-inventory.ts'),'utf8');

describe('product destination registry',()=>{
 const rows=productDestinations();
 it('is nonempty and has one row per destination',()=>{
  expect(rows.length).toBeGreaterThan(80);
  expect(new Set(rows.map(row=>row.href)).size).toBe(rows.length);
 });
 it('names only real pages',()=>{
  const routes=pageRoutes();expect(routes.length).toBeGreaterThan(100);
  expect(rows.filter(row=>!routes.some(route=>route.test(pathOf(row.href)))).map(row=>row.href)).toEqual([]);
 });
 it('has a label in every shipped locale',()=>{
  for(const [locale,messages] of Object.entries({en,ms,zh,vi,ta,th})){
   const nav=(messages as {nav:Record<string,string>}).nav;
   expect(rows.filter(row=>typeof nav[row.labelKey]!=='string'||!nav[row.labelKey].trim()).map(row=>row.labelKey),locale).toEqual([]);
  }
 });
 it('covers every sidebar literal row and every pack, lifecycle and security destination',()=>{
  const hrefs=new Set(rows.map(row=>row.href));
  const literal=[...sidebarSource.matchAll(/(?:href|defaultHref): ?'([^']+)'/g)].map(match=>match[1]);
  // Issue 17: the ten Control Tower rows left the rail (their pages are AI Centre tabs); the registry keeps them.
  expect(literal.length).toBeGreaterThanOrEqual(50);
  const packs=listPacks('module').flatMap(pack=>{const module=pack as ModulePack;return[...(module.navNodes??[]).flatMap(node=>node.children.map(child=>child.href)),...(module.navLinks??[]).map(link=>link.href)];});
  expect(packs.length).toBeGreaterThan(20);
  const expected=[...literal,...packs,...V9_NAVIGATION.map(row=>row.href),...SECURITY_PAGES.map(row=>row.href)];
  expect([...new Set(expected)].filter(href=>!hrefs.has(href)&&!NATIVE_SCOPE_ONLY_PAGES.has(pathOf(href)))).toEqual([]);
  expect(rows.filter(row=>NATIVE_SCOPE_ONLY_PAGES.has(pathOf(row.href)))).toEqual([]);
 });
 it('filters by coarse role and readable module without granting anything',()=>{
  const base={tenantId:'00000000-0000-4000-8000-000000000001',userId:'00000000-0000-4000-8000-000000000002'};
  const employee=destinationsFor({...base,roles:['employee']} as SessionContext),manager=destinationsFor({...base,roles:['manager']} as SessionContext),admin=destinationsFor({...base,roles:['hr_admin']} as SessionContext);
  expect(employee.some(row=>row.audience!=='everyone')).toBe(false);
  expect(employee.map(row=>row.href)).toContain('/me/payslip');
  expect(manager.map(row=>row.href)).toContain('/approvals');expect(manager.some(row=>row.audience==='admin')).toBe(false);
  expect(admin.length).toBe(rows.length);
  const leaveOnly=destinationsFor({...base,roles:['hr_admin']} as SessionContext,['leave']);
  expect(leaveOnly.some(row=>row.module==='payroll')).toBe(false);expect(leaveOnly.some(row=>row.module==='leave')).toBe(true);
 });
});
describe('where the AI is switched on (grp-ai-1, run 41838331387)',()=>{
 const groupAdmin=destinationsFor({tenantId:'00000000-0000-4000-8000-000000000001',userId:'00000000-0000-4000-8000-000000000002',roles:['super_admin']} as SessionContext);
 const row=(href:string)=>groupAdmin.find(destination=>destination.href===href);
 it('offers Workers (Features and agents) as the page that switches the AI on, with the provider and Assistant access beside it',()=>{
  expect(row('/control-tower/agents/features')).toMatchObject({labelKey:'aiManagementFeatures',audience:'admin'});
  expect(en.nav.aiManagementFeatures).toBe('Features and agents');
  const purpose=DESTINATION_PURPOSE['/control-tower/agents/features'];
  expect(purpose).toMatch(/^AI Centre › Administration › Workers: where the AI is switched on or off\./);
  expect(purpose).toMatch(/the HR assistant \(the AI conversation\)/);expect(purpose).toMatch(/whole group/);expect(purpose).toMatch(/only a group administrator/);
  expect(purpose).toMatch(/provider must be set up first/);expect(purpose).toMatch(/Assistant access \(Allowances\)/);
  expect(row('/control-tower/agents/provider')?.labelKey).toBe('aiManagementProvider');expect(DESTINATION_PURPOSE['/control-tower/agents/provider']).toMatch(/sets up the AI provider/);
  expect(row('/control-tower/agents/allowances')?.labelKey).toBe('aiManagementAllowances');expect(DESTINATION_PURPOSE['/control-tower/agents/allowances']).toMatch(/HR assistant access/);
 });
 it('says Loops (labelled Operations) is not where the AI is switched on, and the forwarded Overview is no destination',()=>{
  expect(row('/control-tower/loops')?.labelKey).toBe('aiControlTower');
  expect(DESTINATION_PURPOSE['/control-tower/loops']).toMatch(/Not where the AI or the HR assistant is switched on: that is Workers \(Features and agents\)\./);
  expect(FORWARD_STUBS.has('/control-tower')).toBe(true);expect(row('/control-tower')).toBeUndefined();
 });
 it('the Workers page holds the HR assistant switch and Allowances the Assistant access, as the purposes say',()=>{
  expect(AI_FEATURES.some(feature=>feature.id==='hr_assistant'&&feature.kind==='assistant')).toBe(true);
  const screen=readFileSync(join(process.cwd(),'app','control-tower','agents','screen.tsx'),'utf8');
  const features=screen.slice(screen.indexOf("{section==='features'&&<Card id=\"ai-features\""),screen.indexOf("{section==='features'&&<Card id=\"ai-built-in\""));
  expect(features.length).toBeGreaterThan(500);expect(features).toContain('action={setAiFeatureAction}');
  const allowances=screen.slice(screen.indexOf('const userRow ='),screen.indexOf("{section==='allowances'&&<>"));
  expect(allowances.length).toBeGreaterThan(200);expect(allowances).toContain('action={setAssistantPermissionAction}');
  expect(readFileSync(join(process.cwd(),'lib','ai-centre','centre-nav.ts'),'utf8')).toContain("{ key: 'workers', href: '/control-tower/agents/features'");
 });
});
