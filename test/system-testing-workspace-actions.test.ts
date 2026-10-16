import { beforeEach,describe,expect,it,vi } from 'vitest';
import { TestingRefusal } from '../lib/system-testing/model';
import { testingInstructionDraftFrom } from '../lib/system-testing/editor-model';
const m=vi.hoisted(()=>({session:vi.fn(),save:vi.fn(),publish:vi.fn(),observe:vi.fn(),assign:vi.fn(),confirm:vi.fn(),retest:vi.fn(),begin:vi.fn(),raise:vi.fn(),legacyRaise:vi.fn(),refresh:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:m.refresh}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error('REDIRECT '+path);}}));
vi.mock('../lib/session',()=>({getSession:m.session}));
vi.mock('../core/entitlements',()=>({ModuleNotEnabledError:class ModuleNotEnabledError extends Error{}}));
vi.mock('../core/system-testing',()=>({SystemTestingError:class SystemTestingError extends Error{},assignTestingCase:m.assign,beginTestingExecution:m.begin,confirmTestingCatalogue:m.confirm,publishTestInstruction:m.publish,raiseTestingExecutionFeedback:m.raise,raiseRunAsFeedback:m.legacyRaise,requestTestingRetest:m.retest,saveTestInstructionDraft:m.save,saveTestingExecution:m.observe}));
import { saveTestingInstructionAction,saveTestingObservationAction } from '../app/admin/system-testing/workspace-actions';
const caseId='47335504-b4ad-401b-8d10-59499482ee22',versionId='0a576e11-b48e-4b89-94f3-b8430ccf426b';
const session={tenantId:caseId,userId:versionId,roles:['hr_admin']};
beforeEach(()=>{vi.clearAllMocks();m.session.mockResolvedValue(session);m.save.mockResolvedValue({caseId,revision:4,caseNo:7});m.publish.mockResolvedValue({caseId,versionId,ordinal:1,draftRevision:5});m.observe.mockResolvedValue({runId:caseId,revision:4});});
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
});
