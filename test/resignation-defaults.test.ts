import {describe,it,expect} from 'vitest';
import {resignationDefaults,RESIGNATION_DEFAULT_IDS} from '../lib/resignation-defaults';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import {OFFBOARDING_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/offboarding';
import {automationWorkflowProblems} from '../lib/automation/workflow';
import {documentRoutingSignatureProblems} from '../lib/document-signing-routing';
import {offboardingStepParamProblems} from '../lib/automation/offboarding';

describe('explicit resignation default configuration',()=>{
 it('ships eleven stable Paused workflows with valid module-owned steps and no fabricated recipients',()=>{
  const config=v9Defaults(),defaults=resignationDefaults(config,'Configuration owner','2026-11-16T00:00:00Z');
  expect(defaults.workflows.map(w=>w.trigger.event)).toEqual(['submitted','retention','accepted','rejected','offerDue','offerAccepted','offerDeclined','withdrawn','signRequest','sentBack','released']);
  const references={routingExists:()=>true,groupExists:()=>true,personExists:()=>false};
  for(const workflow of defaults.workflows){expect(workflow.status).toBe('paused');expect(automationWorkflowProblems(workflow,OFFBOARDING_AUTOMATION_CATALOGUE,references)).toEqual([]);expect(offboardingStepParamProblems(workflow,{emailTemplates:defaults.emails.map(t=>({...t,retired:false})),letterTemplateIds:defaults.templates.map(t=>t.id),letterTemplates:defaults.templates.map(t=>({id:t.id,retired:false,published:true,routing:t.versions[0].routing})),postingApproverGroupId:config.peopleOpsGroup,references,generatedLetterIds:defaults.templates.map(t=>t.id)})).toEqual([]);}
  for(const template of defaults.templates)expect(documentRoutingSignatureProblems(template.versions[0].routing!,template.versions[0].blocks)).toEqual([]);
  expect(defaults.routings[0].rows).toEqual([]);expect(new Set(defaults.workflows.map(w=>w.id)).size).toBe(11);
  expect(resignationDefaults(config,'Other owner','2026-11-17T00:00:00Z').workflows.map(w=>w.id)).toEqual(defaults.workflows.map(w=>w.id));
 });
 it('waits for actual letter release before delivering acceptance or starting clearance, and employee is last on a retention offer',()=>{
  const defaults=resignationDefaults(v9Defaults(),'Configuration owner','2026-11-16T00:00:00Z');const accepted=defaults.workflows.find(w=>w.trigger.event==='accepted')!;
  expect(accepted.steps.map(s=>s.type)).toEqual(['generateDocument','sendEmail','startOffboarding']);expect(accepted.steps[0].params.letterTemplateId).toBe(RESIGNATION_DEFAULT_IDS.acceptance);
  const routing=defaults.templates.find(t=>t.id===RESIGNATION_DEFAULT_IDS.retention)!.versions[0].routing!;expect(routing.at(-1)).toMatchObject({action:'sign',who:{kind:'employee'},order:2});
  expect(defaults.workflows.find(w=>w.trigger.event==='released')!.steps.map(s=>s.type)).toEqual(['notify']);
 });
});
