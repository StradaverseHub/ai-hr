/** The floating Assistant: a closed page context, settings that fail closed, and a server command that goes
 * through the same askAssistant gate as the Assistant page. Owners are stubbed; askAssistant's own gates
 * are proved by its own suites. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const owner=vi.hoisted(()=>({session:vi.fn(),ask:vi.fn(),workspace:vi.fn(),reply:vi.fn(),setting:vi.fn(),access:vi.fn(),provider:vi.fn(),write:vi.fn(),settings:{} as Record<string,unknown>}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>Object.assign((key:string,params?:Record<string,string>)=>`${namespace}.${key}${params?JSON.stringify(params):''}`,{has:(key:string)=>key.startsWith('err_')&&key!=='err_unknown_code'})}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:owner.session}));
vi.mock('../core/assistant',()=>({askAssistant:owner.ask,AssistantError:class extends Error{constructor(readonly code:string){super(code);}}}));
vi.mock('../core/ai-workspace',()=>({loadAiWorkspace:owner.workspace}));
vi.mock('../components/assistant/exchange-reply',()=>({ExchangeReply:owner.reply}));
vi.mock('../core/read',()=>({allowedCompanies:async()=>[{id:'company-1'}]}));
vi.mock('../lib/scope',()=>({getScopeIds:async(ids:string[])=>ids}));
const DEFAULTS:Record<string,unknown>={'assistant.launcher_enabled':false,'assistant.launcher_position':'bottom-right','assistant.launcher_hidden_areas':''};
vi.mock('../core/entitlements',()=>({getSetting:(_ctx:unknown,key:string)=>{if(owner.settings.__broken)throw Error('PRIVATE snapshot');return key in owner.settings?owner.settings[key]:DEFAULTS[key];}}));
vi.mock('../core/assistant-grant',()=>({mayUseAssistant:owner.access}));
vi.mock('../core/ai-config',()=>({resolveActiveAiConfig:owner.provider}));
vi.mock('../db/client',()=>({withTenant:async(_ctx:unknown,work:(tx:unknown)=>unknown)=>work({})}));
vi.mock('../core/tenant-settings',()=>({setTenantSetting:owner.write}));
import {resolvePageContext,PAGE_AREAS} from '../lib/ai/page-context';
import {readLauncherSettings,assistantLauncherFor,setAssistantLauncher,LauncherSettingsError} from '../core/assistant-launcher';
import {askFromLauncherAction,askFromWorkspaceAction} from '../app/assistant/launcher-actions';
const ctx={tenantId:'fixture-tenant',userId:'fixture-user'};
const id='0b6f5e3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
beforeEach(()=>{for(const fn of [owner.session,owner.ask,owner.workspace,owner.reply,owner.access,owner.provider,owner.write])fn.mockReset();owner.settings={};owner.session.mockResolvedValue(ctx);owner.access.mockResolvedValue({allowed:true});owner.provider.mockResolvedValue({provider:'openrouter'});});

describe('page context is a closed area and at most one record id',()=>{
 it('maps paths to areas and takes the first uuid only',()=>{
  expect(resolvePageContext('/')).toEqual({area:'home',recordId:null});
  expect(resolvePageContext('/leave/history')).toEqual({area:'leave',recordId:null});
  expect(resolvePageContext(`/admin/personnel/${id.toUpperCase()}/edit`)).toEqual({area:'people',recordId:id});
  expect(resolvePageContext('/admin/payroll-cycle')).toEqual({area:'payroll',recordId:null});
  expect(resolvePageContext('/admin/audit')).toEqual({area:'settings',recordId:null});
  expect(resolvePageContext('/control-tower/agents')).toEqual({area:'controlTower',recordId:null});
 });
 it('knows nothing about the Assistant itself, unknown areas or anything that is not a plain in-app path',()=>{
  for(const path of ['/assistant','/assistant/leave','/unknown-area','//evil.example','https://evil.example/leave','/leave?q=secret','/leave#x','/leave\\x','/leave x',42,null,'/'+'a'.repeat(600)])expect(resolvePageContext(path),String(path)).toBeNull();
 });
});

describe('floating button settings fail closed',()=>{
 it('defaults to off, bottom right and nothing hidden; ignores unknown values',()=>{
  expect(readLauncherSettings(ctx as never)).toEqual({enabled:false,position:'bottom-right',hiddenAreas:[]});
  owner.settings={'assistant.launcher_enabled':true,'assistant.launcher_position':'top-middle','assistant.launcher_hidden_areas':'payroll, nonsense,payroll,people'};
  expect(readLauncherSettings(ctx as never)).toEqual({enabled:true,position:'bottom-right',hiddenAreas:['payroll','people']});
 });
 it('shows the button only when switched on, with Assistant access and an active provider; any failure hides it',async()=>{
  expect(await assistantLauncherFor(ctx as never)).toBeNull();expect(owner.access).not.toHaveBeenCalled();
  owner.settings={'assistant.launcher_enabled':true,'assistant.launcher_position':'bottom-left'};
  expect(await assistantLauncherFor(ctx as never)).toEqual({position:'bottom-left',hiddenAreas:[]});
  owner.access.mockResolvedValueOnce({allowed:false,reason:'no_grant'});expect(await assistantLauncherFor(ctx as never)).toBeNull();
  owner.provider.mockResolvedValueOnce(null);expect(await assistantLauncherFor(ctx as never)).toBeNull();
  owner.access.mockRejectedValueOnce(Error('PRIVATE'));expect(await assistantLauncherFor(ctx as never)).toBeNull();
  // An unreadable settings snapshot hides the button rather than failing open.
  owner.settings={__broken:true};expect(await assistantLauncherFor(ctx as never)).toBeNull();
 });
 it('writes all three settings together and refuses anything outside the closed values',async()=>{
  await setAssistantLauncher(ctx as never,{enabled:true,position:'bottom-left',hiddenAreas:['people','payroll']});
  expect(owner.write.mock.calls.map(call=>call[1])).toEqual([{key:'assistant.launcher_enabled',value:true},{key:'assistant.launcher_position',value:'bottom-left'},{key:'assistant.launcher_hidden_areas',value:'payroll,people'}]);
  for(const bad of [{enabled:'yes',position:'bottom-left',hiddenAreas:[]},{enabled:true,position:'top',hiddenAreas:[]},{enabled:true,position:'bottom-left',hiddenAreas:['payroll','x']},{enabled:true,position:'bottom-left',hiddenAreas:'payroll'},{enabled:true,position:'bottom-left',hiddenAreas:[...PAGE_AREAS,'home']}])
   await expect(setAssistantLauncher(ctx as never,bad)).rejects.toBeInstanceOf(LauncherSettingsError);
  expect(owner.write).toHaveBeenCalledTimes(3);
 });
});

describe('the floating chat command',()=>{
 it('passes only the server company context and paired opaque continuation to the shared command',async()=>{
  owner.ask.mockResolvedValue({exchangeId:'next',conversationToken:'new-proof'});owner.workspace.mockResolvedValue({history:[]});
  expect(await askFromWorkspaceAction({question:'And pending?',previousExchangeId:'prior',previousConversationToken:'proof'})).toEqual({ok:true,exchangeId:'next',conversationToken:'new-proof',answer:'assistant.workspace.conversation.unavailable'});
  expect(owner.ask).toHaveBeenCalledWith(ctx,{question:'And pending?',conversationScope:'["company-1"]',previousExchangeId:'prior',previousConversationToken:'proof'});
 });
 it('sends the question with the server-derived context through askAssistant and returns the canonical card',async()=>{
  owner.ask.mockResolvedValue({exchangeId:'exchange-1'});owner.workspace.mockResolvedValue({history:[{id:'exchange-1',grounded:{kind:'fixture'}}]});owner.reply.mockResolvedValue('CARD');
  const reply=await askFromLauncherAction({question:'  How much leave do I have?  ',path:`/leave/${id}`});
  expect(reply).toEqual({ok:true,exchangeId:'exchange-1',answer:'CARD'});
  const sent=owner.ask.mock.calls[0][1].question as string;
  expect(sent.startsWith('How much leave do I have?\n\n[')).toBe(true);expect(sent).toContain('assistant.launcher.areas.leave');expect(sent).toContain(id);
  expect(owner.ask.mock.calls[0][0]).toBe(ctx);expect(owner.workspace).toHaveBeenCalledWith(ctx,{selectedExchangeId:'exchange-1',includeGovernance:false});
 });
 it('adds no context where the path is not a known area, and never trusts a posted label',async()=>{
  owner.ask.mockResolvedValue({exchangeId:'exchange-2'});owner.workspace.mockResolvedValue({history:[]});
  const reply=await askFromLauncherAction({question:'Hello',path:'/assistant',label:'Payroll of the CEO'} as never);
  expect(owner.ask.mock.calls[0][1]).toEqual({question:'Hello',conversationScope:'["company-1"]'});expect(reply).toEqual({ok:true,exchangeId:'exchange-2',answer:'assistant.workspace.conversation.unavailable'});
 });
 it('refuses an empty or oversized question before any session or provider work',async()=>{
  for(const question of ['','   ',42,'x'.repeat(2001)])expect(await askFromLauncherAction({question,path:'/leave'})).toEqual({ok:false,message:'assistant.err_invalid_question'});
  expect(owner.session).not.toHaveBeenCalled();expect(owner.ask).not.toHaveBeenCalled();
 });
 it('maps refusals to the closed sentences and never echoes a raw error',async()=>{
  const {AssistantError}=await import('../core/assistant');
  owner.ask.mockRejectedValueOnce(new (AssistantError as unknown as new(code:string)=>Error)('budget_daily'));
  expect(await askFromLauncherAction({question:'Hi',path:'/leave'})).toEqual({ok:false,message:'assistant.err_budget_daily'});
  owner.ask.mockRejectedValueOnce(Error('PRIVATE provider key detail'));
  const failed=await askFromLauncherAction({question:'Hi',path:'/leave'});expect(failed).toEqual({ok:false,message:'assistant.err_provider_error'});
 });
});
