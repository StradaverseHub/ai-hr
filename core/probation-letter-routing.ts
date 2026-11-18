/**
 * Signing and review routing on Probation letter template versions (handoff A2; lane D1). Entry points for the letter
 * flow; the storage change is lane D2's.
 *
 * A letter template version is stored by core/probation-letter.ts in probation_builder_definition. Its strict schema
 * does not accept a `routing` field yet, so this file cannot persist a routing without editing that file. Until lane D2
 * adds `routing: documentRoutingSchema.optional()` (lib/document-signing-routing-schema.ts) to the template schema (and the checks below to its
 * validation) and sets PROBATION_LETTER_ROUTING_STORED, a template with an empty routing saves exactly as today and a
 * non-empty routing is refused with a plain message instead of being dropped silently.
 */
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {automationReferencesTx} from './automation-builder';
import {ProbationError} from '../lib/probation-model';
import type {ProbationTemplate} from '../lib/probation-workflow';
import {saveProbationLetterTemplate,probationNativeRoutingReferencesTx} from './probation-letter';
import {documentRoutingProblems,documentRoutingSignatureProblems,type DocumentRouting} from '../lib/document-signing-routing';
import {documentRoutingSchema,nativeDocumentRoutingSchema} from '../lib/document-signing-routing-schema';

/** core/probation-letter.ts stores `routing` with each template version (lane D2, migration 5752). */
export const PROBATION_LETTER_ROUTING_STORED = true;

/** Shape of the routing on a template version; lane D2 adds it to the letter template schema (import it from lib to avoid a cycle). */
export const probationLetterRoutingSchema = documentRoutingSchema;

export type ProbationRoutedTemplate = ProbationTemplate & {routing?: DocumentRouting};
export function probationTemplateRouting(template: Pick<ProbationRoutedTemplate, 'routing'>): DocumentRouting { return template.routing ?? []; }

/** Every routing problem of a template version: rows against current routings, groups and people, and signature links. */
export function probationLetterRoutingProblems(ctx: SessionContext, template: ProbationRoutedTemplate,companyId?:string): Promise<string[]> {
  const routing = probationTemplateRouting(template);
  if (!routing.length) return Promise.resolve([]);
  const parsed = (template.routingRegistry==='on-off-boarding'?nativeDocumentRoutingSchema:probationLetterRoutingSchema).safeParse(routing);
  if (!parsed.success) return Promise.resolve(['Complete every step of the signing and review routing.']);
  const people = [...new Set(routing.flatMap(step => step.who.kind === 'people' ? step.who.userIds : []))];
  return withScopedLifecycleTenant(ctx, async tx => {
    const refs = template.routingRegistry==='on-off-boarding'&&companyId?await probationNativeRoutingReferencesTx(tx,companyId,people):await automationReferencesTx(tx, people);
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
  const problems = await probationLetterRoutingProblems(ctx, input.template,input.companyId);
  if (problems.length) throw new ProbationError('invalid', problems[0]);
  if (!PROBATION_LETTER_ROUTING_STORED) throw new ProbationError('invalid', 'Signing and review routing cannot be saved yet. Remove the routing steps to save this version with the signing route below.');
  return saveProbationLetterTemplate(ctx, {...input, template: input.template});
}
