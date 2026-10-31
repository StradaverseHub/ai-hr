/** Walkthrough 28 October 2026: every save on /control-tower/agents returned the admin to the top of a very
 * long page. A successful save now returns to the saved row on its own sub-menu page with a closed
 * toast code; a refusal stays at the top of that page beside the error banner. Owners are spies; no database
 * is touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const owners=vi.hoisted(()=>({feature:vi.fn(),allowance:vi.fn(),permission:vi.fn(),clear:vi.fn(),spend:vi.fn()}));
const errors=vi.hoisted(()=>({AiControlError:class extends Error{}}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:vi.fn((location:string)=>{throw Object.assign(Error('fixture redirect'),{location});})}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>((key:string)=>namespace+'.'+key)}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:async()=>({tenantId:'fixture-tenant',userId:'fixture-user'})}));
vi.mock('../core/ai-spend-management',()=>({setAiSpendBudget:owners.spend}));
vi.mock('../core/ai-management',()=>({AiControlError:errors.AiControlError,setAiFeature:owners.feature,setAiAllowance:owners.allowance,setAssistantPermission:owners.permission,clearUserAllowance:owners.clear,parseAiAllowance:(value:string)=>value===''?null:Number(value)}));
import { clearUserAllowanceAction, setAiAllowanceAction, setAiFeatureAction, setAiSpendBudgetAction, setAssistantPermissionAction } from '../app/(app)/control-tower/agents/actions';

const COMPANY='11111111-1111-4111-8111-111111111111',USER='22222222-2222-4222-8222-222222222222';
function form(values:Record<string,string>){const f=new FormData();for(const [k,v] of Object.entries({q:'fictional search',enabled:'true',dailyRequests:'10',monthlyTokens:'',maxConcurrent:'',...values}))f.set(k,v);return f;}
async function target(invoke:()=>Promise<unknown>):Promise<URL>{try{await invoke();throw Error('Expected redirect');}catch(error){const location=(error as {location?:unknown}).location;if(typeof location!=='string')throw error;return new URL(location,'https://fixture.test');}}
beforeEach(()=>{for(const spy of Object.values(owners))spy.mockReset();});

describe('AI management saves return to the saved form',()=>{
  it('anchors each successful save on its own row or section and keeps the toast',async()=>{
    const cases:[()=>Promise<unknown>,string,string,string][]=[
      [()=>setAiAllowanceAction(form({kind:'company',subjectId:COMPANY})),`#ai-company-${COMPANY}`,'allowances','saved'],
      [()=>setAiAllowanceAction(form({kind:'user',subjectId:USER})),`#ai-user-${USER}`,'allowances','saved'],
      [()=>setAiAllowanceAction(form({kind:'user_default'})),'#ai-user-default','allowances','saved'],
      [()=>setAssistantPermissionAction(form({userId:USER})),`#ai-user-${USER}`,'allowances','saved'],
      [()=>clearUserAllowanceAction(form({userId:USER})),`#ai-user-${USER}`,'allowances','default'],
      [()=>setAiFeatureAction(form({feature:'hr_assistant'})),'#ai-feature-hr_assistant','features','saved'],
      [()=>setAiSpendBudgetAction(form({monthlyUsd:'5',rootUsd:''})),'#ai-spend','spending','saved'],
    ];
    for(const [invoke,hash,view,toast] of cases){
      const url=await target(invoke);
      expect(url.pathname).toBe(`/control-tower/agents/${view}`);expect(url.hash).toBe(hash);
      expect(url.searchParams.get('toast')).toBe(toast);
    }
    // The user search survives a save on the users tab.
    expect((await target(()=>setAiAllowanceAction(form({kind:'user',subjectId:USER})))).searchParams.get('q')).toBe('fictional search');
  });
  it('never puts an unexpected identifier into the fragment; it falls back to the section',async()=>{
    expect((await target(()=>setAiAllowanceAction(form({kind:'company',subjectId:'"><script>'})))).hash).toBe('#company-limits');
    expect((await target(()=>setAssistantPermissionAction(form({userId:'not-an-id'})))).hash).toBe('#user-limits');
  });
  it('keeps refusals at the top, beside the error banner',async()=>{
    owners.allowance.mockRejectedValueOnce(new errors.AiControlError('Owned validation sentence'));
    const url=await target(()=>setAiAllowanceAction(form({kind:'company',subjectId:COMPANY})));
    expect(url.searchParams.get('error')).toBe('Owned validation sentence');expect(url.hash).toBe('');expect(url.pathname).toBe('/control-tower/agents/allowances');
    owners.spend.mockRejectedValueOnce(new errors.AiControlError('Owned spend sentence'));
    const spend=await target(()=>setAiSpendBudgetAction(form({monthlyUsd:'x',rootUsd:''})));
    expect(spend.searchParams.get('error')).toBe('Owned spend sentence');expect(spend.hash).toBe('');expect(spend.pathname).toBe('/control-tower/agents/spending');
  });
});
