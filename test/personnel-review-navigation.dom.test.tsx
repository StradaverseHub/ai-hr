/** @vitest-environment jsdom */
/** Real landing-page branches and real navigation RSC; no browser/server/provider operation. */
import React from 'react';
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
const fixture=vi.hoisted(()=>({allowed:true,locale:'en',actions:['employees.workforce_profile.maintain','employees.code.maintain'] as string[],navigation:vi.fn()}));
const copies:Record<string,unknown>={en,ms,zh,ta,th,vi:viMessages};
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>Object.assign((key:string,values?:Record<string,string|number>)=>{let value:unknown=copies[fixture.locale];for(const name of (namespace+'.'+key).split('.'))value=(value as Record<string,unknown>)?.[name];if(typeof value!=='string')throw Error('Missing translation '+namespace+'.'+key);return value.replace(/\{(\w+)\}/g,(_,name:string)=>String(values?.[name]??name));},{has:()=>false})}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
vi.mock('../components/ui',()=>({Card:({children}:React.PropsWithChildren)=><div>{children}</div>,PageHeader:()=>null,ErrorBanner:()=>null}));
vi.mock('../core/assistant-actions/personnel-review-navigation',()=>({availablePersonnelReviewNavigation:(...args:unknown[])=>{fixture.navigation(...args);return Promise.resolve(fixture.actions);}}));
vi.mock('../lib/session',()=>({getSession:async()=>ctx}));
vi.mock('../lib/authz',()=>({isGroupAdmin:()=>false}));
vi.mock('../lib/viewer',()=>({viewerIdentity:async()=>({name:null})}));
vi.mock('../core/employee-home',()=>({readEmployeeHomeIdentity:async()=>({selectedEmploymentId:null})}));
vi.mock('../core/ai-workspace',()=>({loadAiWorkspace:async()=>({access:fixture.allowed?{allowed:true}:{allowed:false,reason:'unavailable'},history:[],jobModules:[],taskIds:[],planningPermit:null,planningAvailability:'resting',proposal:null,governedJob:null})}));
vi.mock('../core/assistant',()=>({MAX_TURNS:5}));
vi.mock('../core/assistant-actions/module-action-entries',()=>({allowedModuleActionEntries:async()=>[]}));
vi.mock('../core/workspace-module-jobs',()=>({loadCanonicalModuleJob:vi.fn()}));
vi.mock('../components/assistant/module-jobs',()=>({CanonicalModuleJob:()=>null,ModuleJobChooser:()=>null,GroundedWorkspaceReply:()=>null,GovernedModuleJobComposer:()=>null,GovernedWorkspaceJob:()=>null}));
vi.mock('../components/assistant/workspace-composer',()=>({WorkspaceComposer:()=>null}));
vi.mock('../components/assistant/module-plan',()=>({ModuleQuestionPlanner:()=>null}));
vi.mock('../components/assistant/module-specialist-review',()=>({SpecialistJobComposer:()=>null}));
vi.mock('../components/assistant/history-privacy',()=>({AssistantHistoryPrivacy:()=>null}));
vi.mock('../components/assistant/own-clear',()=>({OwnClearForm:()=>null,OwnClearStatus:()=>null}));
vi.mock('../components/assistant/import-privacy',()=>({ImportPreparationPrivacy:()=>null}));
vi.mock('../components/assistant/native-outcomes',()=>({NativeOutcomes:()=>null,NativeOutcomePrivacy:()=>null}));
vi.mock('../components/assistant/assistant-home-tabs',()=>({AssistantHomeTabs:()=>null}));
vi.mock('../components/employee-home/tasks-card',()=>({HomeTasksCard:()=>null}));
vi.mock('../components/employee-home/calendar-card',()=>({HomeCalendarCard:()=>null}));
vi.mock('../app/assistant/actions',()=>({askAssistantAction:vi.fn()}));
vi.mock('../app/assistant/agent-review-actions',()=>({eraseConversationMetadataAction:vi.fn()}));
vi.mock('../app/assistant/module-plan-actions',()=>({eraseModuleProposalsAction:vi.fn()}));
vi.mock('../app/assistant/job-feedback-actions',()=>({eraseGovernedJobFeedbackAction:vi.fn()}));
vi.mock('../app/assistant/feedback-actions',()=>({saveAgentFeedbackAction:vi.fn(),eraseAgentFeedbackAction:vi.fn()}));
import AssistantPage from '../app/assistant/page';
import {PersonnelReviewNavigation} from '../components/assistant/personnel-review-navigation';
type SessionContext=Parameters<typeof PersonnelReviewNavigation>[0]['ctx'];
const ctx:SessionContext={tenantId:'86000000-0000-4000-8000-000000000001',userId:'86000000-0000-4000-8000-000000000002',personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]};
function findNavigation(node:React.ReactNode):React.ReactElement<{ctx:SessionContext}>|null{
 if(Array.isArray(node)){for(const child of node){const found=findNavigation(child);if(found)return found;}return null;}
 if(!React.isValidElement(node))return null;if(node.type===PersonnelReviewNavigation)return node as React.ReactElement<{ctx:SessionContext}>;
 return findNavigation((node.props as {children?:React.ReactNode}).children);
}
beforeEach(()=>{fixture.allowed=true;fixture.locale='en';fixture.actions=['employees.workforce_profile.maintain','employees.code.maintain'];fixture.navigation.mockClear();vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No navigation fetch');}));});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
for(const locale of ['en','ms','zh','ta','th','vi'])for(const allowed of [true,false])it(`renders fixed localized human links in ${locale}, workspace/history available=${allowed}, without fact cards or effects`,async()=>{
 fixture.locale=locale;fixture.allowed=allowed;const tree=await AssistantPage({searchParams:Promise.resolve({})}),entry=findNavigation(tree);expect(entry).not.toBeNull();expect(entry!.props.ctx).toEqual(ctx);render(await PersonnelReviewNavigation(entry!.props));
 const t=(copies[locale] as typeof en).assistant.workspace;expect(screen.getByRole('heading',{name:t.jobs.reviewAction})).toBeTruthy();expect(screen.getByText(t.jobs.humanReviewNote)).toBeTruthy();expect(screen.getByRole('link',{name:t.workforceProfileMaintenance.title}).getAttribute('href')).toBe('/assistant/workforce-profile');expect(screen.getByRole('link',{name:t.employeeCodeMaintenance.title}).getAttribute('href')).toBe('/assistant/employee-code');expect(screen.getAllByRole('link')).toHaveLength(2);expect(fixture.navigation).toHaveBeenCalledExactlyOnceWith(ctx);expect(document.querySelector('form,button,input')).toBeNull();expect(fetch).not.toHaveBeenCalled();expect(document.body.textContent).not.toContain(ctx.userId);expect(document.body.textContent).not.toContain(ctx.tenantId);
});
it('hides the whole card when fresh navigation refuses, independently of an accessible workspace',async()=>{fixture.actions=[];const tree=await AssistantPage({searchParams:Promise.resolve({})}),entry=findNavigation(tree);expect(entry).not.toBeNull();expect(await PersonnelReviewNavigation(entry!.props)).toBeNull();expect(fixture.navigation).toHaveBeenCalledExactlyOnceWith(ctx);});
it('offers only the allowed closed action and never adds subject/query parameters or cost navigation',async()=>{fixture.actions=['employees.code.maintain'];render(await PersonnelReviewNavigation({ctx}));expect(screen.getAllByRole('link')).toHaveLength(1);expect(screen.getByRole('link').getAttribute('href')).toBe('/assistant/employee-code');expect(document.querySelector('a[href*="?"],a[href*="cost-allocation"]')).toBeNull();});
