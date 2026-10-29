/** Authored UNRUN. Closed Server Action forwarding only; mocked owners do not prove native authority. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({session:vi.fn(),create:vi.fn(),evaluate:vi.fn(),promote:vi.fn(),rollback:vi.fn(),run:vi.fn(),redirect:vi.fn(),refresh:vi.fn(),notification:vi.fn()}));
vi.mock('../core/assistant-actions/own-notification-preferences-source',()=>({resolveOwnNotificationServerIdentity:state.notification}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:state.session}));
vi.mock('next/navigation',()=>({redirect:state.redirect}));
vi.mock('next/cache',()=>({revalidatePath:state.refresh}));
vi.mock('../core/module-agent-releases',()=>({createCanonicalSpecialistCandidate:state.create,evaluateCanonicalSpecialistCandidate:state.evaluate,promoteCanonicalSpecialistCandidate:state.promote,rollbackAssistantPromotion:state.rollback,runGovernedSpecialistJob:state.run}));
import {createSpecialistCandidateAction,evaluateSpecialistCandidateAction,promoteSpecialistCandidateAction,rollbackSpecialistCandidateAction,runSpecialistJobAction} from '../app/assistant/specialist-review-actions';
const ctx={tenantId:'actual-session-tenant',userId:'actual-session-user'};
const form=(values:Record<string,string|string[]>)=>{const f=new FormData();for(const[key,value]of Object.entries(values))for(const v of Array.isArray(value)?value:[value])f.append(key,v);return f;};
beforeEach(()=>{vi.resetAllMocks();state.session.mockResolvedValue(ctx);state.redirect.mockImplementation((path:string)=>{throw Error('FRAMEWORK_REDIRECT '+path);});state.run.mockResolvedValue({jobId:'owned-job'});});
describe('specialist human actions forward no posted authority or success evidence',()=>{
 it('captures a closed candidate selection and explicit feedback IDs with the authenticated session',async()=>{
  await expect(createSpecialistCandidateAction(form({moduleVersion:'leave:3',signalId:['chosen-own-signal'],userId:'FOREIGN',tenantId:'FOREIGN',roles:'super_admin',qualityScore:'1'}))).rejects.toThrow('FRAMEWORK_REDIRECT /control-tower/agents/assistant');
  expect(state.create).toHaveBeenCalledExactlyOnceWith(ctx,{module:'leave',version:3,signalIds:['chosen-own-signal'],playbook:'canonical_domain_v1'});
 });
 it.each(['foreign:1','leave:0','leave:NaN','leave:2:effect'])('refuses unsupported selection %s before authentication or an owner call',async choice=>{
  await expect(createSpecialistCandidateAction(form({moduleVersion:choice}))).rejects.toThrow('/control-tower/agents/assistant?error=agent_review');expect(state.session).not.toHaveBeenCalled();expect(state.create).not.toHaveBeenCalled();
 });
 it('requires deliberate evaluation consent and never accepts a posted pass count or model rating',async()=>{
  await expect(evaluateSpecialistCandidateAction(form({candidateId:'nominated',passed:'true'}))).rejects.toThrow('/control-tower/agents/assistant?error=agent_review');expect(state.evaluate).not.toHaveBeenCalled();
  await expect(evaluateSpecialistCandidateAction(form({candidateId:'nominated',consented:'yes',securityFailures:'0',qualityScore:'1'}))).rejects.toThrow('FRAMEWORK_REDIRECT /control-tower/agents/assistant');expect(state.evaluate).toHaveBeenCalledExactlyOnceWith(ctx,'nominated');
 });
 it('leaves finite promotion validation and independent evaluation evidence with the canonical owner',async()=>{
  await expect(promoteSpecialistCandidateAction(form({candidateId:'nominated',maxJobs:'5',hours:'1',evaluators:'invented',sourceDigest:'invented'}))).rejects.toThrow('FRAMEWORK_REDIRECT /control-tower/agents/assistant');expect(state.promote).toHaveBeenCalledExactlyOnceWith(ctx,{candidateId:'nominated',maxJobs:5,hours:1});
 });
 it('forwards only the approver scope choice (WP11) and refuses an unknown scope before authentication',async()=>{
  await expect(promoteSpecialistCandidateAction(form({candidateId:'nominated',maxJobs:'5',hours:'1',scope:'tenant',companyId:'IGNORED'}))).rejects.toThrow('FRAMEWORK_REDIRECT /control-tower/agents/assistant');expect(state.promote).toHaveBeenLastCalledWith(ctx,{candidateId:'nominated',maxJobs:5,hours:1,scope:'tenant'});
  await expect(promoteSpecialistCandidateAction(form({candidateId:'nominated',maxJobs:'5',hours:'1',scope:'company',companyId:'chosen-company'}))).rejects.toThrow('FRAMEWORK_REDIRECT /control-tower/agents/assistant');expect(state.promote).toHaveBeenLastCalledWith(ctx,{candidateId:'nominated',maxJobs:5,hours:1,scope:'company',companyId:'chosen-company'});
  state.session.mockClear();state.promote.mockClear();
  await expect(promoteSpecialistCandidateAction(form({candidateId:'nominated',maxJobs:'5',hours:'1',scope:'group'}))).rejects.toThrow('/control-tower/agents/assistant?error=agent_review');expect(state.session).not.toHaveBeenCalled();expect(state.promote).not.toHaveBeenCalled();
 });
 it('keeps source and employee choices out of the specialist read command',async()=>{
  await expect(runSpecialistJobAction(form({module:'payroll',commandNonce:'retained-command',employmentId:'FOREIGN',companyId:'FOREIGN',execute:'pay'}))).rejects.toThrow('FRAMEWORK_REDIRECT /assistant?governed=owned-job');expect(state.run).toHaveBeenCalledExactlyOnceWith(ctx,{module:'payroll'},{nonce:'retained-command'});
 });
 it('keeps rollback human-owned and turns raw owner errors into a bounded existing response',async()=>{
  state.rollback.mockRejectedValueOnce(Error('PRIVATE SQL OR PROVIDER BODY'));
  await expect(rollbackSpecialistCandidateAction(form({promotionId:'nominated',reason:'grant privileges'}))).rejects.toThrow('FRAMEWORK_REDIRECT /control-tower/agents/assistant?error=agent_review');expect(state.rollback).toHaveBeenCalledExactlyOnceWith(ctx,{promotionId:'nominated',reason:'human'});expect(state.redirect).not.toHaveBeenCalledWith(expect.stringContaining('PRIVATE'));
 });
 it('forwards only the explicit closed diagnostic strategy while the canonical owner validates its versioned meaning',async()=>{
  await expect(createSpecialistCandidateAction(form({moduleVersion:'claims:4',playbook:'canonical_followup_v1',qualityFailures:'0'}))).rejects.toThrow('FRAMEWORK_REDIRECT /control-tower/agents/assistant');expect(state.create).toHaveBeenCalledExactlyOnceWith(ctx,{module:'claims',version:4,signalIds:[],playbook:'canonical_followup_v1'});
 });

});

// Authored UNRUN: private IDs only nominate; posted receipt/identity/rating never reaches the owner.
it('snapshots an optional native evidence choice before authentication and keeps opaque identity server-only',async()=>{
 const f=form({moduleVersion:'notifications:5',nativeSignalId:'own-native-association',notificationIdentity:'posted',quality:'pass',playbook:'canonical_followup_v1'});
 state.session.mockImplementationOnce(async()=>{f.set('nativeSignalId','retargeted');f.set('playbook','arbitrary');return ctx;});state.notification.mockResolvedValueOnce({opaque:'actual-server-capability'});
 await expect(createSpecialistCandidateAction(f)).rejects.toThrow('FRAMEWORK_REDIRECT /control-tower/agents/assistant');
 expect(state.create).toHaveBeenCalledExactlyOnceWith(ctx,{module:'notifications',version:5,signalIds:[],nativeSignalIds:['own-native-association'],playbook:'canonical_followup_v1'},{notificationIdentity:{opaque:'actual-server-capability'}});
});
