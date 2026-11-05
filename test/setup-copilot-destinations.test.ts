/** ADR-0170 step 4 — every real page a caller's role may open is a valid link, and the page index stays what
 * classifyPage derives from each page's own guard (the sidebar drift test, test/product-context-destinations,
 * still covers the labelled destinations). Reads app/ source; no database. */
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {describe,expect,it} from 'vitest';
import {classifyPage,destinationsFor,LINKABLE_PAGES,linkablePathsFor,NATIVE_SCOPE_ONLY_PAGES} from '@/lib/product-context/destinations';
import {STAGE_PAGES} from '@/core/setup-copilot/copilot';
import {PAGES} from '@/core/product-context/coverage-readiness';
import {EXPLAIN_ENTITIES} from '@/core/semantic-model/entities-explain';
import type {SessionContext} from '@/db/client';

const app=join(process.cwd(),'app');
/** Every static page with its source and the layouts below app/ (the root layout guards every page alike). */
function staticPages():[string,string][]{
 const found:[string,string][]=[];
 const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);
  if(entry.isDirectory()){walk(path);continue;}if(entry.name!=='page.tsx')continue;
  const parts=relative(app,dir).split('/').filter(part=>part&&!/^\(.*\)$/.test(part));if(parts.some(part=>part.startsWith('[')))continue;
  let source=readFileSync(path,'utf8');for(let at=dir;at!==app&&at.startsWith(app);at=dirname(at)){const layout=join(at,'layout.tsx');if(existsSync(layout))source+=readFileSync(layout,'utf8');}
  found.push(['/'+parts.join('/'),source]);}};
 walk(app);return found.sort(([a],[b])=>a<b?-1:a>b?1:0);
}
const base={tenantId:'00000000-0000-4000-8000-000000000001',userId:'00000000-0000-4000-8000-000000000002'};
const as=(roles:string[])=>({...base,roles}) as SessionContext;

describe('linkable pages',()=>{
 it('equals what classifyPage derives from app/ today',()=>{
  const derived=staticPages().flatMap(([route,source])=>{const row=classifyPage(route,source);return row?[[route,row.audience,row.module]]:[];});
  expect(derived.length).toBeGreaterThan(250);
  expect(LINKABLE_PAGES.map(row=>[...row])).toEqual(derived);
 });
 it('lets an administrator link the real admin page step 1 retried on, and no employee link an admin page',()=>{
  expect(linkablePathsFor(as(['hr_admin']))).toContain('/admin/payroll-cycle');
  const employee=linkablePathsFor(as(['employee']));
  expect(employee).not.toContain('/admin/payroll-cycle');
  expect(LINKABLE_PAGES.filter(([path,audience])=>audience!=='everyone'&&employee.includes(path)&&!destinationsFor(as(['employee'])).some(row=>row.href.split(/[?#]/)[0]===path))).toEqual([]);
  expect(employee.filter(path=>/^\/(admin|control-tower|payroll)(\/|$)/.test(path))).toEqual([]);
  expect(employee).toEqual(expect.arrayContaining(['/me/payslip','/attendance/my-records','/leave']));
 });
 it('keeps every labelled destination linkable and respects the sidebar\'s module visibility',()=>{
  for(const roles of [['employee'],['manager'],['hr_admin']])
   expect(linkablePathsFor(as(roles))).toEqual(expect.arrayContaining(destinationsFor(as(roles)).map(row=>row.href.split(/[?#]/)[0]||'/')));
  const leaveOnly=linkablePathsFor(as(['hr_admin']),['leave']);
  expect(leaveOnly).not.toContain('/payroll/process');expect(leaveOnly).toContain('/admin/leave-config/generate');
 });
 it('links the caller’s own job description while leaving seat-based workflows in native navigation',()=>{
  const admin=linkablePathsFor(as(['hr_admin']),['rewards']);
  const employee=linkablePathsFor(as(['employee']),['rewards']);
  expect(employee).toContain('/me/job-description');
  for(const path of NATIVE_SCOPE_ONLY_PAGES){
   expect(staticPages().some(([route])=>route===path),path).toBe(true);
   expect(admin,path).not.toContain(path);
   expect(employee,path).not.toContain(path);
  }
 });
 it('makes every page the co-pilot and the explainers point to linkable for the caller they serve',()=>{
  const admin=linkablePathsFor(as(['hr_admin'])),employee=linkablePathsFor(as(['employee']));
  for(const page of [...Object.values(STAGE_PAGES),...Object.values(PAGES),'/control-tower/readiness'])expect(admin,page).toContain(page);
  for(const entity of EXPLAIN_ENTITIES)expect(employee,entity.page).toContain(entity.page);
 });
});
