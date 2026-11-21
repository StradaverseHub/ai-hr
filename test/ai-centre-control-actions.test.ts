import {beforeEach,describe,expect,it,vi} from 'vitest';
const owners=vi.hoisted(()=>({session:vi.fn(),stop:vi.fn(),function:vi.fn(),job:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(location:string)=>{throw Object.assign(Error('fixture redirect'),{location});}}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>key)}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:owners.session}));
vi.mock('../core/mandates/mandates',()=>({setMandateStopSwitch:owners.stop,setJobTypeEnablement:owners.job}));
vi.mock('../core/ai-centre-inventory',()=>({setAiCentreReadControl:owners.function}));
import {setAiCentreStopAction,setAiCentreFunctionAction,setAiCentreJobAction} from '../app/control-tower/agents/centre-control-actions';
const group={tenantId:'fixture',userId:'fixture-user',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
const form=(values:Record<string,string>)=>{const result=new FormData();for(const [key,value] of Object.entries(values))result.set(key,value);return result;};
async function location(action:()=>Promise<unknown>){try{await action();throw Error('Expected redirect');}catch(error){if(typeof(error as {location?:unknown}).location!=='string')throw error;return String((error as {location:string}).location);}}
beforeEach(()=>{Object.values(owners).forEach(spy=>spy.mockReset());owners.session.mockResolvedValue(group);});
describe('AI centre control commands',()=>{
 it('binds stop and resume to the reviewed generation',async()=>{
  expect(await location(()=>setAiCentreStopAction(form({stopped:'true',generation:'7'})))).toContain('toast=saved');
  expect(owners.stop).toHaveBeenCalledWith(group,true,{expectedGeneration:7,reason:'Administrator stopped AI Centre'});
  await location(()=>setAiCentreStopAction(form({stopped:'false',generation:'8'})));
  expect(owners.stop).toHaveBeenLastCalledWith(group,false,{expectedGeneration:8,reason:'Administrator resumed AI Centre'});
 });
 it.each(['-1','NaN','1.5','9007199254740992',''])('refuses invalid generation %s',async generation=>{
  expect(await location(()=>setAiCentreStopAction(form({stopped:'false',generation})))).toContain('error=saveFailed');
  expect(owners.stop).not.toHaveBeenCalled();
 });
 it('does not retry a rejected stale resume or expose its internal error',async()=>{
  owners.stop.mockRejectedValue(Error('private SQL fixture detail'));
  expect(await location(()=>setAiCentreStopAction(form({stopped:'false',generation:'1'})))).toBe('/control-tower/agents/features?error=saveFailed');
  expect(owners.stop).toHaveBeenCalledOnce();
 });
 it('passes one child control and preserves the recurring-job ceilings',async()=>{
  await location(()=>setAiCentreFunctionAction(form({function:'read:explain_pay_difference',enabled:'false'})));
  expect(owners.function).toHaveBeenCalledWith(group,'read:explain_pay_difference',false);
  await location(()=>setAiCentreJobAction(form({jobType:'daily_digest',enabled:'true',maxValidityDays:'30',maxRunsPerDay:'1'})));
  expect(owners.job).toHaveBeenCalledWith(group,{jobType:'daily_digest',enabled:true,maxValidityDays:30,maxRunsPerDay:1});
 });
 it('refuses company HR, employees and agent contexts at every browser command',async()=>{
  for(const session of [{...group,grants:[{role:'hr_admin',companyId:'fixture-company'}]}, {...group,roles:['employee'],grants:[{role:'employee',companyId:null}]},{...group,agent:{principalId:'fixture-agent'}}]){
   owners.session.mockResolvedValue(session);
   for(const action of [()=>setAiCentreStopAction(form({stopped:'true',generation:'0'})),()=>setAiCentreFunctionAction(form({function:'read:explain_pay_difference',enabled:'false'})),()=>setAiCentreJobAction(form({jobType:'daily_digest',enabled:'false',maxValidityDays:'90',maxRunsPerDay:'1'}))])expect(await location(action)).toContain('error=saveFailed');
  }
  expect(owners.stop).not.toHaveBeenCalled();expect(owners.function).not.toHaveBeenCalled();expect(owners.job).not.toHaveBeenCalled();
 });
});
