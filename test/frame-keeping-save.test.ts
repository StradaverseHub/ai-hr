/** ADR 0181 Phase 3, decision 4: saves that keep the app frame (lib/action-navigation.ts).
 *
 * On the fictional 71-company / 1,000-employment group fixture (test/helpers/ai-centre-scale-fixture.ts), with pending
 * leave, a line manager's team and notifications for every persona, this proves for the native roles:
 *  - equivalence: the shell approval facts re-read after a save (app/shell-approval-facts-read.ts) equal the previous
 *    layout composition, written out here as it stood before this change, under "All companies" and one company; the
 *    bell re-read after a mark-read (app/bell-notifications.ts) equals the previous shell composition;
 *  - cost: the re-read costs fewer statements and less database time than drawing the frame, and reads none of the
 *    menu and access owners (letters, rewards, offboarding postings, configurable access);
 *  - behaviour: a decision posted by <ActionNavigateForm> commits, returns where to go and asks for the facts to be
 *    re-read, and calls neither revalidatePath nor redirect (either makes Next draw the whole tree); the same action
 *    from a plain form still revalidates the layout and redirects; the badge total drops by exactly the decided item;
 *  - a mark-read returns the bell without the item and never revalidates.
 * Each cost line is printed as `FRAME_KEEPING_SAVE {json}`. All names are invented. */
import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({session:undefined as unknown,pathname:'/personnel',cookies:{} as Record<string,string>}));
const spies=vi.hoisted(()=>({revalidatePath:[] as unknown[][],redirect:[] as string[]}));
vi.mock('next/font/google',()=>{const font=()=>({variable:'fixture-font'});return {Plus_Jakarta_Sans:font,Geist_Mono:font,DM_Mono:font};});
vi.mock('next/font/local',()=>({default:()=>({variable:'fixture-local-font'})}));
vi.mock('next/headers',()=>({
 headers:async()=>new Headers({'x-pathname':state.pathname}),
 cookies:async()=>({get:(name:string)=>name in state.cookies?{name,value:state.cookies[name]}:undefined,
  getAll:()=>Object.entries(state.cookies).map(([name,value])=>({name,value})),has:(name:string)=>name in state.cookies}),
}));
vi.mock('next/cache',async importOriginal=>({...await importOriginal<typeof import('next/cache')>(),
 revalidatePath:(...args:unknown[])=>{spies.revalidatePath.push(args);}}));
vi.mock('next/navigation',async importOriginal=>{
 const actual=await importOriginal<typeof import('next/navigation')>();
 return {...actual,redirect:(url:string)=>{spies.redirect.push(url);return actual.redirect(url);}};
});
vi.mock('next-intl/server',()=>{
 const translator=(namespace?:string)=>{
  const t=(key:string,values?:Record<string,unknown>)=>`${namespace?namespace+'.':''}${key}${values?JSON.stringify(values):''}`;
  return Object.assign(t,{rich:t,markup:t,raw:(key:string)=>key,has:()=>true});
 };
 return {
  getLocale:async()=>'en',getTimeZone:async()=>'Asia/Kuala_Lumpur',getNow:async()=>new Date(),getMessages:async()=>({}),
  getTranslations:async(arg?:string|{namespace?:string})=>translator(typeof arg==='string'?arg:arg?.namespace),
  getFormatter:async()=>({dateTime:(value:unknown)=>new Date(value as string).toISOString(),number:(value:unknown)=>String(value),
   relativeTime:(value:unknown)=>String(value),list:(value:unknown[])=>value.join(', '),dateTimeRange:(a:unknown,b:unknown)=>`${String(a)}–${String(b)}`}),
 };
});
vi.mock('../lib/demo-mode',async importOriginal=>({...await importOriginal<typeof import('../lib/demo-mode')>(),
 demoSwitcherEnabled:()=>false,isDemoDeployment:()=>false}));
vi.mock('../lib/session',async importOriginal=>({...await importOriginal<typeof import('../lib/session')>(),
 getSession:async()=>state.session,getBrowserCommandSession:async()=>state.session}));

import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {withRequestReadScope} from '../lib/request-read-scope';
import {todayInKualaLumpur} from '../lib/hr-date';
import {isAdmin} from '../lib/authz';
import {companyContextForPage} from '../lib/scope';
import {isModuleEnabledOrFalse} from '../core/entitlements';
import {pendingTaskSummary} from '../core/approvals-inbox';
import {notificationBellSummary} from '../core/notifications';
import {onboardingNoticeSummary} from '../packs/lifecycle/service';
import {ACTION_NAVIGATION_FIELD} from '../lib/action-navigation';
import Layout from '../app/layout';
import {EMPTY_LIFECYCLE_MODULE_INBOX,lifecycleModuleInbox,type LifecycleModuleInbox} from '../app/lifecycle/module-inbox';
import {lifecycleModuleNavigation} from '../app/lifecycle/workflow-availability';
import {readShellApprovalFacts} from '../app/shell-approval-facts-read';
import {bellNotificationScope,readBellNotifications} from '../app/bell-notifications';
import {approveLeaveAction} from '../app/approvals/actions';
import {markNotificationReadAction} from '../app/notification-actions';
import type {ShellApprovalResult} from '../components/shell-approval-facts';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {explainStatements,observeStatements} from './helpers/statement-observer';
import {serverTreeSnapshot} from './helpers/server-tree-snapshot';

const ROLES=['group','multi','single','manager','employee','payroll'] as const;
type Role=(typeof ROLES)[number];
/** Menu and access owners the frame reads and a frame-keeping save must not read again. */
const MENU_OWNERS=/letter_permission_for_user|reward_capability|offboarding_posting_queue_access|access_capability_allowed|recruitment_team_presence|assistant_launcher/i;

let b:Base,fixture:ScaleFixture;
let personas:Record<Role|'base',SessionContext>;
let workCompanyId:string;
let teamRequestIds:string[]=[];
const notificationIds=new Map<Role,string[]>();

function dayPlus(date:string,days:number){const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
/** A weekday at least two weeks out, so no request touches a past or locked period. */
function weekday(offset:number){let d=dayPlus(todayInKualaLumpur(),14+offset);while([0,6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))d=dayPlus(d,1);return d;}

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1000,events:2000});
 const base=await entitledCtx(b,['hr_admin']);
 const own=async(employmentId:string,roles:string[],companyId:string|null=null):Promise<SessionContext>=>{
  const [row]=await owner.db.select({personId:schema.employment.personId}).from(schema.employment).where(sql`${schema.employment.id}=${employmentId}::uuid`);
  const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId:row.personId}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values(roles.map(role=>({tenantId:b.tenantId,appUserId:u.id,companyId,role:role as 'employee'})));
  return {...base,userId:u.id,personId:row.personId,roles,grants:roles.map(role=>({role,companyId}))};
 };
 const active=await owner.db.select({id:schema.employment.id,companyId:schema.employment.companyId}).from(schema.employment)
  .where(sql`${schema.employment.id}=any(${sql.raw(`array[${fixture.activeEmploymentIds.map(id=>`'${id}'`).join(',')}]`)}::uuid[])`)
  .orderBy(schema.employment.companyId,schema.employment.employeeCode);
 // The manager leads three reports of their own company.
 const managerEmployment=fixture.activeEmploymentIds[11];
 const managerCompany=active.find(e=>e.id===managerEmployment)!.companyId;
 const reserved=new Set([11,23,37].map(i=>fixture.activeEmploymentIds[i]));
 const team=active.filter(e=>e.companyId===managerCompany&&!reserved.has(e.id)).slice(0,3);
 expect(team.length).toBe(3);
 await owner.db.insert(schema.reportingLine).values(team.map(r=>({tenantId:b.tenantId,subordinateEmploymentId:r.id,managerEmploymentId:managerEmployment,lineType:'administrative' as const,validFrom:'2020-01-01'})));
 personas={...fixture.personas,
  manager:await own(managerEmployment,['manager']),
  employee:await own(fixture.activeEmploymentIds[23],['employee']),
  payroll:await own(fixture.activeEmploymentIds[37],['employee','payroll_partner']),
  base:undefined as unknown as SessionContext};
 workCompanyId=b.companyId;
 personas.base=personas.single;
 // Pending one-day leave (an ordinary whole-request approval: no per-date rows): the manager's team, and one request in each of 40 other companies for the administrators.
 const others=[...new Map(active.filter(e=>e.companyId!==managerCompany&&!reserved.has(e.id)).map(e=>[e.companyId,e])).values()].slice(0,40);
 const requests=[...team,...others].map((e,i)=>({id:randomUUID(),employmentId:e.id,date:weekday(i%20)}));
 teamRequestIds=requests.slice(0,3).map(r=>r.id);
 await owner.db.insert(schema.leaveRequest).values(requests.map(r=>({id:r.id,tenantId:b.tenantId,employmentId:r.employmentId,leaveTypeId:b.annualLeaveTypeId,
  startDate:r.date,endDate:r.date,days:'1',durationType:'full_day' as const,status:'pending' as const})));
 // Notifications for every persona's login: three unread updates, two unread action items, two read.
 for(const role of ROLES){
  const rows=[0,1,2,3,4,5,6].map(i=>({id:randomUUID(),tenantId:b.tenantId,recipientUserId:personas[role].userId!,kind:'fixture.notice',
   title:`Fictional notice ${i+1}`,body:'Fixture only',severity:(i===3||i===4?'action':'info') as 'info'|'action',
   readAt:i>=5?new Date(Date.now()-3_600_000):null,createdAt:new Date(Date.now()-(i+1)*60_000)}));
  await owner.db.insert(schema.notification).values(rows);
  notificationIds.set(role,rows.filter(r=>r.readAt===null&&r.severity==='info').map(r=>r.id));
 }
 await owner.db.execute(sql`analyze public.leave_request, public.leave_request_date, public.reporting_line, public.notification`);
},300_000);
afterAll(async()=>{await closeAll();});
beforeEach(()=>{spies.revalidatePath.length=0;spies.redirect.length=0;});

function as(role:Role,scope:'all'|'one'='all'){
 state.session=personas[role];
 state.cookies=scope==='one'?{company_scope:role==='single'?fixture.singleCompanyId:workCompanyId}:{};
 return personas[role];
}

/** The layout's approval facts as composed before this change (app/layout.tsx at PR 282), kept here as the reference. */
async function previousShellApprovalFacts(session:SessionContext):Promise<ShellApprovalResult>{
 const {scopeIds}=await companyContextForPage(session);
 const navigation=await lifecycleModuleNavigation(session);
 const approvalSummary=await pendingTaskSummary(session,scopeIds,{
  attendance:isModuleEnabledOrFalse(session,'attendance'),
  claims:isModuleEnabledOrFalse(session,'claims'),
  performance:isModuleEnabledOrFalse(session,'performance'),
  rewards:isModuleEnabledOrFalse(session,'rewards'),
  recruitment:isModuleEnabledOrFalse(session,'recruitment'),
  probation:isModuleEnabledOrFalse(session,'lifecycle')||!!session.entitlements?.scopedModules.lifecycle?.length,
 },{deferClaimPreview:true});
 const lifecycle:LifecycleModuleInbox=await lifecycleModuleInbox(session,navigation).catch(()=>EMPTY_LIFECYCLE_MODULE_INBOX);
 const canApprove=isAdmin(session)||(session.roles??[]).includes('manager');
 return {state:'ready',items:approvalSummary.items,total:approvalSummary.total,
  approvalCount:approvalSummary.approvalCount+lifecycle.approvalCount,claimTotal:approvalSummary.claimTotal,
  lifecycleTaskCount:lifecycle.myTasksCount,
  hasAssignedAttendanceApproval:!canApprove&&approvalSummary.items.some(task=>task.kind==='attendance'),
  hasAssignedApproval:!canApprove&&(approvalSummary.approvalCount+lifecycle.approvalCount)>0};
}

/** The shell's bell notifications as composed before this change (app/shell-notification-center.tsx at PR 282). */
async function previousBell(session:SessionContext){
 const {scopeIds}=await companyContextForPage(session);
 const notifEnabled=isModuleEnabledOrFalse(session,'notifications');
 const letters=scopeIds.filter(id=>isModuleEnabledOrFalse(session,'notifications',id));
 const scope=notifEnabled?{}:letters.length>0?{letterCompanyIds:letters}:null;
 const lifecycleEnabled=isModuleEnabledOrFalse(session,'lifecycle');
 const notices=lifecycleEnabled?await onboardingNoticeSummary(session):{unread:[],read:[],unreadCount:0};
 const bell=scope?await notificationBellSummary(session,scope):{unread:0,taskCount:0,items:[],tasks:[],read:[]};
 return {unread:bell.unread+notices.unreadCount,items:[...bell.items,...notices.unread],taskNotifications:bell.tasks,
  notificationTaskCount:bell.taskCount,readItems:[...bell.read,...notices.read]};
}

describe('frame-keeping save: equivalence with the previous readers',()=>{
 for(const role of ROLES)for(const scope of ['all','one'] as const){
  it(`re-reads the shell approval facts exactly as the layout composed them (${role}, ${scope})`,async()=>{
   const session=as(role,scope);
   const expected=await previousShellApprovalFacts(session);
   const actual=await readShellApprovalFacts(session);
   expect(actual).toEqual(expected);
   if(role==='manager')expect(expected.state==='ready'&&expected.total,'the manager has the team requests').toBeGreaterThanOrEqual(3);
   if(role==='group'&&scope==='all')expect(expected.state==='ready'&&expected.total,'the group administrator sees work across the group').toBeGreaterThan(3);
  },120_000);
  it(`re-reads the bell exactly as the shell composed it (${role}, ${scope})`,async()=>{
   const session=as(role,scope);
   const expected=await previousBell(session);
   const actual=await readBellNotifications(session,bellNotificationScope(session,(await companyContextForPage(session)).scopeIds),
    isModuleEnabledOrFalse(session,'lifecycle'));
   expect(actual).toEqual(expected);
   expect(actual.items.length,'the fixture notifications are visible').toBeGreaterThanOrEqual(3);
   expect(actual.notificationTaskCount).toBeGreaterThanOrEqual(2);
  },120_000);
 }
});

describe('frame-keeping save: cost',()=>{
 for(const role of ROLES){
  it(`re-reads the approval facts for less than the frame and without its menu owners (${role})`,async()=>{
   const session=as(role);
   state.pathname='/personnel';
   const frame=await withRequestReadScope({},()=>observeStatements(()=>serverTreeSnapshot(createElement(Layout,{children:null}))));
   const refresh=await observeStatements(()=>readShellApprovalFacts(session));
   const menuInRefresh=refresh.statements.filter(statement=>MENU_OWNERS.test(statement.sql));
   const menuInFrame=frame.statements.filter(statement=>MENU_OWNERS.test(statement.sql));
   const [frameTime,refreshTime]=await Promise.all([explainStatements(frame.statements),explainStatements(refresh.statements)]);
   const ms=(rows:typeof frameTime)=>Math.round(rows.reduce((sum,row)=>sum+(row.executionMs??0)+(row.planningMs??0),0));
   console.log('FRAME_KEEPING_SAVE '+JSON.stringify({role,frame:{statements:frame.statements.length,transactions:frame.transactions,dbMs:ms(frameTime),menuOwners:menuInFrame.length},
    refresh:{statements:refresh.statements.length,transactions:refresh.transactions,dbMs:ms(refreshTime),menuOwners:menuInRefresh.length}}));
   expect(menuInRefresh.map(s=>s.sql.slice(0,120))).toEqual([]);
   expect(refresh.statements.length).toBeLessThan(frame.statements.length);
  },180_000);
 }
});

describe('frame-keeping save: behaviour',()=>{
 it('decides from <ActionNavigateForm> without revalidating or redirecting, and the badge follows the decision',async()=>{
  const session=as('manager');
  const before=await readShellApprovalFacts(session);
  expect(before.state).toBe('ready');
  const form=new FormData();
  form.set('id',teamRequestIds[0]);form.set('decision','rejected');form.set('rejectReason','Fictional: team cover');
  form.set(ACTION_NAVIGATION_FIELD,'client');
  const result=await approveLeaveAction(form);
  expect(result).toEqual({navigate:'/approvals?toast=Leave+rejected',refreshShellApprovals:true});
  expect(spies.revalidatePath).toEqual([]);
  expect(spies.redirect).toEqual([]);
  const [row]=await owner.db.select({status:schema.leaveRequest.status}).from(schema.leaveRequest).where(sql`${schema.leaveRequest.id}=${teamRequestIds[0]}::uuid`);
  expect(row.status).toBe('rejected');
  const after=await readShellApprovalFacts(session);
  expect(after.state==='ready'&&before.state==='ready'&&before.total-after.total).toBe(1);
  expect(after).toEqual(await previousShellApprovalFacts(session));
 },120_000);

 it('keeps the revalidate-and-redirect for a plain form',async()=>{
  as('manager');
  const form=new FormData();
  form.set('id',teamRequestIds[1]);form.set('decision','rejected');form.set('rejectReason','Fictional: team cover');
  await expect(approveLeaveAction(form)).rejects.toMatchObject({digest:expect.stringContaining('NEXT_REDIRECT')});
  expect(spies.revalidatePath).toEqual([['/approvals'],['/','layout']]);
  expect(spies.redirect).toEqual(['/approvals?toast=Leave+rejected']);
 },120_000);

 it('refuses a decision it may not make without revalidating, and returns the error to show',async()=>{
  as('employee');
  const form=new FormData();
  form.set('id',teamRequestIds[2]);form.set('decision','rejected');form.set('rejectReason','Fictional');
  form.set(ACTION_NAVIGATION_FIELD,'client');
  const result=await approveLeaveAction(form);
  expect(result.refreshShellApprovals).toBeUndefined();
  expect(new URL(result.navigate,'http://x').searchParams.get('error')).toBeTruthy();
  expect(spies.revalidatePath).toEqual([]);
  expect(spies.redirect).toEqual([]);
  const [row]=await owner.db.select({status:schema.leaveRequest.status}).from(schema.leaveRequest).where(sql`${schema.leaveRequest.id}=${teamRequestIds[2]}::uuid`);
  expect(row.status).toBe('pending');
 },120_000);

 it('marks a notification read and returns the bell without it, never revalidating',async()=>{
  const session=as('employee');
  const [id]=notificationIds.get('employee')!;
  const before=await previousBell(session);
  const bell=await markNotificationReadAction(id);
  expect(spies.revalidatePath).toEqual([]);
  expect(bell).not.toBeNull();
  expect(bell!.items.map(n=>n.id)).not.toContain(id);
  expect(bell!.readItems.map(n=>n.id)).toContain(id);
  expect(bell!.unread).toBe(before.unread-1);
  expect(bell).toEqual(await previousBell(session));
 },120_000);
});
