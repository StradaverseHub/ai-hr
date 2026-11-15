/**
 * Signing and review routing on Probation letter template versions (handoff A2; lane D1). Entry points for the letter
 * flow; the storage change is lane D2's.
 *
 * A letter template version is stored by core/probation-letter.ts in probation_builder_definition. Its strict schema
 * does not accept a `routing` field yet, so this file cannot persist a routing without editing that file. Until lane D2
 * adds `routing: probationLetterRoutingSchema.optional()` to the template schema (and the checks below to its
 * validation) and sets PROBATION_LETTER_ROUTING_STORED, a template with an empty routing saves exactly as today and a
 * non-empty routing is refused with a plain message instead of being dropped silently.
 */
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {automationReferencesTx} from './automation-builder';
import {ProbationError} from '../lib/probation-model';
import type {ProbationTemplate} from '../lib/probation-workflow';
import {saveProbationLetterTemplate} from './probation-letter';
import {DOCUMENT_ROUTING_ACTIONS,MAX_DOCUMENT_ROUTING_ORDER,MAX_DOCUMENT_ROUTING_PEOPLE,MAX_DOCUMENT_ROUTING_STEPS,documentRoutingProblems,documentRoutingSignatureProblems,type DocumentRouting} from '../lib/document-signing-routing';

/** Lane D2 sets this once core/probation-letter.ts stores `routing` with each template version. */
export const PROBATION_LETTER_ROUTING_STORED = false;

const id = z.string().min(1).max(120);
/** Shape of the routing on a template version; lane D2 adds it to the letter template schema. */
export const probationLetterRoutingSchema = z.array(z.object({
  id, order: z.number().int().min(1).max(MAX_DOCUMENT_ROUTING_ORDER), action: z.enum(DOCUMENT_ROUTING_ACTIONS), owner: z.boolean(),
  pick: z.enum(['any', 'roundRobin']).optional(),
  who: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('routing'), routingId: z.uuid()}).strict(),
    z.object({kind: z.literal('group'), groupId: z.string().min(1).max(200)}).strict(),
    z.object({kind: z.literal('people'), userIds: z.array(z.uuid()).min(1).max(MAX_DOCUMENT_ROUTING_PEOPLE)}).strict(),
    z.object({kind: z.literal('employee')}).strict(),
    z.object({kind: z.literal('directSuperior')}).strict(),
  ]),
}).strict()).max(MAX_DOCUMENT_ROUTING_STEPS);

export type ProbationRoutedTemplate = ProbationTemplate & {routing?: DocumentRouting};
export function probationTemplateRouting(template: Pick<ProbationRoutedTemplate, 'routing'>): DocumentRouting { return template.routing ?? []; }

/** Every routing problem of a template version: rows against current routings, groups and people, and signature links. */
export function probationLetterRoutingProblems(ctx: SessionContext, template: ProbationRoutedTemplate): Promise<string[]> {
  const routing = probationTemplateRouting(template);
  if (!routing.length) return Promise.resolve([]);
  const parsed = probationLetterRoutingSchema.safeParse(routing);
  if (!parsed.success) return Promise.resolve(['Complete every step of the signing and review routing.']);
  const people = [...new Set(routing.flatMap(step => step.who.kind === 'people' ? step.who.userIds : []))];
  return withScopedLifecycleTenant(ctx, async tx => {
    const refs = await automationReferencesTx(tx, people);
    return [...documentRoutingProblems(routing, refs), ...documentRoutingSignatureProblems(routing, template.blocks)];
  });
}

/**
 * Saves a letter template version through the existing Probation service. An empty routing is removed so the version
 * saves exactly as today; a non-empty routing is checked and, until lane D2 stores it, refused.
 */
export async function saveProbationLetterTemplateWithRouting(ctx: SessionContext, input: {companyId: string; template: ProbationRoutedTemplate; publish: boolean; expectedVersion: number}): Promise<string> {
  const {routing, ...template} = input.template;
  if (!routing?.length) return saveProbationLetterTemplate(ctx, {...input, template});
  const problems = await probationLetterRoutingProblems(ctx, input.template);
  if (problems.length) throw new ProbationError('invalid', problems[0]);
  if (!PROBATION_LETTER_ROUTING_STORED) throw new ProbationError('invalid', 'Signing and review routing cannot be saved yet. Remove the routing steps to save this version with the signing route below.');
  return saveProbationLetterTemplate(ctx, {...input, template: input.template});
}
