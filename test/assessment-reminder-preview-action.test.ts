import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultEmailDocument} from '../lib/email-design/model';
import {workflowEmailMessage} from '../deploy/identity-email/notification-message';
const mocks=vi.hoisted(()=>({session:vi.fn(),preview:vi.fn(),locale:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('next-intl/server',()=>({getLocale:mocks.locale,getTranslations:vi.fn()}));
vi.mock('../lib/real-auth',()=>({appOrigin:()=> 'https://hr.example.test'}));
vi.mock('../packs/performance/service',()=>({previewAssessmentReminder:mocks.preview,getAssessmentReminders:vi.fn(),queueAssessmentReminders:vi.fn(),saveAssessmentReminderRules:vi.fn(),saveAssessmentReminderWords:vi.fn()}));
import {assessmentReminderPersonPreviewAction} from '../app/(app)/performance/assessment-reminder-actions';
const viewer={tenantId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',roles:['hr_admin']};
const cycle='33333333-3333-4333-8333-333333333333',tasks=[{key:'own_competency' as const,count:1,closesAt:null}];
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue(viewer);mocks.locale.mockResolvedValue('en');});
afterEach(()=>vi.unstubAllEnvs());
describe('personal reminder preview action',()=>{
 it('uses the authorized recipient locale and custom layout instead of the viewer locale, with the real delivery link',async()=>{
  const base=defaultEmailDocument('assessment_reminder'),design={kind:'assessment_reminder' as const,locale:'ms' as const,document:{...base,subject:'MS {first_name}',background:'#123456'},data:{first_name:'Fictional <Recipient>',count:'1',cycle:'Fictional cycle',things:'thing is'}};
  mocks.preview.mockResolvedValue({mode:'full',locale:'ms',design,employee:'Fictional recipient',employeeCode:'001',eligible:false,mail:{tasks,words:null}});
  const response=await assessmentReminderPersonPreviewAction(cycle,'001');expect(response.error).toBeUndefined();expect(response.result).toMatchObject({mode:'full',locale:'ms',eligible:false});
  expect(response.result?.message).toEqual(workflowEmailMessage({category:'performance',locale:'ms',link:'https://hr.example.test/me/performance',action:true,messageId:'fixture',assessmentTasks:tasks,assessmentWords:null,design}));
  expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(viewer,cycle,'001');expect(mocks.locale).not.toHaveBeenCalled();
 });
 it('keeps a clearly identified scoped summary with code-owned wording, without guessing a recipient language or using custom data',async()=>{
  mocks.locale.mockResolvedValue('zh');mocks.preview.mockResolvedValue({mode:'summary',locale:null,design:null,employee:'Permitted label',employeeCode:'001',eligible:false,mail:{tasks,words:null}});
  const response=await assessmentReminderPersonPreviewAction(cycle,'001');expect(response.result).toMatchObject({mode:'summary',locale:'zh',eligible:false});expect(response.result?.message?.html).toContain('lang="zh"');expect(response.result?.message?.text).toContain('https://hr.example.test/me/performance');expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(viewer,cycle,'001');
 });
 it('keeps an authorized no-work result empty and turns a refusal into an error without rendering private details',async()=>{
  mocks.preview.mockResolvedValue({mode:'summary',locale:null,design:null,employee:'Permitted label',employeeCode:'001',eligible:false,mail:{tasks:[],words:null}});expect((await assessmentReminderPersonPreviewAction(cycle,'001')).result?.message).toBeNull();
  mocks.preview.mockRejectedValue(Error('Performance administrator access is required.'));expect(await assessmentReminderPersonPreviewAction(cycle,'001')).toEqual({error:'Performance administrator access is required.'});
 });
});
