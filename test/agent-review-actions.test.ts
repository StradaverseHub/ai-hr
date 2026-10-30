/** Source command contracts with mocked session/owners. No provider, database or real session proof. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const boundary=vi.hoisted(()=>({session:vi.fn(),create:vi.fn(),evaluate:vi.fn(),promote:vi.fn(),rollback:vi.fn(),trial:vi.fn()}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:boundary.session}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(location:string)=>{throw Object.assign(Error('test redirect'),{location});}}));
vi.mock('../core/module-agent-releases',()=>({createPromptAgentCandidate:boundary.create,evaluatePromptAgentCandidate:boundary.evaluate,
 promotePromptAgentCandidate:boundary.promote,rollbackAssistantPromotion:boundary.rollback,runPromptPlannedSyntheticJob:boundary.trial}));
import {createAgentCandidateAction,evaluateAgentCandidateAction,promoteAgentCandidateAction,rollbackAgentCandidateAction,tryAgentCandidateAction} from '../app/assistant/agent-review-actions';
import {PROMPT_HOLDOUT_REQUEST_LIMIT} from '../lib/ai/module-agent-prompt-candidate';
const actions=[createAgentCandidateAction,evaluateAgentCandidateAction,promoteAgentCandidateAction,rollbackAgentCandidateAction,tryAgentCandidateAction];
const ctx={tenantId:'test-tenant',userId:'test-reviewer'};
beforeEach(()=>{for(const mock of Object.values(boundary))mock.mockReset();boundary.session.mockResolvedValue(ctx);});
function form(){const value=new FormData();for(const [key,text] of Object.entries({version:'2',variant:'explicit_scope_v1',candidateId:'candidate',promotionId:'promotion',maxJobs:'2',hours:'1',fixtureId:'own-leave',consented:'yes'}))value.set(key,text);return value;}
async function location(invoke:()=>Promise<unknown>){try{await invoke();throw Error('Expected redirect');}catch(error){const value=(error as {location?:unknown}).location;if(typeof value!=='string')throw error;return value;}}
describe('explicit synthetic evaluation browser commands',()=>{
 it('bounds session and owner failures without exposing raw auth/provider strings',async()=>{
  for(const action of actions){boundary.session.mockRejectedValueOnce(Error('PRIVATE_SESSION_TOKEN_OR_SQL'));expect(await location(()=>action(form()))).toBe('/control-tower/agents/assistant?error=agent_review');}
  for(const owner of [boundary.create,boundary.evaluate,boundary.promote,boundary.rollback,boundary.trial])expect(owner).not.toHaveBeenCalled();
  for(const owner of [boundary.create,boundary.evaluate,boundary.promote,boundary.rollback,boundary.trial])owner.mockRejectedValueOnce(Error('PRIVATE_PROVIDER_KEY_OR_SQL'));
  for(const action of actions)expect(await location(()=>action(form()))).toBe('/control-tower/agents/assistant?error=agent_review');
 });
 it('requires explicit consent before synthetic admission and sends only the fixed bounded count',async()=>{
  const missing=form();missing.delete('consented');expect(await location(()=>evaluateAgentCandidateAction(missing))).toBe('/control-tower/agents/assistant?error=agent_review');
  expect(await location(()=>tryAgentCandidateAction(missing))).toBe('/control-tower/agents/assistant?error=agent_review');expect(boundary.session).not.toHaveBeenCalled();
  expect(await location(()=>evaluateAgentCandidateAction(form()))).toBe('/control-tower/agents/assistant');
  expect(boundary.evaluate).toHaveBeenCalledWith(ctx,{candidateId:'candidate',consent:expect.objectContaining({synthetic:true,maxRequests:PROMPT_HOLDOUT_REQUEST_LIMIT})});
  expect(await location(()=>tryAgentCandidateAction(form()))).toBe('/control-tower/agents/assistant');
  expect(boundary.trial).toHaveBeenCalledWith(ctx,{fixtureId:'own-leave',consent:expect.objectContaining({synthetic:true,maxRequests:1})});
 });
 it('captures explicitly selected own signal IDs before session authentication',async()=>{
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(yes=>{entered=yes;}),resume=new Promise<void>(yes=>{release=yes;});
  boundary.session.mockImplementationOnce(async()=>{entered();await resume;return ctx;});const input=form();input.append('signalId','original');const pending=location(()=>createAgentCandidateAction(input));
  await ready;input.set('signalId','retargeted');release();expect(await pending).toBe('/control-tower/agents/assistant');
  expect(boundary.create).toHaveBeenCalledWith(ctx,{version:2,configuration:{kind:'read_plan_prompt_v1',variant:'explicit_scope_v1'},signalIds:['original']});
 });
 it('captures selection and limits before the authenticated session await',async()=>{
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(yes=>{entered=yes;}),resume=new Promise<void>(yes=>{release=yes;});
  boundary.session.mockImplementationOnce(async()=>{entered();await resume;return ctx;});const input=form(),pending=location(()=>promoteAgentCandidateAction(input));
  await ready;input.set('candidateId','retargeted');input.set('hours','24');input.set('maxJobs','100');release();expect(await pending).toBe('/control-tower/agents/assistant');
  expect(boundary.promote).toHaveBeenCalledWith(ctx,{candidateId:'candidate',maxJobs:2,hours:1});
 });
});
