/** ADR-0169 phase B: the Assistant's destination registry must stay complete, real and labelled. */
import {readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {describe,expect,it} from 'vitest';
import '@/packs/register-all';
import {listPacks,type ModulePack} from '@/packs/registry';
import {V9_NAVIGATION} from '@/lib/lifecycle-v9-navigation';
import {SECURITY_PAGES} from '@/lib/security-center-navigation';
import {destinationsFor,productDestinations} from '@/lib/product-context/destinations';
import type {SessionContext} from '@/db/client';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import vi from '../messages/vi.json';import ta from '../messages/ta.json';import th from '../messages/th.json';

const app=join(process.cwd(),'app');
function pageRoutes(){const found:RegExp[]=[];const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);
 if(entry.isDirectory())walk(path);else if(entry.name==='page.tsx'){const route='/'+relative(app,dir).split('/').filter(part=>part&&!/^\(.*\)$/.test(part)).join('/');
  found.push(new RegExp('^'+route.replace(/\/$/,'').replace(/\[\[?\.\.\.[^\]]+\]?\]/g,'.+').replace(/\[[^\]]+\]/g,'[^/]+')+'/?$'));}}};walk(app);return found;}
const pathOf=(href:string)=>href.split(/[?#]/)[0]||'/';
const sidebarSource=readFileSync(join(process.cwd(),'components','sidebar.tsx'),'utf8');

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
  expect(literal.length).toBeGreaterThan(50);
  const packs=listPacks('module').flatMap(pack=>{const module=pack as ModulePack;return[...(module.navNodes??[]).flatMap(node=>node.children.map(child=>child.href)),...(module.navLinks??[]).map(link=>link.href)];});
  expect(packs.length).toBeGreaterThan(20);
  const expected=[...literal,...packs,...V9_NAVIGATION.map(row=>row.href),...SECURITY_PAGES.map(row=>row.href)];
  expect([...new Set(expected)].filter(href=>!hrefs.has(href))).toEqual([]);
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
