/** AI centre › Workers: setAiFeatureAction's closed branch for the two registry-controlled worker switches.
 * Every other input keeps the existing AI-feature behaviour exactly. Owners are spies; no database is touched;
 * the service's own checks are covered by test/ai-centre-worker-switch.test.ts. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const owners=vi.hoisted(()=>({feature:vi.fn(),worker:vi.fn(),session:vi.fn()}));
const errors=vi.hoisted(()=>({AiControlError:class extends Error{},WorkerControlRefused:class extends Error{constructor(readonly reason:string){super('refused '+reason);}}}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:vi.fn((location:string)=>{throw Object.assign(Error('fixture redirect'),{location});})}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>((key:string)=>namespace+'.'+key)}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:owners.session}));
vi.mock('../core/ai-management',()=>({AiControlError:errors.AiControlError,setAiFeature:owners.feature,setAiAllowance:vi.fn(),setAssistantPermission:vi.fn(),clearUserAllowance:vi.fn(),parseAiAllowance:vi.fn()}));
vi.mock('../core/agent-registry/controls',()=>({setWorkerSwitch:owners.worker,WorkerControlRefused:errors.WorkerControlRefused}));
import { setAiFeatureAction } from '../app/control-tower/agents/actions';

const COMPANY='11111111-1111-4111-8111-111111111111';
const session=(role:string,companyId:string|null=null)=>({tenantId:'fixture-tenant',userId:'fixture-user',roles:[role],grants:[{role,companyId}]});
const GROUP=session('hr_admin');
function form(values:Record<string,string>){const f=new FormData();for(const [k,v] of Object.entries(values))f.set(k,v);return f;}
async function target(invoke:()=>Promise<unknown>):Promise<URL>{try{await invoke();throw Error('Expected redirect');}catch(error){const location=(error as {location?:unknown}).location;if(typeof location!=='string')throw error;return new URL(location,'https://fixture.test');}}
beforeEach(()=>{for(const spy of Object.values(owners))spy.mockReset();owners.session.mockResolvedValue(GROUP);});

describe('existing AI-feature switches',()=>{
  it('behave exactly as before when no worker is posted',async()=>{
    for(const enabled of ['true','false']){
      owners.feature.mockReset();
      const url=await target(()=>setAiFeatureAction(form({feature:'hr_assistant',enabled})));
      expect(owners.feature).toHaveBeenCalledExactlyOnceWith(GROUP,'hr_assistant',enabled==='true');
      expect(url.pathname).toBe('/control-tower/agents/features');expect(url.hash).toBe('#ai-feature-hr_assistant');expect(url.searchParams.get('toast')).toBe('saved');
    }
    // A company-scoped administrator still reaches the feature service, which keeps its own checks.
    owners.feature.mockReset();owners.session.mockResolvedValue(session('hr_admin',COMPANY));
    await target(()=>setAiFeatureAction(form({feature:'hr_assistant',enabled:'true'})));
    expect(owners.feature).toHaveBeenCalledOnce();
    const invalid=await target(()=>setAiFeatureAction(form({feature:'not_a_feature',enabled:'true'})));
    expect(invalid.searchParams.get('error')).toBe('aiManagement.invalid');
    expect(owners.worker).not.toHaveBeenCalled();
  });
});

describe('registry worker switches',()=>{
  it.each(['approver_recommendation','explainers'])('let a group administrator switch %s through the service',async worker=>{
    const url=await target(()=>setAiFeatureAction(form({worker,enabled:'true'})));
    expect(owners.worker).toHaveBeenCalledExactlyOnceWith(GROUP,{workerId:worker,enabled:true});
    expect(owners.feature).not.toHaveBeenCalled();
    expect(url.pathname).toBe('/control-tower/agents/features');expect(url.hash).toBe(`#worker-${worker}`);expect(url.searchParams.get('toast')).toBe('saved');
  });
  it('refuses a company-scoped HR administrator, a manager and an employee before the service',async()=>{
    for(const who of [session('hr_admin',COMPANY),session('manager'),session('employee'),{...GROUP,agent:{principalId:'fixture'}}]){
      owners.session.mockResolvedValue(who);
      const url=await target(()=>setAiFeatureAction(form({worker:'explainers',enabled:'true'})));
      expect(url.searchParams.get('error')).toBe('aiCentre.registry.switchRefused');
    }
    expect(owners.worker).not.toHaveBeenCalled();
  });
  it('refuses an unknown worker or value before reading the session, and never falls through to a feature',async()=>{
    for(const values of <Record<string,string>[]>[{worker:'invented',enabled:'true'},{worker:'approval_chasers',enabled:'true'},{worker:'daily_digest',enabled:'false'},{worker:'',enabled:'true'},
      {worker:'explainers',enabled:'yes'},{worker:'explainers',feature:'hr_assistant'}]){
      const url=await target(()=>setAiFeatureAction(form(values)));
      expect(url.searchParams.get('error'),JSON.stringify(values)).toBe('aiCentre.registry.switchInvalid');
    }
    expect(owners.session).not.toHaveBeenCalled();expect(owners.worker).not.toHaveBeenCalled();expect(owners.feature).not.toHaveBeenCalled();
  });
  it('translates the service refusals, including a module that is not enabled',async()=>{
    owners.worker.mockRejectedValueOnce(new errors.WorkerControlRefused('module_not_enabled'));
    expect((await target(()=>setAiFeatureAction(form({worker:'explainers',enabled:'true'})))).searchParams.get('error')).toBe('aiCentre.registry.switchModuleOff');
    owners.worker.mockRejectedValueOnce(new errors.WorkerControlRefused('not_administrator'));
    expect((await target(()=>setAiFeatureAction(form({worker:'explainers',enabled:'true'})))).searchParams.get('error')).toBe('aiCentre.registry.switchRefused');
  });
});
