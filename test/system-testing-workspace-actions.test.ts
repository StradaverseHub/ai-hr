import { beforeEach,describe,expect,it,vi } from 'vitest';
import { TestingRefusal } from '../lib/system-testing/model';
import { testingInstructionDraftFrom } from '../lib/system-testing/editor-model';
const m=vi.hoisted(()=>({session:vi.fn(),save:vi.fn(),publish:vi.fn(),observe:vi.fn(),assign:vi.fn(),confirm:vi.fn(),retest:vi.fn(),begin:vi.fn(),raise:vi.fn(),legacyRaise:vi.fn(),refresh:vi.fn(),board:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:m.refresh}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error('REDIRECT '+path);}}));
vi.mock('../lib/session',()=>({getSession:m.session}));
vi.mock('../core/entitlements',()=>({ModuleNotEnabledError:class ModuleNotEnabledError extends Error{}}));
vi.mock('../app/feedback/board',()=>({feedbackBoardOpen:m.board}));
vi.mock('../core/system-testing',()=>({SystemTestingError:class SystemTestingError extends Error{},assignTestingCase:m.assign,beginTestingExecution:m.begin,confirmTestingCatalogue:m.confirm,publishTestInstruction:m.publish,raiseTestingExecutionFeedback:m.raise,raiseRunAsFeedback:m.legacyRaise,requestTestingRetest:m.retest,saveTestInstructionDraft:m.save,saveTestingExecution:m.observe}));
import { raiseLegacyTestingFeedbackAction,raiseTestingFeedbackAction,requestTestingRetestAction,saveTestingInstructionAction,saveTestingObservationAction } from '../app/admin/system-testing/workspace-actions';
const caseId='47335504-b4ad-401b-8d10-59499482ee22',versionId='0a576e11-b48e-4b89-94f3-b8430ccf426b';
const session={tenantId:caseId,userId:versionId,roles:['hr_admin']};
beforeEach(()=>{vi.clearAllMocks();m.session.mockResolvedValue(session);m.save.mockResolvedValue({caseId,revision:4,caseNo:7});m.publish.mockResolvedValue({caseId,versionId,ordinal:1,draftRevision:5});m.observe.mockResolvedValue({runId:caseId,revision:4});m.board.mockReturnValue(true);m.raise.mockResolvedValue({feedbackId:versionId});m.legacyRaise.mockResolvedValue({feedbackId:versionId});});
function authored() {const f=new FormData();f.set('intent','publish');f.set('caseId','');f.set('versionId','');f.set('draftRevision','0');f.set('definition',JSON.stringify(testingInstructionDraftFrom(null)));return f;}
describe('testing server action provenance and failure contracts',()=>{
  it('retains the actually saved draft pointer when publication validation refuses, without pretending to publish',async()=>{
    m.publish.mockRejectedValue(new TestingRefusal('invalid'));
    expect(await saveTestingInstructionAction({error:null},authored())).toEqual({error:'invalid',savedDraft:{caseId,revision:4,versionId:null}});
    expect(m.publish).toHaveBeenCalledWith(session,{caseId,expectedDraftRevision:4,expectedVersionId:null});expect(m.refresh).not.toHaveBeenCalled();
  });
  it('takes tester identity only from the actual server session and passes exact observation/version/revision',async()=>{
    const f=new FormData();for(const [k,v]of Object.entries({executionId:caseId,assignmentId:caseId,versionId,revision:'3',status:'passed',actualResult:'Fictional observed result',comments:'',defectNotes:'',improvementNotes:'',testerUserId:'caller-forgery',tenantId:'caller-tenant'}))f.set(k,v);
    expect(await saveTestingObservationAction({error:null},f)).toEqual({error:null,savedObservation:{executionId:caseId,revision:4}});
    expect(m.observe).toHaveBeenCalledWith(session,{executionId:caseId,assignmentId:caseId,versionId,expectedRevision:3,status:'passed',actualResult:'Fictional observed result',comments:'',defectNotes:'',improvementNotes:''});
  });
  it('refuses invalid intent before a write, keeps typed stale refusals, and propagates unknown SQL errors',async()=>{
    const f=authored();f.set('intent','unrecognized');expect(await saveTestingInstructionAction({error:null},f)).toEqual({error:'invalid'});expect(m.save).not.toHaveBeenCalled();
    m.save.mockRejectedValue(new TestingRefusal('stale_execution'));expect(await saveTestingInstructionAction({error:null},authored())).toEqual({error:'stale_execution'});
    const unknown=new Error('private database details');m.save.mockRejectedValue(unknown);await expect(saveTestingInstructionAction({error:null},authored())).rejects.toBe(unknown);
  });
  it('raises onto the Feedback board only while the operator switch (0696) leaves it open',async()=>{
    const execution=()=>{const f=new FormData();f.set('executionId',caseId);f.set('revision','2');f.set('kind','defect');return f;};
    const legacy=()=>{const f=new FormData();f.set('runId',caseId);return f;};
    m.board.mockReturnValue(false);
    expect(await raiseTestingFeedbackAction({error:null},execution())).toEqual({error:'feedback_unavailable'});
    expect(await raiseLegacyTestingFeedbackAction({error:null},legacy())).toEqual({error:'feedback_unavailable'});
    expect(m.board).toHaveBeenCalledWith(session);expect(m.raise).not.toHaveBeenCalled();expect(m.legacyRaise).not.toHaveBeenCalled();expect(m.refresh).not.toHaveBeenCalled();
    m.board.mockReturnValue(true);
    await expect(raiseTestingFeedbackAction({error:null},execution())).rejects.toThrow(`REDIRECT /feedback/${versionId}`);
    await expect(raiseLegacyTestingFeedbackAction({error:null},legacy())).rejects.toThrow(`REDIRECT /feedback/${versionId}`);
    expect(m.raise).toHaveBeenCalledWith(session,{executionId:caseId,expectedRevision:2,kind:'defect'});
    expect(m.legacyRaise).toHaveBeenCalledWith(session,{runId:caseId,reporterEmploymentId:null});
  });
  it('refuses a retest from an already-open form when Feedback is switched off, and permits it when reopened',async()=>{
    const f=new FormData();
    for(const [key,value] of Object.entries({assignmentId:caseId,assignmentRevision:'2',versionId,feedbackId:versionId,tenantId:'caller-tenant',testerUserId:'caller-forgery'}))f.set(key,value);
    m.board.mockReturnValue(false);
    expect(await requestTestingRetestAction({error:null},f)).toEqual({error:'feedback_unavailable'});
    expect(m.board).toHaveBeenCalledWith(session);
    expect(m.retest).not.toHaveBeenCalled();expect(m.refresh).not.toHaveBeenCalled();
    m.board.mockReturnValue(true);
    expect(await requestTestingRetestAction({error:null},f)).toEqual({error:null});
    expect(m.retest).toHaveBeenCalledExactlyOnceWith(session,{assignmentId:caseId,expectedRevision:2,expectedVersionId:versionId,feedbackId:versionId});
    expect(m.refresh).toHaveBeenCalledWith('/admin/system-testing/executions/[id]','page');
  });
});
