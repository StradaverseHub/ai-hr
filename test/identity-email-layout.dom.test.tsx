import React, {isValidElement} from 'react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({session:vi.fn(),operator:vi.fn(),tasks:vi.fn(),pathname:'/admin/settings/email',theme:'monolith',onboarded:true,scopeIds:[] as string[],module:vi.fn(),feedback:vi.fn(),notificationBell:vi.fn(),dispatch:vi.fn(),privateCases:vi.fn(),lifecycleCount:0,summaryOverride:null as null|{items:unknown[];total:number;approvalCount:number;claimTotal:number}}));

vi.mock('next/font/google',()=>{const font=()=>({variable:'fixture-font'});return {Plus_Jakarta_Sans:font,Geist_Mono:font,DM_Mono:font};});
vi.mock('next/font/local',()=>({default:()=>({variable:'fixture-schibsted-font'})}));
vi.mock('next/headers',()=>({headers:async()=>new Headers({'x-pathname':m.pathname}),cookies:async()=>({get:()=>undefined})}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en'}));
vi.mock('../lib/session',()=>({getSession:m.session}));
vi.mock('../lib/identity/email-settings',()=>({canConfigureIdentityEmail:m.operator}));
vi.mock('../lib/viewer',()=>({viewerIdentity:async()=>({name:'Fixture',employeeCode:null,employed:false})}));
vi.mock('../lib/principals',()=>({listPrincipals:async()=>[]}));
vi.mock('../lib/demo-mode',()=>({demoSwitcherEnabled:()=>true,isDemoDeployment:()=>true}));
vi.mock('../lib/scope',()=>({companyContextForPage:async()=>({allowed:[],scopeIds:m.scopeIds})}));
vi.mock('../lib/ui-theme-server',()=>({currentUiTheme:async()=>m.theme}));
vi.mock('../core/read',()=>({allowedCompanies:async()=>[],listApprovalHistory:async()=>[]}));
vi.mock('../packs/lifecycle/service',()=>({onboardingTasks:async()=>[],onboardingNoticeSummary:async()=>({unread:[],read:[],unreadCount:0}),onboardingNavigation:async()=>({module:false,master:false,requisitions:false,joiners:0,checklists:0})}));
vi.mock('../components/onboarding-tour',()=>({OnboardingTour:()=>null}));
vi.mock('../core/assistant-launcher',()=>({assistantShellFor:async()=>({allowed:false,launcher:null})}));
// New capability owners are independent of SMTP installation enrollment and the legacy rail.
// This shell test controls those boundaries; their actual permission algebra is covered by DB cases.
vi.mock('../core/shell-navigation-access',()=>({readShellNavigationAccess:async()=>({
 accessConfigurationAvailable:false,workforceAvailable:false,architectureAvailable:false,onboarded:m.onboarded,
})}));
vi.mock('../core/approvals-inbox',()=>({listPendingTasks:m.tasks,pendingTaskSummary:async(...args:unknown[])=>{
 const items=await m.tasks(...args);return m.summaryOverride??{items,total:items.length,approvalCount:items.filter((item:{linkPath:string})=>item.linkPath.split(/[?#]/,1)[0]==='/approvals').length,claimTotal:items.filter((item:{kind:string})=>item.kind==='claim').length};
}}));
vi.mock('../app/lifecycle/workflow-availability',()=>({lifecycleModuleNavigation:async()=>({probation:{page:false,configure:false},contractStaff:{page:false,configure:false}})}));
vi.mock('../app/lifecycle/module-inbox',()=>({lifecycleModuleInbox:async()=>({count:m.lifecycleCount,items:[]})}));
// AI v2 W11: the rail's "Private cases" row asks the private-case owner (a database read) on every page. Unmocked,
// this no-database shell test sent it to the closed CI port, and postgres.js's shared reconnect backoff made each
// later Layout call wait longer, up to the 5 s timeout (run 41626195537). The owner's rule has its own DB tests.
vi.mock('../core/private-cases',()=>({handlesPrivateCases:m.privateCases}));

vi.mock('../core/notifications',()=>({dispatchNotifications:m.dispatch,notificationBellSummary:m.notificationBell}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:m.module,isModuleEnabledOrFalse:m.module,settingEnabledOrDefault:m.feedback}));
vi.mock('../components/command-bar',()=>({CommandBar:()=>null}));
vi.mock('../components/notice/notice-surfaces',()=>({NoticePopupSlot:()=>null}));
vi.mock('../components/user-menu',()=>({UserMenu:()=>null}));
vi.mock('../components/dev-identity-switcher',()=>({DevIdentitySwitcher:()=>null}));
vi.mock('../components/company-switcher',()=>({CompanySwitcher:()=>null}));
import Layout from '../app/layout';
import {NotificationCenter} from '../components/notification-center';
import {Sidebar} from '../components/sidebar';
import {ShellApprovalFactsProvider,type ShellApprovalResult} from '../components/shell-approval-facts';
import {OnboardingTour} from '../components/onboarding-tour';
import {NoticePopupSlot} from '../components/notice/notice-surfaces';
import {WELCOME_TOUR_ID} from '../lib/onboarding-tour';
beforeEach(()=>{m.dispatch.mockReset();m.dispatch.mockResolvedValue(undefined);m.lifecycleCount=0;m.summaryOverride=null;m.privateCases.mockReset();m.privateCases.mockResolvedValue(false);m.theme='monolith';m.scopeIds=[];m.module.mockReset();m.module.mockReturnValue(false);m.feedback.mockReset();m.feedback.mockReturnValue(true);m.notificationBell.mockReset();m.notificationBell.mockResolvedValue({unread:0,taskCount:0,items:[],tasks:[],read:[]});m.tasks.mockReset();m.tasks.mockResolvedValue([]);m.pathname='/admin/settings/email';m.onboarded=true;});

function propsOf(node:React.ReactNode,target:unknown):Record<string,unknown>|undefined{
 if(Array.isArray(node)){for(const child of node){const found=propsOf(child,target);if(found)return found;}return;}
 if(!isValidElement<{children?:React.ReactNode}>(node))return;
 if(node.type===target)return node.props;
 return propsOf(node.props.children,target);
}
const sidebarProps=(node:React.ReactNode)=>propsOf(node,Sidebar);
const approvalSource=(node:React.ReactNode)=>propsOf(node,ShellApprovalFactsProvider)!.source as Promise<ShellApprovalResult>;
describe('root layout SMTP preview authority',()=>{
 it.each([[null,true],['company',false]] as const)('only attempts notification catch-up for group grants (%s)',async(companyId,expected)=>{
  const session={tenantId:'tenant',userId:'user',roles:['hr_admin'],grants:[{role:'hr_admin',companyId}]};
  m.session.mockResolvedValue(session);m.operator.mockResolvedValue(false);
  m.module.mockImplementation((_session,module)=>module==='notifications');
  await Layout({children:<span>Fixture content</span>});
  expect(m.dispatch).toHaveBeenCalledTimes(expected?1:0);
 });
 it.each([false,true])('passes the current tenant Feedback setting to the rail when enabled=%s',async(enabled)=>{
  const session={tenantId:'tenant',userId:'user',roles:['employee'],grants:[]};
  m.session.mockResolvedValue(session);m.operator.mockResolvedValue(false);m.feedback.mockReturnValue(enabled);
  const props=sidebarProps(await Layout({children:<span>Fixture content</span>}));
  expect(props).toBeDefined();expect(props!.feedbackAccess).toBe(enabled);
  expect(m.feedback).toHaveBeenCalledExactlyOnceWith(session,'feedback.menu_enabled');
 });
 it.each([
  {roles:['hr_admin'],preview:true,rail:true},
  {roles:['super_admin'],preview:true,rail:true},
  {roles:['payroll_partner'],preview:false,rail:true},
  {roles:['performance_comp_partner'],preview:false,rail:true},
  {roles:['manager','payroll_partner'],preview:false,rail:true},
  {roles:['employee'],preview:false,rail:false},
 ])('keeps preview eligibility separate from the broader rail for $roles',async({roles,preview,rail})=>{
  m.session.mockResolvedValue({tenantId:'tenant',userId:'user',roles,grants:roles.map(role=>({role,companyId:null}))});m.operator.mockResolvedValue(false);
  const props=sidebarProps(await Layout({children:<span>Fixture content</span>}));expect(props).toBeDefined();expect(props!.isAdmin).toBe(rail);expect(props!.canPreviewIdentityEmail).toBe(preview);expect(props!.canReviewProfileChanges).toBe(preview);expect(props!.canConfigureIdentityEmail).toBe(false);
 });
 it('passes enrolled installation authority independently of HR role',async()=>{
  m.session.mockResolvedValue({tenantId:'tenant',userId:'operator',roles:['employee'],grants:[]});m.operator.mockResolvedValue(true);
  const props=sidebarProps(await Layout({children:null}));expect(props).toBeDefined();expect(props!.isAdmin).toBe(false);expect(props!.canPreviewIdentityEmail).toBe(false);expect(props!.canReviewProfileChanges).toBe(false);expect(props!.canConfigureIdentityEmail).toBe(true);
 });
});

describe('root layout private-case handler row',()=>{
 it.each([[true,true],[false,false]])('passes the owner\'s answer (%s) to the rail',async(handles,expected)=>{
  const session={tenantId:'tenant',userId:'handler',roles:['employee'],grants:[]};
  m.session.mockResolvedValue(session);m.operator.mockResolvedValue(false);m.privateCases.mockResolvedValue(handles);
  const props=sidebarProps(await Layout({children:null}));
  expect(m.privateCases).toHaveBeenCalledExactlyOnceWith(session);expect(props!.privateCaseHandler).toBe(expected);
 });
 it('hides the row when the owner cannot answer, and still renders the shell',async()=>{
  m.session.mockResolvedValue({tenantId:'tenant',userId:'handler',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]});m.operator.mockResolvedValue(false);
  m.privateCases.mockRejectedValue(Error('fictional read failure'));
  const props=sidebarProps(await Layout({children:null}));
  expect(props).toBeDefined();expect(props!.privateCaseHandler).toBe(false);
 });
});

describe('root layout assigned Attendance inbox navigation',()=>{
 it.each(['attendance','leave'])('reuses canonical %s task data without granting manager or team authority',async kind=>{
  m.session.mockResolvedValue({tenantId:'tenant',userId:'employee',roles:['employee'],grants:[]});
  m.operator.mockResolvedValue(false);
  m.tasks.mockResolvedValue([{id:'fictional-task',kind,subjectName:'Fictional colleague',createdAt:new Date().toISOString(),linkPath:'/approvals'}]);
  const tree=await Layout({children:null}),props=sidebarProps(tree);
  expect(m.tasks).toHaveBeenCalledTimes(1);
  await expect(approvalSource(tree)).resolves.toMatchObject({state:'ready',approvalCount:1,
   hasAssignedAttendanceApproval:kind==='attendance',hasAssignedApproval:true});
  expect(props!.canApprove).toBe(false);
  expect(props!.canAccessTeam).toBe(false);
  expect(props!.isAdmin).toBe(false);
 });
 it('keeps relocated Profile Changes in My tasks while counting only Approval Items destinations',async()=>{
  m.session.mockResolvedValue({tenantId:'tenant',userId:'hr',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]});
  m.operator.mockResolvedValue(false);
  const createdAt=new Date().toISOString();
  m.tasks.mockResolvedValue([
   {id:'fictional-attendance',kind:'attendance',subjectName:'Fictional colleague',createdAt,linkPath:'/approvals#attendance'},
   {id:'fictional-profile',kind:'profile',subjectName:'Fictional colleague',createdAt,linkPath:'/admin/personnel/profile-changes#request-fictional-profile'},
  ]);
  const tree=await Layout({children:null}),props=sidebarProps(tree);
  expect(m.tasks).toHaveBeenCalledTimes(1);
  await expect(approvalSource(tree)).resolves.toMatchObject({state:'ready',total:2,approvalCount:1,
   hasAssignedAttendanceApproval:false,hasAssignedApproval:false});
  expect(props!.canApprove).toBe(false);
  expect(props!.isAdmin).toBe(true);
 });
});


it('keeps exact Claims totals and accepted Lifecycle inbox counts together in the shared shell',async()=>{
 m.session.mockResolvedValue({tenantId:'tenant',userId:'hr',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]});m.operator.mockResolvedValue(false);
 m.module.mockImplementation((_ctx:unknown,module:string)=>module==='claims');
 const items=[{id:'leave-preview',kind:'leave',subjectName:'Fictional colleague',createdAt:new Date().toISOString(),linkPath:'/approvals'}];
 m.tasks.mockResolvedValue(items);m.summaryOverride={items,total:10002,approvalCount:10001,claimTotal:10000};m.lifecycleCount=7;
 const tree=await Layout({children:null});
 expect(m.tasks).toHaveBeenCalledTimes(1);
 await expect(approvalSource(tree)).resolves.toMatchObject({state:'ready',items,total:10002,approvalCount:10001,claimTotal:10000});
 expect(sidebarProps(tree)?.taskCount).toBe(7);
 expect(m.tasks.mock.calls[0]?.[3]).toEqual({deferClaimPreview:true});
 expect(propsOf(tree,NotificationCenter)?.taskCount).toBe(7);
 expect(propsOf(tree,NotificationCenter)?.claimPreviewRevision).toEqual(expect.any(String));
 expect(propsOf(tree,NotificationCenter)?.tasks).toEqual([]);
});

it('returns the authenticated shell while the approval owner is still pending',async()=>{
 m.session.mockResolvedValue({tenantId:'tenant',userId:'employee',roles:['employee'],grants:[]});m.operator.mockResolvedValue(false);
 let finish:(items:unknown[])=>void=()=>{};
 m.tasks.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const tree=await Layout({children:<main>Available before approvals</main>});
 expect(sidebarProps(tree)).toBeDefined();
 expect(propsOf(tree,NotificationCenter)).toBeDefined();
 expect(m.tasks).toHaveBeenCalledTimes(1);
 finish([]);
 await expect(approvalSource(tree)).resolves.toMatchObject({state:'ready',total:0});
});

it('reports a failed approval read without exposing its details or failing the page',async()=>{
 m.session.mockResolvedValue({tenantId:'tenant',userId:'employee',roles:['employee'],grants:[]});m.operator.mockResolvedValue(false);
 m.tasks.mockRejectedValueOnce(Error('Private failure'));
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  const tree=await Layout({children:<main>Available despite approvals</main>});
  expect(sidebarProps(tree)).toBeDefined();
  await expect(approvalSource(tree)).resolves.toEqual({state:'unavailable'});
  expect(log).toHaveBeenCalledExactlyOnceWith('Shared shell approval facts unavailable');
 }finally{log.mockRestore();}
});

describe('personal Home opens without automatic overlays',()=>{
 it('suppresses the first-login tour and Notice popup on the employee landing path',async()=>{
  m.session.mockResolvedValue({tenantId:'tenant',userId:'employee',roles:['employee'],grants:[]});m.operator.mockResolvedValue(false);
  m.pathname='/';m.onboarded=false;
  const tree=await Layout({children:<main>Personal Home</main>});
  expect(propsOf(tree,OnboardingTour)?.autoStartTourId).toBeNull();expect(propsOf(tree,NoticePopupSlot)).toBeUndefined();
 });
 it('retains existing overlays on other routes and on the administrator workbench',async()=>{
  for(const [pathname,roles] of [['/me',['employee']],['/',['hr_admin']]] as const){
   m.session.mockResolvedValue({tenantId:'tenant',userId:'login',roles:[...roles],grants:[]});m.operator.mockResolvedValue(false);
   m.pathname=pathname;m.onboarded=false;
   const tree=await Layout({children:null});
   expect(propsOf(tree,OnboardingTour)?.autoStartTourId).toBe(WELCOME_TOUR_ID);expect(propsOf(tree,NoticePopupSlot)).toBeDefined();
  }
 });
});

it('loads account notifications for selected company entitlements without an employment or tenant-wide module',async()=>{
 const active='00000000-0000-4000-8000-000000000001',inactive='00000000-0000-4000-8000-000000000002';m.scopeIds=[active,inactive];
 m.module.mockImplementation((_ctx:unknown,code:string,companyId?:string)=>code==='notifications'&&companyId===active);
 m.session.mockResolvedValue({tenantId:'tenant',userId:'account-only-reviewer',roles:['employee'],grants:[]});m.operator.mockResolvedValue(false);
 const tree=await Layout({children:null});expect(propsOf(tree,NotificationCenter)).toBeDefined();
 expect(m.notificationBell).toHaveBeenCalledExactlyOnceWith(expect.anything(),{letterCompanyIds:[active]});
});

// Actual async RootLayout, not a standalone Sidebar fixture: V9 must keep the customer shell.
it.each(['classic','monolith','atelier'])('keeps V9 inside the selected %s AIHR framework',async theme=>{
 m.theme=theme;m.pathname='/lifecycle/v9';
 m.session.mockResolvedValue({tenantId:'tenant',userId:'user',roles:['hr_admin'],grants:[]});m.operator.mockResolvedValue(false);
 const tree=await Layout({children:<main>V9 reference content</main>});
 expect(tree.props['data-ui-theme']).toBe(theme);expect(sidebarProps(tree)).toBeDefined();
});
it('keeps the same customer shell on a native V9 case deep link',async()=>{
 m.pathname='/lifecycle/v9/onboarding/11111111-1111-4111-8111-111111111111';
 m.session.mockResolvedValue({tenantId:'tenant',userId:'user',roles:['hr_admin'],grants:[]});m.operator.mockResolvedValue(false);
 const tree=await Layout({children:<main>Native case</main>});
 expect(tree.props['data-ui-theme']).toBe('monolith');expect(sidebarProps(tree)).toBeDefined();
});
