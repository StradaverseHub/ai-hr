import {describe,expect,it} from 'vitest';
import {automationCatalogueProblems,conditionFieldsForTrigger,mergeFieldsForTrigger} from '../lib/automation/catalogue';
import {OFFBOARDING_AUTOMATION_CATALOGUE as O,OFFBOARDING_POSTING_EVENTS,OFFBOARDING_POSTING_FIELDS} from '../lib/automation/catalogues/offboarding';
import {PROBATION_AUTOMATION_CATALOGUE as P} from '../lib/automation/catalogues/probation';
import {offboardingSettings,offboardingSettingsProblems,offboardingStepParamProblems,offboardingReplyProblems,retentionRoutingProblems,type OffboardingStepReferences} from '../lib/automation/offboarding';
import {setAutomationWorkflowStatus,type AutomationStep,type AutomationWorkflow} from '../lib/automation/workflow';
import type {Config} from '../lib/lifecycle-v9-model';
import {documentRoutingProblems} from '../lib/document-signing-routing';
import {parseV9Config,validateV9ConfigChange} from '../lib/lifecycle-v9-validation';
const refs:OffboardingStepReferences={emailTemplates:[{id:'email',name:'Email',active:true,retired:false}],letterTemplateIds:['letter'],postingApproverGroupId:'ops',references:{groupExists:id=>id==='ops',routingExists:id=>id==='route',personExists:id=>id==='person'}};
const step=(type:string,params:Record<string,unknown>={}):AutomationStep=>({id:'s',type,params,conditions:[],to:[{kind:'role',role:'directSuperior'}],cc:[]});
const workflow=(event:string,steps:AutomationStep[]):AutomationWorkflow=>({id:'00000000-0000-4000-8000-000000000001',module:'off',name:'Resignation',description:'',status:'paused',required:false,trigger:{event,days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps});
const problems=(event:string,s:AutomationStep)=>offboardingStepParamProblems(workflow(event,[s]),refs);
const base=():Config=>({version:9,revision:1,checklists:[],templates:[],emails:[],workflows:[],groups:[{id:'ops',name:'Operations',members:[],limit:25}],peopleOpsGroup:'ops',bpRules:[]});

describe('Offboarding catalogue and module isolation',()=>{
 it('validates the native exit classification without changing other modules',()=>{
  for(const reason of ['Resignation','Termination','Contract end','Retirement','Non-confirmation','',undefined])expect(problems('accepted',step('startOffboarding',{exitReason:reason}))).toEqual([]);
  for(const reason of ['Unsupported',0,{reason:'Resignation'}])expect(problems('accepted',step('startOffboarding',{exitReason:reason}))).toContain('Step 1: Choose an existing Offboarding exit reason.');
  expect(offboardingStepParamProblems({...workflow('accepted',[step('startOffboarding',{exitReason:'Other legacy reason'})]),module:'probation'},refs)).toEqual([]);
 });
 it('registers exactly the eleven handoff events without changing Probation options',()=>{
  expect(automationCatalogueProblems(O)).toEqual([]);
  expect(O.triggers.map(t=>t.id)).toEqual(['submitted','retention','accepted','rejected','offerDue','offerAccepted','offerDeclined','withdrawn','signRequest','sentBack','released']);
  expect(P.stepTypes.map(s=>s.id)).not.toContain('requestDecision');
  expect(P.mergeFields.some(f=>f.key.startsWith('retention.'))).toBe(false);
  expect(offboardingStepParamProblems({...workflow('submitted',[step('requestDecision')]),module:'probation'},refs)).toEqual([]);
 });
 it('limits condition and merge fields to events that have those facts',()=>{
  expect(conditionFieldsForTrigger(O,'submitted').map(f=>f.id)).not.toContain('baseIncrement');
  expect(conditionFieldsForTrigger(O,'retention').map(f=>f.id)).toContain('baseIncrement');
  expect(mergeFieldsForTrigger(O,'submitted').some(f=>f.key.startsWith('retention.'))).toBe(false);
  expect(mergeFieldsForTrigger(O,'retention').some(f=>f.key==='retention.replyBy')).toBe(false);
  expect(mergeFieldsForTrigger(O,'offerDue').some(f=>f.key==='retention.replyBy')).toBe(true);
  expect(mergeFieldsForTrigger(O,'signRequest').some(f=>f.key==='letter.where')).toBe(true);
 });
 it('allows only notifications on letter/reminder events',()=>{
  for(const event of ['offerDue','signRequest','sentBack','released'])expect(problems(event,step('requestDecision',{choices:'both'}))).toContain('Step 1: This trigger only sends notifications.');
  expect(problems('signRequest',step('notify',{subject:'Action needed'}))).toEqual([]);
  for(const event of ['offerDue','signRequest','sentBack','released'])expect(problems(event,step('sendEmail',{emailTemplateId:'email'}))).toContain('Step 1: This trigger only sends notifications.');
 });
 it('refuses pending recipients outside letter events including nested FYI lists',()=>{
  const s=step('requestDecision',{choices:'both',watch:[{kind:'pending'}]});
  expect(problems('submitted',s)).toContain('Step 1: Whoever’s letter step is pending is available only on letter triggers.');
  expect(problems('submitted',step('requestDecision',{choices:'both',watch:[{kind:'group',groupId:'deleted'}]}))).toContain('Step 1: A chosen assignment group no longer exists.');
  expect(problems('submitted',step('requestDecision',{choices:'both',watch:[{kind:'role',role:'directSuperior'}],dueDays:3,canComment:true}))).toEqual([]);
 });
});

describe('Offer deadlines and posting validation',()=>{
 it('accepts a blank window and rejects noninteger or out-of-range windows',()=>{
  expect(offboardingReplyProblems(null,null)).toEqual([]);
  expect(offboardingReplyProblems(5,2)).toEqual([]);
  for(const value of [0,61,-1,1.5,NaN,'5'])expect(offboardingReplyProblems(value,null).length).toBeGreaterThan(0);
  for(const [reply,reminder] of [[null,2],[5,5],[5,6]])expect(offboardingReplyProblems(reply,reminder).length).toBeGreaterThan(0);
  expect(problems('accepted',step('generateDocument',{letterTemplateId:'letter',replyDays:5}))).toContain('Step 1: Offer reply settings are available only on the retention trigger.');
 });
 it('restricts decision events and requires named decision choices',()=>{
  expect(problems('accepted',step('requestDecision',{choices:'both'}))).toContain('Step 1: Request resignation decision is only available for submitted, rejected or declined/lapsed offers.');
  expect(problems('submitted',step('requestDecision',{choices:'other'}))).toContain('Step 1: Choose accept only, or accept and retention offer.');
 });
 it('requires offer terms, permitted Personnel fields and a settings approver',()=>{
  const s=step('createPosting',{eventType:'Promotion',dateFrom:'offerEff',fields:['title','grade','salary'],dueDays:2});
  expect(problems('offerAccepted',s)).toEqual([]);
  expect(problems('submitted',s)).toContain('Step 1: This trigger has no retention offer fields or effective date.');
  expect(problems('offerAccepted',{...s,params:{...s.params,fields:['allowance']}})).toContain('Step 1: Posting fields can only be Position, Job Grade and Basic salary.');
  expect(offboardingStepParamProblems(workflow('offerAccepted',[s]),{...refs,postingApproverGroupId:null})).toContain('Step 1: Choose the Personnel postings approver in Offboarding settings.');
  expect(problems('offerAccepted',{...s,params:{...s.params,approver:'ops'}})).toContain('Step 1: Offboarding posting approvers are set in Offboarding settings, not on this step.');
 });
 it('blocks an employment type change that cannot be represented by the Offboarding posting allowlist',()=>{
  const message='Step 1: Employment Type Change requires an employment type, which Offboarding posting fields do not allow. Choose another event type.';
  for(const fields of [[],['title','grade','salary']]){
   const s=step('createPosting',{eventType:'Employment Type Change',dateFrom:'offerEff',fields});
   const draft=workflow('offerAccepted',[s]),issues=offboardingStepParamProblems(draft,refs);
   expect(issues).toContain(message);
   expect(setAutomationWorkflowStatus(draft,'live',issues).ok).toBe(false);
   expect(setAutomationWorkflowStatus(draft,'paused',issues).ok).toBe(true);
   expect(offboardingStepParamProblems({...workflow('offerAccepted',[s]),module:'probation',status:'live'},refs)).toEqual([]);
   expect(problems('offerAccepted',{...s,params:{...s.params,eventType:'Promotion',fields:['title']}})).toEqual([]);
  }
  expect(OFFBOARDING_POSTING_EVENTS).toContain('Employment Type Change');
  expect(OFFBOARDING_POSTING_FIELDS).toEqual(['title','grade','salary']);
 });
 it('keeps termination clearance-only and rejects unknown posting events without changing the pinned options',()=>{
  const s=step('createPosting',{eventType:'Termination',dateFrom:'lwd',fields:[],exitReason:'Resignation'});
  const draft=workflow('accepted',[s]),issues=offboardingStepParamProblems(draft,refs);
  expect(issues).toContain('Step 1: Termination is posted automatically after completed clearance. Choose another event type for a resignation workflow.');
  expect(setAutomationWorkflowStatus(draft,'live',issues).ok).toBe(false);
  expect(setAutomationWorkflowStatus(draft,'paused',issues).ok).toBe(true);
  expect(OFFBOARDING_POSTING_EVENTS).toContain('Termination');
  expect(problems('offerAccepted',{...s,params:{...s.params,eventType:'Unknown event',dateFrom:'offerEff',fields:['salary']}})).toContain('Step 1: Choose the Personnel posting event type.');
  expect(offboardingStepParamProblems({...draft,module:'probation'},refs)).toEqual([]);
 });
 it('requires the employee to be the only last signer',()=>{
  const good=[{id:'review',order:1,action:'review' as const,owner:true,who:{kind:'group' as const,groupId:'ops'}},{id:'employee',order:2,action:'sign' as const,owner:false,who:{kind:'employee' as const}}];
  expect(retentionRoutingProblems(good)).toEqual([]);
  expect(retentionRoutingProblems([...good,{id:'parallel',order:2,action:'sign',owner:false,who:{kind:'directSuperior'}}])).not.toEqual([]);
  expect(retentionRoutingProblems([{...good[1],order:1},good[0]])).not.toEqual([]);
 });
});

describe('Additive V9 settings and routing storage',()=>{
 it('preserves old records without materializing new defaults',()=>{
  const old=base(),parsed=parseV9Config(old);
  expect(parsed).toEqual(old);expect(parsed).not.toHaveProperty('offboarding');
  expect(offboardingSettings(old)).toEqual({postingApproverGroupId:'ops',reofferMonths:12});
  expect(offboardingSettings({...old,offboarding:{postingApproverGroupId:null,reofferMonths:null}})).toEqual({postingApproverGroupId:null,reofferMonths:null});
 });
 it('retains explicit no-limit and rejects malformed limits',()=>{
  const config=base();config.offboarding={postingApproverGroupId:'ops',reofferMonths:null};
  expect(parseV9Config(config).offboarding).toEqual(config.offboarding);
  expect(offboardingSettingsProblems({postingApproverGroupId:'ops',reofferMonths:0})).not.toEqual([]);
  expect(()=>parseV9Config({...config,offboarding:{reofferMonths:61}})).toThrow();
  expect(()=>parseV9Config({...config,offboarding:{postingApproverGroupId:'missing'}})).toThrow('existing assignment group');
 });
 it('round-trips template-owned routing and keeps it immutable when published',()=>{
  const config=base();config.templates=[{id:'letter',name:'Letter',module:'off',type:'Letter',rules:{},hrStep:'before',employeeAck:false,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:'2026-11-16',by:'HR',fields:[],blocks:[{id:'signature',type:'signature',text:'',section:'',role:'step:sign'}],routing:[{id:'sign',order:1,action:'sign',owner:true,who:{kind:'employee'}}]}]}];
  const parsed=parseV9Config(config);expect(parsed.templates[0].versions[0].routing).toEqual(config.templates[0].versions[0].routing);
  const edited=structuredClone(parsed);edited.templates[0].versions[0].routing![0].owner=false;
  expect(()=>validateV9ConfigChange(parsed,edited,[])).toThrow('immutable');
 });
 it('does not impose a mandatory signature on non-Probation routing',()=>{
  const config=base();config.templates=[{id:'review-only',name:'Review only',module:'off',type:'Letter',rules:{},hrStep:'none',employeeAck:false,retired:false,versions:[{version:1,state:'published',at:'',by:'HR',blocks:[],fields:[],routing:[{id:'review',order:1,action:'review',owner:true,who:{kind:'group',groupId:'ops'}}]}]}];
  expect(parseV9Config(config).templates[0].versions[0].routing).toHaveLength(1);
  expect(documentRoutingProblems(config.templates[0].versions[0].routing!,{groupExists:()=>true,routingExists:()=>true,personExists:()=>true})).toContain('At least one step must be a Sign step, or nobody signs the document.');
 });
 it('preserves legacy email CC and retains only scoped Offboarding metadata',()=>{
  const config=base();config.emails=[{id:'email',name:'Email',module:'off',active:true,sender:'noreply',subject:'Subject',body:'Body',cc:['supervisor'],links:[],attachments:[],routingCc:[{kind:'routing',routingId:'00000000-0000-4000-8000-000000000002'}],slots:[{id:'schedule',label:'Schedule',required:true,by:{kind:'group',groupId:'ops'}}]}];
  const parsed=parseV9Config(config);expect(parsed.emails[0]).toEqual(config.emails[0]);expect(parsed.emails[0].cc).toEqual(['supervisor']);
  expect(()=>parseV9Config({...config,emails:[{...config.emails[0],module:'onb'}]})).toThrow('only for Offboarding');
  expect(()=>parseV9Config({...config,emails:[{...config.emails[0],routingCc:[{kind:'pending'}]}]})).toThrow();
 });

});
