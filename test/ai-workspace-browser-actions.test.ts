/** Authored UNRUN. Real selected-cookie session resolver; workspace/control owners are spies.
 * Neither DEV_USER_ID fallback nor raw authentication/provider faults may become a browser command.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined}));
const owners=vi.hoisted(()=>({ask:vi.fn(),feature:vi.fn(),allowance:vi.fn(),permission:vi.fn(),clear:vi.fn()}));
const errors=vi.hoisted(()=>({AssistantError:class extends Error {constructor(readonly code:string){super('fixture owned assistant code');}},AiControlError:class extends Error{}}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:vi.fn((location:string)=>{throw Object.assign(Error('fixture redirect'),{location});})}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>((key:string)=>namespace+'.'+key)}));
vi.mock('../core/assistant',()=>({AssistantError:errors.AssistantError,askAssistant:owners.ask}));
vi.mock('../core/ai-management',()=>({AiControlError:errors.AiControlError,setAiFeature:owners.feature,setAiAllowance:owners.allowance,setAssistantPermission:owners.permission,clearUserAllowance:owners.clear,parseAiAllowance:(value:string)=>value===''?null:Number(value)}));
import { getSession } from '../lib/session';
import { askAssistantAction } from '../app/(app)/assistant/actions';
import { clearUserAllowanceAction, setAiAllowanceAction, setAiFeatureAction, setAssistantPermissionAction } from '../app/(app)/control-tower/agents/actions';
import { closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
let base:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{
  vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NODE_ENV','test');vi.stubEnv('ALLOW_DEMO_SESSION','false');
  await resetDb();base=await seedBase();vi.stubEnv('DEV_USER_ID',base.adminUserId);browser.selected=undefined;
  for(const spy of Object.values(owners))spy.mockReset();
  owners.ask.mockResolvedValue({exchangeId:'fixture-exchange'});
});
afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
function form(){const f=new FormData();for(const [key,value] of Object.entries({question:'Synthetic browser boundary question',feature:'hr_assistant',enabled:'true',kind:'company',subjectId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',dailyRequests:'10',monthlyTokens:'1000',q:'fictional search'}))f.set(key,value);return f;}
async function locationOf(invoke:()=>Promise<unknown>):Promise<string>{try{await invoke();throw Error('Expected redirect');}catch(error){const location=(error as {location?:unknown}).location;if(typeof location!=='string')throw error;return location;}}
const controls=[setAiFeatureAction,setAiAllowanceAction,setAssistantPermissionAction,clearUserAllowanceAction];
describe('workspace browser command authentication',()=>{
  it.each(['absent','unknown'] as const)('refuses %s selected cookie with bounded existing redirects and no owner calls',async mode=>{
    if(mode==='absent')expect((await getSession()).userId).toBe(base.adminUserId);else browser.selected=randomUUID();
    expect(await locationOf(()=>askAssistantAction(form()))).toBe('/assistant?error=ai_control');
    // Each refusal returns to the AI management sub-menu page that owns the control.
    const pages=new Map<unknown,string>([[setAiFeatureAction,'/control-tower/agents/features'],[setAiAllowanceAction,'/control-tower/agents/allowances'],[setAssistantPermissionAction,'/control-tower/agents/allowances'],[clearUserAllowanceAction,'/control-tower/agents/allowances']]);
    for(const action of controls){
      const location=await locationOf(()=>action(form())),target=new URL(location,'https://fixture.test');
      expect(target.pathname).toBe(pages.get(action));expect(target.searchParams.get('error')).toBe('assistant.denied_no_user');
      expect(location).not.toContain('selected%20browser');expect(location).not.toContain(base.adminUserId);
      if(action!==setAiFeatureAction)expect(target.searchParams.get('q')).toBe('fictional search');
    }
    for(const spy of Object.values(owners))expect(spy).not.toHaveBeenCalled();
  });
  it('uses the actual explicitly selected actor for the provider ask and every control mutation',async()=>{
    browser.selected=base.adminUserId;
    expect(await locationOf(()=>askAssistantAction(form()))).toBe('/assistant?e=fixture-exchange');
    for(const action of controls){const location=await locationOf(()=>action(form()));expect(new URL(location,'https://fixture.test').searchParams.has('toast')).toBe(true);}
    for(const spy of Object.values(owners)){expect(spy).toHaveBeenCalledTimes(1);expect(spy.mock.calls[0][0]).toMatchObject({tenantId:base.tenantId,userId:base.adminUserId});}
  });
  it('keeps unknown provider/auth/internal text out of assistant and management redirects',async()=>{
    browser.selected=base.adminUserId;
    const raw='private-provider-debug SECRET raw SQL details';
    owners.ask.mockRejectedValueOnce(Error(raw));
    expect(await locationOf(()=>askAssistantAction(form()))).toBe('/assistant?error=provider_error');
    for(const spy of [owners.feature,owners.allowance,owners.permission,owners.clear])spy.mockRejectedValueOnce(Error(raw));
    for(const action of controls){const target=new URL(await locationOf(()=>action(form())),'https://fixture.test');expect(target.searchParams.get('error')).toBe('assistant.err_provider_error');expect(target.href).not.toContain('SECRET');}
  });
  it('preserves closed assistant codes and owned control validation sentences',async()=>{
    browser.selected=base.adminUserId;
    owners.ask.mockRejectedValueOnce(new errors.AssistantError('budget_daily'));
    expect(await locationOf(()=>askAssistantAction(form()))).toBe('/assistant?error=budget_daily');
    owners.feature.mockRejectedValueOnce(new errors.AiControlError('Owned validation sentence'));
    const location=await locationOf(()=>setAiFeatureAction(form()));expect(new URL(location,'https://fixture.test').searchParams.get('error')).toBe('Owned validation sentence');
  });
});
