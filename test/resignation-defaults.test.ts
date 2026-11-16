import {describe,it,expect} from 'vitest';
import {resignationDefaults,RESIGNATION_DEFAULT_IDS as I,RESIGNATION_DEFAULT_ROUTINGS} from '../lib/resignation-defaults';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import {OFFBOARDING_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/offboarding';
import {automationWorkflowProblems} from '../lib/automation/workflow';
import {documentRoutingSignatureProblems} from '../lib/document-signing-routing';
import {offboardingStepParamProblems} from '../lib/automation/offboarding';
import type {Routing} from '../lib/automation/routing';
const at='2026-11-16T00:00:00Z',make=()=>resignationDefaults(v9Defaults(),'Configuration owner',at);
const superior={kind:'role',role:'directSuperior'},employee={kind:'role',role:'employee'},bp={kind:'routing',routingId:I.bp};

describe('explicit resignation defaults match handoff §14',()=>{
 it('preserves all previously declared IDs and step identities, installs eleven Paused workflows, and fabricates no people',()=>{
  const config=v9Defaults(),defaults=resignationDefaults(config,'Configuration owner',at),routingIds=new Set(defaults.routings.map(r=>r.id)),groupIds=new Set([...config.groups,...defaults.groups].map(g=>g.id));
  expect([I.bp,I.acceptance,I.retention,I.acceptanceEmail,I.retentionEmail]).toEqual([1,2,3,4,5].map(n=>`a0710000-0000-4000-8000-${String(n).padStart(12,'0')}`));
  expect(defaults.workflows.map(w=>w.trigger.event)).toEqual(['submitted','retention','accepted','rejected','offerDue','offerAccepted','offerDeclined','withdrawn','signRequest','sentBack','released']);
  expect(defaults.workflows.map(w=>w.id)).toEqual(Array.from({length:11},(_,n)=>`a0710000-0000-4000-8000-${String(n+1001).padStart(12,'0')}`));
  expect(defaults.workflows.flatMap(w=>w.steps.map(s=>s.id)).filter(id=>id.startsWith('step-')).sort()).toEqual(Array.from({length:14},(_,n)=>'step-'+(n+11)).sort());
  const references={routingExists:(id:string)=>routingIds.has(id),groupExists:(id:string)=>groupIds.has(id),personExists:()=>false};
  for(const workflow of defaults.workflows){
   expect(workflow.status).toBe('paused');expect(automationWorkflowProblems(workflow,OFFBOARDING_AUTOMATION_CATALOGUE,references)).toEqual([]);
   expect(offboardingStepParamProblems(workflow,{emailTemplates:defaults.emails.map(t=>({...t,retired:false})),letterTemplateIds:defaults.templates.map(t=>t.id),letterTemplates:defaults.templates.map(t=>({id:t.id,retired:false,published:true,routing:t.versions[0].routing})),postingApproverGroupId:config.peopleOpsGroup,references,generatedLetterIds:defaults.templates.map(t=>t.id)})).toEqual([]);
  }
  expect(defaults.groups.every(group=>group.members.length===0)).toBe(true);expect(defaults.groups.map(group=>group.id)).toEqual([I.bpGroup,I.ceoGroup]);
  expect(resignationDefaults(config,'Other owner','2026-11-17T00:00:00Z').workflows.map(w=>w.id)).toEqual(defaults.workflows.map(w=>w.id));
 });
 it('starts native Offboarding before acceptance generation and sends the signed acceptance with its exact CC after the letter wait',()=>{
  const workflow=make().workflows.find(w=>w.trigger.event==='accepted')!;
  expect(workflow.steps.map(s=>[s.id,s.type])).toEqual([['step-15','startOffboarding'],['step-13','generateDocument'],['step-14','sendEmail']]);
  expect(workflow.steps[0].params).toEqual({exitReason:'Resignation'});expect(workflow.steps[1].params).toEqual({letterTemplateId:I.acceptance});
  expect(workflow.steps[2]).toMatchObject({params:{emailTemplateId:I.acceptanceEmail},to:[employee],cc:[superior,bp]});
 });
 it('emails the signed retained offer before the posting wait, with offer-effective Promotion fields due in two working days',()=>{
  const workflow=make().workflows.find(w=>w.trigger.event==='offerAccepted')!;
  expect(workflow.steps.map(s=>[s.id,s.type])).toEqual([['step-19','sendEmail'],['step-18','createPosting']]);
  expect(workflow.steps[0]).toMatchObject({params:{emailTemplateId:I.retentionEmail},to:[employee],cc:[superior,bp]});
  expect(workflow.steps[1].params).toEqual({eventType:'Promotion',dateFrom:'offerEff',fields:['title','grade','salary'],dueDays:2});
 });
 it('sends Resignation received to Direct Superior with BP CC before creating its decision and FYI assignments',()=>{
  const defaults=make(),workflow=defaults.workflows.find(w=>w.trigger.event==='submitted')!;
  expect(workflow.steps.map(s=>s.type)).toEqual(['sendEmail','requestDecision']);
  expect(workflow.steps[0]).toMatchObject({params:{emailTemplateId:I.receivedEmail},to:[superior],cc:[bp]});
  expect(defaults.emails.find(email=>email.id===I.receivedEmail)).toMatchObject({name:'Resignation received',attachments:[]});
  expect(workflow.steps[1]).toMatchObject({id:'step-11',to:[superior],params:{choices:'both',watch:[bp],canComment:true,dueDays:3}});
 });
 it('routes retention through GBS Review ownership, explicit CEO signing and sole final employee signing',()=>{
  const config=v9Defaults(),defaults=resignationDefaults(config,'Configuration owner',at),template=defaults.templates.find(t=>t.id===I.retention)!,version=template.versions[0];
  expect(version.routing).toEqual([
   {id:'gbs-review',order:1,action:'review',who:{kind:'group',groupId:config.peopleOpsGroup},owner:true},
   {id:'ceo',order:2,action:'sign',who:{kind:'routing',routingId:I.ceo},owner:false},
   {id:'employee',order:3,action:'sign',who:{kind:'employee'},owner:false},
  ]);
  expect(version.blocks.filter(block=>block.type==='signature').map(block=>block.role)).toEqual(['step:ceo','step:employee']);
  expect(version.blocks.some(block=>block.type==='letterhead')).toBe(true);expect(version.blocks.find(block=>block.type==='heading')?.text).toBe('Offer of revised terms of employment');
  expect(version.blocks.find(block=>block.type==='table')).toMatchObject({columns:'Term | Current | Offered',rows:expect.stringContaining('{{employee.salary}} | {{retention.salary}}')});
  expect(documentRoutingSignatureProblems(version.routing!,version.blocks)).toEqual([]);
 });
 it('routes acceptance through GBS Review ownership then BP signature, with no employee or GBS signature',()=>{
  const config=v9Defaults(),template=resignationDefaults(config,'Configuration owner',at).templates.find(t=>t.id===I.acceptance)!,version=template.versions[0];
  expect(version.routing).toEqual([
   {id:'gbs-review',order:1,action:'review',who:{kind:'group',groupId:config.peopleOpsGroup},owner:true},
   {id:'bp',order:2,action:'sign',who:{kind:'routing',routingId:I.bp},owner:false},
  ]);
  expect(version.blocks.filter(block=>block.type==='signature').map(block=>block.role)).toEqual(['step:bp']);expect(documentRoutingSignatureProblems(version.routing!,version.blocks)).toEqual([]);
 });
 it('creates only missing stable empty groups for new routings, never chooses a CEO or BP by a name heuristic',()=>{
  const config=v9Defaults();config.groups.push({id:'unrelated-ceo',name:'CEO',members:['someone'],limit:20},{id:'unrelated-bp',name:'People Business Partners',members:['someone-else'],limit:20});
  const before=structuredClone(config),defaults=resignationDefaults(config,'Configuration owner',at);
  expect(config).toEqual(before);expect(defaults.peopleOpsGroupId).toBe(config.peopleOpsGroup);expect(defaults.groups.map(group=>group.id)).toEqual([I.bpGroup,I.ceoGroup]);expect(defaults.groups.every(group=>group.members.length===0)).toBe(true);
  expect(defaults.routings).toEqual(RESIGNATION_DEFAULT_ROUTINGS);expect(defaults.routings.flatMap(route=>route.rows.map(row=>row.assignTo))).toEqual([{kind:'group',groupId:I.bpGroup},{kind:'group',groupId:I.ceoGroup}]);
 });
 it('reuses configured stable group membership and custom existing routes without overwriting or creating unused groups',()=>{
  const config=v9Defaults();config.groups.push({id:I.bpGroup,name:'Owner configured BP team',members:['actual-bp'],limit:7});
  const custom:Routing[]=[{id:I.ceo,name:'Owner configured CEO routing',rows:[{match:{company:['real-company']},assignTo:{kind:'people',userIds:['actual-ceo']}}]}],before=structuredClone({config,custom});
  const partial=resignationDefaults(config,'Configuration owner',at,custom);expect(partial.groups).toEqual([]);expect(partial.routings.map(r=>r.id)).toEqual([I.bp]);expect({config,custom}).toEqual(before);
  const all=resignationDefaults(config,'Configuration owner',at,[...custom,{id:I.bp,name:'Custom BP',rows:[]}]);expect(all.routings).toEqual([]);expect(all.groups).toEqual([]);
 });
 it('provides an empty stable GBS fallback only when the configured People Ops pointer is absent',()=>{
  const config=v9Defaults();config.peopleOpsGroup=null;config.groups.push({id:'named-gbs',name:'GBS People Ops',members:['unrelated-person'],limit:25});
  const defaults=resignationDefaults(config,'Configuration owner',at);expect(defaults.peopleOpsGroupId).toBe(I.peopleOpsGroup);expect(defaults.groups.find(group=>group.id===I.peopleOpsGroup)).toMatchObject({members:[],limit:25});expect(config.peopleOpsGroup).toBeNull();
 });
 it('keeps BP and GBS in the required rejected/declined loops and Direct Superior on reminders',()=>{
  const config=v9Defaults(),defaults=resignationDefaults(config,'Configuration owner',at),ops={kind:'group',groupId:config.peopleOpsGroup};
  for(const event of ['rejected','offerDeclined']){const workflow=defaults.workflows.find(w=>w.trigger.event===event)!;expect(workflow.steps.map(step=>step.type)).toEqual(['notify','requestDecision']);expect(workflow.steps[1].params).toMatchObject({choices:event==='rejected'?'both':'accept',watch:[bp,ops],canComment:true,dueDays:3});}
  expect(defaults.workflows.find(w=>w.trigger.event==='rejected')!.steps[0].cc).toEqual([bp,ops]);expect(defaults.workflows.find(w=>w.trigger.event==='offerDeclined')!.steps[0].cc).toEqual([bp]);expect(defaults.workflows.find(w=>w.trigger.event==='offerDue')!.steps[0].cc).toEqual([superior]);
 });
});
