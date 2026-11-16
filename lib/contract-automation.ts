/** Module-specific checks for the shared Contract builder, also enforced before saving Live. */
import {z} from 'zod';
import type {AutomationRecipient, AutomationReferences, AutomationWorkflow} from './automation/workflow';
import {CONTRACT_LETTER_TRIGGERS} from './automation/catalogues/contracts';

export const CONTRACT_POSTING_KINDS = ['Renewal', 'Conversion to permanent', 'Contract end'] as const;
const recipient = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('role'), role: z.enum(['employee', 'directSuperior'])}).strict(),
  z.object({kind: z.literal('routing'), routingId: z.uuid()}).strict(),
  z.object({kind: z.literal('group'), groupId: z.string().min(1).max(200)}).strict(),
  z.object({kind: z.literal('person'), userId: z.uuid()}).strict(),
]);
export const contractApprovalLayersSchema = z.array(z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(100), approver: recipient,
  pick: z.enum(['any', 'roundRobin']),
}).strict()).min(1).max(30).refine(rows => new Set(rows.map(row => row.id)).size === rows.length, 'Approval layers need unique identities.');
export type ContractApprovalLayer = z.infer<typeof contractApprovalLayersSchema>[number];
export type ContractStepReferences = {
  emailTemplates: readonly {id: string; active: boolean; retired: boolean}[];
  letterTemplateIds: readonly string[] | null;
};
export function contractWorkflowRecipients(workflow: AutomationWorkflow): AutomationRecipient[] {
  return workflow.steps.flatMap(step => {
    const layers = step.type === 'requestApproval' ? contractApprovalLayersSchema.safeParse(step.params.layers) : null;
    return [...step.to, ...step.cc, ...(layers?.success ? layers.data.map(row => row.approver) : [])];
  });
}
export function contractStepParamProblems(workflow: AutomationWorkflow, refs: ContractStepReferences, recipients?: AutomationReferences, policy:{skipUnavailableEmails?:boolean}={}): string[] {
  const problems: string[] = [];
  if (workflow.module !== 'contract_staff') return problems;
  const letterTrigger = (CONTRACT_LETTER_TRIGGERS as readonly string[]).includes(workflow.trigger.event);
  if (!Number.isInteger(workflow.trigger.days) || workflow.trigger.days < 0 || workflow.trigger.days > 365) problems.push('Contract date offsets must be between 0 and 365 days.');
  workflow.steps.forEach((step, i) => {
    const at = `Step ${i + 1}: `;
    if (!letterTrigger && [...step.to, ...step.cc].some(r => r.kind === 'pending')) problems.push(at + 'Whoever’s step is pending is available only for letter triggers.');
    if (step.type === 'notify') {
      if (typeof step.params.subject !== 'string' || !step.params.subject.trim()) problems.push(at + 'add an email subject.');
      if (typeof step.params.body !== 'string' || !step.params.body.trim()) problems.push(at + 'write the message.');
      if (!step.to.length) problems.push(at + 'choose who receives the notification.');
    } else if (step.type === 'sendEmail') {
      if (!policy.skipUnavailableEmails&&!refs.emailTemplates.some(t => t.id === step.params.emailTemplateId && !t.retired)) problems.push(at + 'choose an available email template.');
      if (!step.to.length) problems.push(at + 'choose who receives the email.');
    } else if (step.type === 'generateDocument') {
      if (typeof step.params.letterTemplateId !== 'string' || !step.params.letterTemplateId || refs.letterTemplateIds !== null && !refs.letterTemplateIds.includes(step.params.letterTemplateId)) problems.push(at + 'choose an available document template.');
    } else if (step.type === 'createPosting') {
      if (!(CONTRACT_POSTING_KINDS as readonly unknown[]).includes(step.params.eventType)) problems.push(at + 'choose Renewal, Conversion to permanent or Contract end.');
    } else if (step.type === 'requestApproval') {
      const layers = contractApprovalLayersSchema.safeParse(step.params.layers);
      if (!layers.success) problems.push(at + 'complete every approval layer, approver and member selection.');
      else if (recipients) for (const layer of layers.data) {
        const who = layer.approver;
        if (who.kind === 'routing' && !recipients.routingExists(who.routingId) || who.kind === 'group' && !recipients.groupExists(who.groupId) || who.kind === 'person' && !recipients.personExists(who.userId)) problems.push(at + `${layer.name}: the approver reference is unavailable.`);
      }
    }
    if ('sender' in step.params || 'sendFrom' in step.params) problems.push(at + 'Contract email is sent from OneHR only.');
  });
  return problems;
}
export function contractWorkflowWarnings(workflow: AutomationWorkflow): string[] {
  if (workflow.module !== 'contract_staff' || !['decisionSubmitted', 'employeeDeclined'].includes(workflow.trigger.event)) return [];
  return workflow.steps.some(step => ['createPosting', 'startOffboarding'].includes(step.type)) ? [] : ['This decision workflow never reaches Personnel Management or Offboarding.'];
}
