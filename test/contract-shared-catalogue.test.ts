import {describe, expect, it} from 'vitest';
import {automationCatalogueProblems, conditionFieldsForTrigger, mergeFieldsForTrigger} from '../lib/automation/catalogue';
import {CONTRACT_AUTOMATION_CATALOGUE as C} from '../lib/automation/catalogues/contracts';
import {contractStepParamProblems, contractWorkflowRecipients, contractWorkflowWarnings} from '../lib/contract-automation';
import {automationWorkflowProblems, type AutomationWorkflow} from '../lib/automation/workflow';
import {memoryAutomationRunStore, runAutomationEvent, resumeAutomationRuns} from '../lib/automation/runtime';
const wf = (): AutomationWorkflow => ({id: 'wf', module: 'contract_staff', name: 'Renew', description: '', status: 'live', required: false, trigger: {event: 'decisionSubmitted', days: 0, workdays: false, repeat: false}, skipWhen: 'never', conditions: [{field: 'decision', op: 'is', values: ['Renew']}], steps: [
  {id: 'approval', type: 'requestApproval', conditions: [], to: [], cc: [], params: {layers: [{id: '00000000-0000-4000-8000-000000000001', name: 'CEO', approver: {kind: 'group', groupId: 'ceos'}, pick: 'any'}]}},
  {id: 'document', type: 'generateDocument', conditions: [], to: [], cc: [], params: {letterTemplateId: 'renewal'}},
  {id: 'posting', type: 'createPosting', conditions: [], to: [], cc: [], params: {eventType: 'Renewal'}},
]});
const refs = {emailTemplates: [], letterTemplateIds: ['renewal']};
describe('Contract shared catalogue and publication checks', () => {
  it('offers eleven consistent triggers and six steps, without legacy signature-wait or automatic record writing', () => {
    expect(automationCatalogueProblems(C)).toEqual([]);
    expect(C.triggers).toHaveLength(11);
    expect(C.stepTypes).toHaveLength(6);
    expect(C.stepTypes.map(s => s.id)).not.toEqual(expect.arrayContaining(['wait_signature', 'update_record']));
    expect(conditionFieldsForTrigger(C, 'caseOpened').map(f => f.id)).not.toContain('decision');
    expect(mergeFieldsForTrigger(C, 'beforeContractEnd').map(f => f.key)).not.toContain('contract.salary');
    expect(mergeFieldsForTrigger(C, 'letterSentBack').map(f => f.key)).toContain('letter.sentBackReason');
  });
  it('checks nested approval recipients as well as the shared envelope', () => {
    const w = wf(), recipients = {routingExists: () => true, groupExists: () => true, personExists: () => true};
    expect(automationWorkflowProblems(w, C, recipients)).toEqual([]);
    expect(contractStepParamProblems(w, refs, recipients)).toEqual([]);
    expect(contractWorkflowRecipients(w)).toContainEqual({kind: 'group', groupId: 'ceos'});
    expect(contractStepParamProblems(w, refs, {...recipients, groupExists: () => false}).join()).toContain('unavailable');
  });
  it('refuses pending recipients outside letter triggers, unbounded days and invalid posting kinds', () => {
    const w = wf();
    w.trigger.days = 366;
    w.steps.push({id: 'email', type: 'notify', to: [{kind: 'pending'}], cc: [], conditions: [], params: {subject: 'Hello', body: 'Message', sender: 'another sender'}});
    w.steps[2].params.eventType = 'Termination now';
    const problems = contractStepParamProblems(w, refs).join(' ');
    for (const fragment of ['365', 'letter triggers', 'OneHR', 'Renewal']) expect(problems).toContain(fragment);
  });
  it('warns rather than inventing a posting for an incomplete decision workflow', () => {
    const w = wf(); w.steps.pop();
    expect(contractWorkflowWarnings(w)).toHaveLength(1);
    expect(contractStepParamProblems(w, refs)).toEqual([]);
  });
  it('uses the same shared runner to wait for decision approval, then document release, before creating a posting', async () => {
    const store = memoryAutomationRunStore(), calls: string[] = [];
    const executors = {
      requestApproval: async () => {calls.push('approval'); return {status: 'wait' as const, documentId: 'approval-request'};},
      generateDocument: async () => {calls.push('letter'); return {status: 'wait' as const, documentId: 'letter'};},
      createPosting: async () => {calls.push('posting'); return {status: 'done' as const};},
      notifyFailure: async () => {throw new Error('Unexpected failure');},
    };
    const read = (field: string) => field === 'decision' ? 'Renew' : null;
    const event = {trigger: 'decisionSubmitted', subjectId: 'case', occurrence: 'decision1', today: '2026-11-16', read, anchor: () => null, skipReason: () => null};
    const now = () => '2026-11-16T02:00:00Z';
    await runAutomationEvent({catalogue: C, workflows: [{workflow: wf(), revision: 1}], event, store, executors, now, newId: () => 'run1'});
    expect(calls).toEqual(['approval']);
    await resumeAutomationRuns({module: 'contract_staff', subjectId: 'case', documentId: 'approval-request', store, executors, read, now});
    expect(calls).toEqual(['approval', 'letter']);
    await resumeAutomationRuns({module: 'contract_staff', subjectId: 'case', documentId: 'letter', store, executors, read, now});
    expect(calls).toEqual(['approval', 'letter', 'posting']);
    await runAutomationEvent({catalogue: C, workflows: [{workflow: wf(), revision: 1}], event, store, executors, now, newId: () => 'run2'});
    expect(calls).toEqual(['approval', 'letter', 'posting']);
  });
});
