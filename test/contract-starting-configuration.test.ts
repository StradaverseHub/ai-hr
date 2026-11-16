import {describe,expect,it} from 'vitest';
import {contractDefaultId,contractStartingConfiguration} from '../lib/contract-starting-configuration';
import {automationDocumentTemplateSchema,automationDocumentTemplateProblems} from '../lib/automation/document-template';
import {automationWorkflowProblems} from '../lib/automation/workflow';
import {automationEmailTemplateProblems} from '../lib/automation/email';
import {contractStepParamProblems} from '../lib/contract-automation';
import {CONTRACT_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/contracts';
const mapping={companyId:'00000000-0000-4000-8000-000000000001',fallbackGroupId:'actual-ops',postingApproverGroupId:'actual-postings',bpRoutingId:'00000000-0000-4000-8000-000000000002',ceoRoutingId:'00000000-0000-4000-8000-000000000003'};
const refs={groupExists:(id:string)=>['actual-ops','actual-postings'].includes(id),routingExists:(id:string)=>[mapping.bpRoutingId,mapping.ceoRoutingId].includes(id),personExists:()=>false};
describe('Contract starting configuration over mapped native identities',()=>{
 it('produces live valid workflows and routed documents without inventing named people or groups',()=>{
  const setup=contractStartingConfiguration(mapping);
  expect(setup.documents).toHaveLength(5);expect(setup.emails).toHaveLength(4);expect(setup.workflows).toHaveLength(12);
  for(const doc of setup.documents){expect(automationDocumentTemplateSchema.safeParse(doc).success).toBe(true);expect(automationDocumentTemplateProblems(doc,refs)).toEqual([]);}
  for(const email of setup.emails)expect(automationEmailTemplateProblems(email,CONTRACT_AUTOMATION_CATALOGUE,refs)).toEqual([]);
  for(const workflow of setup.workflows){
   expect(automationWorkflowProblems(workflow,CONTRACT_AUTOMATION_CATALOGUE,refs)).toEqual([]);
   expect(contractStepParamProblems(workflow,{letterTemplateIds:setup.documents.map(doc=>doc.id),emailTemplates:setup.emails.map(email=>({...email,retired:false}))},refs)).toEqual([]);
  }
  expect(JSON.stringify(setup)).not.toMatch(/CHCE|CHBM|Siteng|Sarah|Meiling|"kind":"person"/);
 });
 it('keeps the reviewed reminder, approval, signing and manual-pay order',()=>{
  const setup=contractStartingConfiguration(mapping),reminders=setup.workflows.filter(item=>item.trigger.event==='beforeContractEnd');
  expect(reminders.map(item=>item.trigger.days)).toEqual([30,14,7]);expect(reminders.map(item=>item.trigger.repeat)).toEqual([false,false,true]);expect(reminders.map(item=>item.skipWhen)).toEqual(['never','decided','decided']);
  for(const name of ['Renew decision','Convert to permanent']){
   const workflow=setup.workflows.find(item=>item.name===name)!;expect(workflow.steps.map(step=>step.type)).toEqual(['requestApproval','generateDocument','createPosting','notify']);
   expect(workflow.steps[3].conditions).toEqual([{field:'payChanges',op:'is',values:['Yes']}]);
  }
  for(const document of setup.documents){expect(document.routing[0]).toMatchObject({order:1,action:'review',owner:true,who:{kind:'group',groupId:mapping.fallbackGroupId}});expect(document.routing[1]).toMatchObject({order:2,action:'sign',who:{kind:'routing',routingId:mapping.bpRoutingId}});}
  expect(setup.documents.filter(doc=>doc.routing.some(step=>step.who.kind==='employee')).map(doc=>doc.id)).toEqual([contractDefaultId(1),contractDefaultId(2)]);
  expect(setup.documents[1].blocks.some(block=>/probation/i.test(block.text))).toBe(false);
  expect(setup.emails.every(email=>!email.body.includes('contract.salary'))).toBe(true);
 });
 it('refuses missing mappings and keeps definition identities stable for idempotent installation',()=>{
  expect(()=>contractStartingConfiguration({...mapping,bpRoutingId:''})).toThrow(/Map existing/);
  expect(contractStartingConfiguration(mapping)).toEqual(contractStartingConfiguration(mapping));
 });
});
