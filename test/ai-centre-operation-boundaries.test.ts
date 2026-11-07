import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {setAiCentreReadControl} from '../core/ai-centre-inventory';
import {withAiCentreFunction} from '../core/ai-centre-control';
import {setMandateStopSwitch} from '../core/mandates/mandates';
import {prepareAssistantImport} from '../core/assistant-import';
import {IMPORT_TARGETS} from '../lib/assistant-import';
import {readPolicyValues} from '../core/handbook/policies';
import {evaluateProviderCandidate} from '../core/ai-provider-readiness';
import {runProviderBaseline} from '../core/ai-provider-baseline';
import * as agents from '../core/module-agent-releases';
import * as performance from '../packs/performance/service';
import * as commands from '../packs/performance/onehr/review-command-ai';
import {generateRewardAdvisor} from '../packs/rewards/advisor';
import {generateArchitectureAdvice} from '../packs/job-architecture/service';
import {closeAll,entitledCtx,migrateTestDb,resetDb,seedBase} from './harness';

let ctx:SessionContext;
const id=randomUUID();
// Unused downstream facts/consents are deliberately absent. Each public boundary must return
// the real SQL pause refusal before source loading, native writes or provider configuration.
// Inputs validated before admission (UUIDs, discriminators, import consent, plan/nonce) are valid.
const unused=undefined as never;
const boundaries:ReadonlyArray<readonly [string,()=>Promise<unknown>]>= [
 ['performance_narrative',()=>performance.draftOnehrNarrative(ctx,id,'Fixture')],
 ['performance_calibration',()=>performance.sendCalibrationMessage(ctx,id,'performance',null,id,'Fixture')],
 ['performance_feedback',()=>performance.sendFeedbackMessage(ctx,id,id,null,id,'Fixture')],
 ['performance_conversation',()=>performance.sendReviewMessage(ctx,id,'setting',null,id,'Fixture')],
 ['performance_evidence_vision',()=>performance.readAssessmentFileTexts(ctx,id,{allowImages:true})],
 ['idp_fit',()=>performance.getAssessmentIdpFit(ctx,id,{generate:true})],
 ['potential_insight',()=>performance.getAssessmentPotentialInsight(ctx,id,id,{generate:true})],
 ['talent_insight',()=>performance.getAssessmentTalentInsight(ctx,id,id,{generate:true})],
 ...(['present','cycle','trend'] as const).map(kind=>['record_'+kind,()=>performance.getAssessmentRecordInsight(ctx,id,kind,{generate:true})] as const),
 ['written_performance',()=>performance.getAssessmentWrittenRemarks(ctx,id,id,'pm',{generate:true})],
 ['written_potential',()=>performance.getAssessmentWrittenRemarks(ctx,id,id,'pot',{generate:true})],
 ['performance_setting_suggestion',()=>commands.proposeSettingSuggestion(ctx,id,unused,unused)],
 ['performance_career_commands',()=>commands.proposeCareerCommands(ctx,id,unused,unused)],
 ['performance_setting_commands',()=>commands.proposeSettingCommands(ctx,id,unused,unused)],
 ['performance_review_commands',()=>commands.proposeReviewCommands(ctx,id,unused,unused)],
 ['performance_journey_commands',()=>commands.proposeJourneyCommands(ctx,id,unused,unused,unused)],
 ['policy_values',()=>readPolicyValues(ctx,{versionId:id},null)],
 ['assistant_import',()=>prepareAssistantImport(ctx,{target:'employee',source:'Fixture',instruction:'Prepare draft',consent:true})],
 ...IMPORT_TARGETS.map(target=>['assistant_import_'+target,()=>prepareAssistantImport(ctx,{target,source:'Fixture',instruction:'Prepare draft',consent:true})] as const),
 ['prompt_evaluation',()=>agents.evaluatePromptAgentCandidate(ctx,{candidateId:id,consent:unused})],
 ['human_planner_evaluation',()=>agents.evaluateHumanQuestionPlannerCandidate(ctx,{candidateId:id,consent:unused})],
 ['conversation_evaluation',()=>agents.evaluateConversationAgentCandidate(ctx,{candidateId:id,consent:unused})],
 ['specialist_evaluation',()=>agents.evaluateCanonicalSpecialistCandidate(ctx,id)],
 ['prompt_synthetic_job',()=>agents.runPromptPlannedSyntheticJob(ctx,{fixtureId:id,consent:unused})],
 ['human_question_plan',()=>agents.proposeOwnModuleReadPlan(ctx,{permit:'not-issued',question:'Fixture',locale:'en',consent:{questionOnly:true,oneRequest:true,sourceDigest:'fixture'}})],
 ['module_read_plan',()=>agents.runGovernedModuleReadPlan(ctx,{version:1,modules:['employees']},{nonce:id})],
 ['specialist_job',()=>agents.runGovernedSpecialistJob(ctx,{module:'employees'},{nonce:id})],
 ['provider_readiness',()=>evaluateProviderCandidate(ctx,unused)],
 ['provider_baseline',()=>runProviderBaseline(ctx,unused)],
 ['rewards_advice',()=>generateRewardAdvisor(ctx,id,id)],
 ['architecture_advice',()=>generateArchitectureAdvice(ctx,{kind:'position',companyId:id,subjectId:id})],
 ...(['position','description','outlier'] as const).map(kind=>['architecture_'+kind,()=>generateArchitectureAdvice(ctx,{kind,companyId:id,subjectId:id})] as const),
];

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();const base=await seedBase();ctx={...await entitledCtx(base),grants:[{role:'hr_admin',companyId:null}]};});
describe('every newly inventoried public operation uses the real control owner',()=>{
 it('covers exactly the append-only migration registration',()=>{
  const registered=[...readFileSync('db/migrations/3000_ai_centre_function_coverage.sql','utf8').matchAll(/\('read:operation_([^']+)',true\)/g)].map(match=>match[1]).sort();
  expect(boundaries.map(([key])=>key).sort()).toEqual(registered);
  expect(new Set(registered).size).toBe(41);
 });
 it.each(boundaries)('%s refuses its own toggle and the global stop before downstream work',async(key,invoke)=>{
  await setAiCentreReadControl(ctx,'read:operation_'+key,false);
  await expect(invoke()).rejects.toMatchObject({reason:'paused'});
  // One child never changes an unrelated child or replaces its native permissions.
  await expect(withAiCentreFunction(ctx,'read:operation_pay_formula_draft',async()=> 'sibling')).resolves.toBe('sibling');
  await setAiCentreReadControl(ctx,'read:operation_'+key,true);
  await setMandateStopSwitch(ctx,true);
  await expect(invoke()).rejects.toMatchObject({reason:'paused'});
  await setMandateStopSwitch(ctx,false);
  const [runs]=await withTenant(ctx,tx=>tx.execute<{count:number}>(sql`select count(*)::int as count from ai_model_run where tenant_id=app.current_tenant_id()`));
  expect(runs.count).toBe(0);
 });
});
