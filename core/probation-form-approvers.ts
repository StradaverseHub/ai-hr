/**
 * Routed approvers on Probation form parts (lane G1, migration 5756; handoff B3, owner mockup screen 10).
 *
 * A form version's approval row may name a shared routing, an assignment group or named people. When the Line Manager
 * submits (the moment the Part's route is frozen from the case's pinned form version, app.probation_prepare_signing),
 * each such step gets ONE person, chosen by the step's rule through the V9 assignment owner
 * (lib/routed-step-assignment.ts: nobody on leave today, nobody at the group's open-task limit, lowest open load, then
 * round robin or member order). Nobody available → the case's fallback group takes the step, chosen the same way, and the
 * Part records who it was meant for and why. The database freezes each choice as a probation_delegate row of kind
 * missing_holder (app.probation_form_freeze_approvers), so the case view, the work queues, visibility, per-part
 * replacement and general Probation delegation treat the person exactly as an assigned GBS signer. A step keeps its
 * person for the Part: resubmitting after a return only fills steps that nobody holds.
 */
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {routedStepPeople,type Routing} from '../lib/automation/routing';
import {resolveDocumentRouting,type DocumentRouting,type DocumentRoutingWho} from '../lib/document-signing-routing';
import {routedStepChooser,type RoutedAssignmentFacts} from '../lib/routed-step-assignment';

type FormRoutingContext = {
  steps: {id: string; who: string; pick: 'any' | 'roundRobin'; userIds: string[]}[];
  employeeUserId: string | null; directSuperiorUserId: string | null; fallbackGroupId: string | null;
  facts: {businessGroup: string | null; businessGroupCompany: string | null; company: string | null; department: string | null; jobTitle: string | null};
  routings: Routing[]; groups: {id: string; name: string; members: string[]}[];
};
export type FormApproverChoice = {stepId: string; holderId: string | null; meantFor?: string; reason?: string};

/** The routed "who" of a form row as the shared document routing reads it. */
export function formApproverWho(who: string, userIds: readonly string[]): DocumentRoutingWho | null {
  if (who === 'people') return {kind: 'people', userIds: [...userIds]};
  if (who.startsWith('routing:')) return {kind: 'routing', routingId: who.slice(8)};
  if (who.startsWith('group:')) return {kind: 'group', groupId: who.slice(6)};
  return null;
}

/** Plain description of who a step was meant for, recorded when the fallback group takes it (no personal data). */
function describe(who: DocumentRoutingWho, context: FormRoutingContext): string {
  if (who.kind === 'routing') return `The routing “${context.routings.find(r => r.id === who.routingId)?.name ?? 'removed routing'}”`;
  if (who.kind === 'group') return `The assignment group “${context.groups.find(g => g.id === who.groupId)?.name ?? who.groupId}”`;
  return 'The named people';
}

/** Chooses one person for each routed step of this Part that nobody holds yet and freezes the choices. */
export async function freezeFormApproversTx(tx: Tx, partId: string, caseId: string): Promise<FormApproverChoice[]> {
  const [row] = await tx.execute<{data: FormRoutingContext}>(sql`select app.probation_form_routing_context(${partId}::uuid) as data`);
  const context = row?.data;
  if (!context?.steps?.length) return [];
  const routing: DocumentRouting = context.steps.flatMap((step, index) => {
    const who = formApproverWho(step.who, Array.isArray(step.userIds) ? step.userIds : []);
    return who ? [{id: step.id, order: index + 1, action: 'approve' as const, who, owner: false, pick: step.pick === 'roundRobin' ? 'roundRobin' as const : 'any' as const}] : [];
  });
  if (!routing.length) return [];
  const groups = new Map(context.groups.map(group => [group.id, group.members])), routings = new Map(context.routings.map(r => [r.id, r]));
  // I8: people named on the matching row of a routing count too, not only people named on the step.
  const routingFacts = {businessGroup: [context.facts.businessGroup, context.facts.businessGroupCompany].filter((v): v is string => !!v), company: context.facts.company, department: context.facts.department, jobTitle: context.facts.jobTitle};
  const people = routedStepPeople(routing, id => routings.get(id) ?? null, routingFacts);
  const [facts] = await tx.execute<{data: RoutedAssignmentFacts}>(sql`select app.probation_assignment_facts(${caseId}::uuid,${`{${[...groups.keys()].map(id => '"' + id.replace(/["\\]/g, '') + '"').join(',')}}`}::text[],${`{${[...new Set(people)].join(',')}}`}::uuid[]) as data`);
  const chooser = routedStepChooser(facts.data);
  const fallbackMembers = context.fallbackGroupId ? groups.get(context.fallbackGroupId) ?? [] : [];
  const resolved = resolveDocumentRouting(routing, {
    employeeUserId: context.employeeUserId, directSuperiorUserId: context.directSuperiorUserId,
    facts: {businessGroup: [context.facts.businessGroup, context.facts.businessGroupCompany].filter((v): v is string => !!v), company: context.facts.company, department: context.facts.department, jobTitle: context.facts.jobTitle},
    routing: id => routings.get(id) ?? null, groupMembers: id => groups.get(id) ?? null, choose: chooser.choose, choiceProblem: chooser.problem,
    fallback: context.fallbackGroupId ? {groupId: context.fallbackGroupId, members: fallbackMembers} : null,
    describe: who => describe(who, context),
  });
  const unresolved = new Map(resolved.unresolved.map(item => [item.stepId, item]));
  const choices: FormApproverChoice[] = resolved.route.steps.map(step => {
    const missed = unresolved.get(step.id);
    return missed ? {stepId: step.id, holderId: missed.holderId, meantFor: missed.meantFor.slice(0, 300), reason: missed.reason.slice(0, 300)} : {stepId: step.id, holderId: step.holderId};
  });
  await tx.execute(sql`select app.probation_form_freeze_approvers(${partId}::uuid,${JSON.stringify(choices)}::jsonb)`);
  return choices;
}
