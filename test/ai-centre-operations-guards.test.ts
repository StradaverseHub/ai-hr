/** Issue 17 (owner: "Merge both entirely", 3 November 2026): the Control Tower became AI Centre › Operations and
 * Administration, and "Guards don't change". This runs the real guards with Next's real redirect, per role:
 *  - an employee or a manager requesting any /control-tower page is still refused (the shared layout and the page
 *    each run requireAdmin, which sends them home with a temporary 307);
 *  - "How the Control Tower works" answers a permanent 308 to /assistant?view=how, and only after that same guard;
 *  - requireAdmin itself, and its isAdmin predicate, are byte-for-byte what they were.
 * No database: the session owner is the only stand-in. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const state=vi.hoisted(()=>({session:null as unknown,auditor:false}));
vi.mock('../lib/session',()=>({getSession:async()=>state.session}));
// Phase 2 hardening: whether the login holds a current read-only auditor grant (the database's answer, stood in for here).
vi.mock('../core/payroll-audit/reader-grant',()=>({hasAuditReaderGrant:async()=>state.auditor,auditReaderCompaniesTx:async()=>[]}));
// lib/authz imports the entitlement owner for other guards; none of the guards exercised here reads it.
vi.mock('../core/entitlements',()=>({isModuleEnabled:()=>{throw Error('not read by requireAdmin');}}));
import ControlTowerLayout from '../app/control-tower/layout';
import HowItWorksPage from '../app/control-tower/how-it-works/page';
import OverviewStub from '../app/control-tower/page';
import ProposedActionsStub from '../app/control-tower/actions/page';
import OpportunitiesStub from '../app/control-tower/opportunities/page';
import InventoryStub from '../app/control-tower/agents/inventory/page';
import OrchestratorStub from '../app/control-tower/agents/orchestrator/page';
import BuildListPage from '../app/control-tower/agents/build-list/page';
import {requireAdmin} from '../lib/authz';

const ROOT=path.resolve(__dirname,'..');
const read=(rel:string)=>fs.readFileSync(path.join(ROOT,rel),'utf8');
const TENANT='00000000-0000-4000-8000-0000000000a1',COMPANY='00000000-0000-4000-8000-0000000000c1';
const SESSIONS={
 employee:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000001',roles:['employee'],grants:[{role:'employee',companyId:COMPANY}]},
 manager:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000002',roles:['employee','manager'],grants:[{role:'manager',companyId:COMPANY}]},
 hrAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000003',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:COMPANY}]},
 groupAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000004',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},
} as const;
/** Next's redirect error carries `NEXT_REDIRECT;<type>;<url>;<status>;` in its digest. */
async function redirectOf(run:()=>unknown):Promise<{url:string;status:string}|null>{
 try{await run();return null;}catch(error){
  const digest=String((error as {digest?:unknown}).digest??'');
  const parts=digest.split(';');
  if(parts[0]!=='NEXT_REDIRECT')throw error;
  return {url:parts.slice(2,-2).join(';'),status:parts[parts.length-2]};
 }
}
beforeEach(()=>{state.session=null;state.auditor=false;});

describe('guards are unchanged by the merge',()=>{
 it.each(['employee','manager'] as const)('%s: every /control-tower route is refused by the shared layout, and the old explainer refuses before forwarding',async role=>{
  state.session=SESSIONS[role];
  expect(await redirectOf(()=>ControlTowerLayout({children:null}))).toEqual({url:'/',status:'307'});
  expect(await redirectOf(()=>requireAdmin())).toEqual({url:'/',status:'307'});
  // Refused, not forwarded: a non-administrator never learns the new address from this route.
  expect(await redirectOf(()=>HowItWorksPage())).toEqual({url:'/',status:'307'});
 });

 it.each(['hrAdmin','groupAdmin'] as const)('%s: admitted by the layout; "How the Control Tower works" answers 308 to How it works',async role=>{
  state.session=SESSIONS[role];
  expect(await redirectOf(()=>ControlTowerLayout({children:null}))).toBeNull();
  expect(await requireAdmin()).toBe(SESSIONS[role]);
  expect(await redirectOf(()=>HowItWorksPage())).toEqual({url:'/assistant?view=how',status:'308'});
 });

 it('the guard functions are the same source as before the merge',()=>{
  const authz=read('lib/authz.ts');
  expect(authz).toContain(`export async function requireAdmin(): Promise<SessionContext> {
  const s = await getSession();
  if (!isAdmin(s)) redirect('/');
  return s;
}`);
  expect(read('lib/authz-model.ts')).toContain(`const ADMIN_ROLES = new Set(['hr_admin', 'super_admin']);`);
  expect(read('app/control-tower/layout.tsx')).toContain(`export default async function ControlTowerLayout({ children }: { children: ReactNode }) {
  await requireAdminOrAuditReader();
  return <>{children}</>;
}`);
  expect(read('lib/authz.ts')).toContain(`export async function requireAdminOrAuditReader(): Promise<SessionContext> {
  const s = await getSession();
  if (isAdmin(s)) return s;
  if (!(await hasAuditReaderGrant(s))) redirect('/');
  return s;
}`);
 });

 it('Phase 2 hardening: a read-only auditor passes the layout for the Audit loop page, and every other page still sends them home',async()=>{
  state.session=SESSIONS.employee;state.auditor=true;
  expect(await redirectOf(()=>ControlTowerLayout({children:null}))).toBeNull();
  expect(await redirectOf(()=>requireAdmin())).toEqual({url:'/',status:'307'});
  expect(await redirectOf(()=>HowItWorksPage())).toEqual({url:'/',status:'307'});
  state.auditor=false;
  expect(await redirectOf(()=>ControlTowerLayout({children:null}))).toEqual({url:'/',status:'307'});
 });

 it('every /control-tower page still calls requireAdmin first, under the shared layout',()=>{
  const pages:string[]=[];
  const walk=(dir:string)=>{for(const entry of fs.readdirSync(path.join(ROOT,dir),{withFileTypes:true})){
   const rel=path.join(dir,entry.name);if(entry.isDirectory())walk(rel);else if(entry.name==='page.tsx')pages.push(rel);}};
  walk('app/control-tower');
  // Fifteen, plus the AI v2 W8 loops list and loop detail (app/control-tower/loops/page.tsx and [loop]/page.tsx), plus
  // AI v2 P2-2a's Payroll cycle view, its Salary payroll page and its settings (app/control-tower/loops/payroll-cycle/), and
  // the AI v2 P2-2b Audit loop page (app/control-tower/loops/loop_payroll_audit/page.tsx), and AI v2 P2-1's promote page
  // (app/control-tower/loops/[loop]/promote/page.tsx).
  // AI Centre restructure (4 Nov 2026): plus Administration › Build list (app/control-tower/agents/build-list/page.tsx).
  expect(pages.length).toBe(23);
  expect(pages).toContain(path.join('app/control-tower/loops','[loop]','promote','page.tsx'));
  expect(pages).toEqual(expect.arrayContaining([path.join('app/control-tower/loops','page.tsx'),path.join('app/control-tower/loops','[loop]','page.tsx'),
   path.join('app/control-tower/loops','loop_payroll_audit','page.tsx')]));
  expect(pages).toEqual(expect.arrayContaining([path.join('app/control-tower/loops','payroll-cycle','page.tsx'),
   path.join('app/control-tower/loops','payroll-cycle','salary','page.tsx'),path.join('app/control-tower/loops','payroll-cycle','settings','page.tsx')]));
  // Phase 2 hardening: the Audit loop page alone admits a read-only auditor (its own read is the auditor's granted companies).
  const auditPage=path.join('app/control-tower/loops','loop_payroll_audit','page.tsx');
  for(const page of pages)expect(read(page),page).toMatch(page===auditPage?/await requireAdminOrAuditReader\(\)/:/await requireAdmin\(\)/);
 });

 // AI Centre restructure (owner decisions 26–29, 4 Nov 2026): every removed page is a guarded forward stub. Each runs the
 // unchanged requireAdmin first (a non-administrator, and an auditor, is refused exactly as before and never learns the new
 // address) and forwards an administrator, permanently, to the one page that owns the fact now. None of them reads.
 const STUBS=[
  ['/control-tower (Overview)',OverviewStub,'/control-tower/loops','308'],
  ['/control-tower/actions (Proposed actions)',ProposedActionsStub,'/control-tower/exceptions#fixed-causes','308'],
  ['/control-tower/opportunities',OpportunitiesStub,'/assistant?view=insights#hr-capacity','308'],
  ['/control-tower/agents/inventory',InventoryStub,'/control-tower/agents/features#ai-inventory','308'],
  ['/control-tower/agents/orchestrator',OrchestratorStub,'/control-tower/readiness','307'],
 ] as const;
 it.each(STUBS)('%s refuses employees, managers and auditors before forwarding',async(_name,page)=>{
  for(const role of ['employee','manager'] as const){state.session=SESSIONS[role];expect(await redirectOf(()=>page())).toEqual({url:'/',status:'307'});}
  state.session=SESSIONS.employee;state.auditor=true;
  expect(await redirectOf(()=>page())).toEqual({url:'/',status:'307'});
 });
 it.each(STUBS)('%s forwards an HR or group administrator to its single source',async(_name,page,url,status)=>{
  for(const role of ['hrAdmin','groupAdmin'] as const){state.session=SESSIONS[role];expect(await redirectOf(()=>page())).toEqual({url,status});}
 });
 it('each stub reads nothing: its code is the guard and the forward',()=>{
  for(const file of ['app/control-tower/page.tsx','app/control-tower/actions/page.tsx','app/control-tower/opportunities/page.tsx','app/control-tower/agents/inventory/page.tsx','app/control-tower/agents/orchestrator/page.tsx']){
   const code=read(file).replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
   expect(code.match(/^import .*$/gm),file).toEqual([expect.stringMatching(/next\/navigation/),"import { requireAdmin } from '@/lib/authz';"]);
   expect(code,file).toMatch(/await requireAdmin\(\);\s*(permanentRedirect|redirect)\('/);
  }
 });
 it('Build list: a company HR administrator is sent to Workers before anything is read; employees are refused',async()=>{
  state.session=SESSIONS.hrAdmin;
  expect(await redirectOf(()=>BuildListPage({searchParams:Promise.resolve({})}))).toEqual({url:'/control-tower/agents/features',status:'307'});
  state.session=SESSIONS.employee;
  expect(await redirectOf(()=>BuildListPage({searchParams:Promise.resolve({})}))).toEqual({url:'/',status:'307'});
 });
});
