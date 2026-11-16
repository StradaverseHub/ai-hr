/**
 * Signing and review routing per template version (ADR 2026-11-15-probation-shared-automation, build step 3;
 * handoff A2, prototype TemplateEditor). Pure and dependency-light: storage, authorization and the choice of one group
 * member stay with their owners.
 *
 * A routing is a list of rows {order, action, who, owns the document}. Rows sharing an order act in parallel and the
 * document moves on when all of them are done. It is frozen into each generated document as its `SigningRoute`
 * (`resolveDocumentRouting`); documents already generated keep the chain they were created with.
 *
 * Backwards compatibility: an empty routing means "behave exactly as today" (the existing HR signature setting or, for
 * Probation, the existing letter signing route). Nothing here migrates any module's templates.
 *
 * Who → one person. For a Review, Approve or Sign step a routing or an assignment group yields ONE person, chosen by the
 * step's rule: `any` = any available member in member order (V9 `assign` with tie-break `memberOrder`), `roundRobin` =
 * the least recently assigned available member (V9 `assign` with tie-break `recent`). Named people with more than one
 * person behave like a small group. The caller injects that choice (`choose`), so leave, limits and open-task load keep
 * their single owner (lib/lifecycle-v9-model.ts `assign`). When nobody resolves, the configured fallback group takes the
 * step and the step records who it was meant for (`meantFor`); with no fallback member the step has no holder and blocks,
 * as a missing holder does today.
 */
import {resolveRoutingRow,type Routing,type RoutingFacts} from './automation/routing';
import type {SigningRoute,SigningStep} from './document-signing-model';

export const DOCUMENT_ROUTING_ACTIONS = ['review', 'approve', 'sign'] as const;
export type DocumentRoutingAction = typeof DOCUMENT_ROUTING_ACTIONS[number];
export type DocumentRoutingWho =
  | {kind: 'routing'; routingId: string}
  | {kind: 'group'; groupId: string}
  | {kind: 'people'; userIds: string[]}
  | {kind: 'employee'}
  | {kind: 'directSuperior'};
export type DocumentRoutingPick = 'any' | 'roundRobin';
export type DocumentRoutingStep = {id: string; order: number; action: DocumentRoutingAction; who: DocumentRoutingWho; owner: boolean; pick?: DocumentRoutingPick};
export type DocumentRouting = DocumentRoutingStep[];
export const MAX_DOCUMENT_ROUTING_STEPS = 30;
export const MAX_DOCUMENT_ROUTING_ORDER = 30;
export const MAX_DOCUMENT_ROUTING_PEOPLE = 50;
/** Signature blocks point at a Sign step: `role` holds `step:<step id>` (existing role-named blocks keep their role). */
export const SIGNATURE_STEP_PREFIX = 'step:';
export type DocumentRoutingBlock = {id: string; type: string; role?: string};
export type DocumentRoutingReferences = {routingExists: (id: string) => boolean; groupExists: (id: string) => boolean; personExists: (id: string) => boolean};

export function sortedDocumentRouting(routing: DocumentRouting): DocumentRoutingStep[] {
  return routing.map((step, index) => ({step, index})).sort((a, b) => a.step.order - b.step.order || a.index - b.index).map(x => x.step);
}
export function documentRoutingSignSteps(routing: DocumentRouting): DocumentRoutingStep[] {
  return sortedDocumentRouting(routing).filter(step => step.action === 'sign');
}
export function signatureBlockStepId(block: DocumentRoutingBlock): string | null {
  return block.type === 'signature' && block.role?.startsWith(SIGNATURE_STEP_PREFIX) ? block.role.slice(SIGNATURE_STEP_PREFIX.length) : null;
}
/** Position of a step in display order (1-based), for messages such as "Sign step 2". */
const position = (routing: DocumentRouting, step: DocumentRoutingStep) => sortedDocumentRouting(routing).indexOf(step) + 1;

/** Blocking problems for saving or publishing a routing. Empty means valid. An empty routing is valid (today's behaviour). */
export function documentRoutingProblems(routing: DocumentRouting, refs: DocumentRoutingReferences, policy: {requireSign?: boolean; requireOwner?: boolean} = {}): string[] {
  const problems: string[] = [];
  if (!routing.length) return problems;
  if (routing.length > MAX_DOCUMENT_ROUTING_STEPS) problems.push(`Use at most ${MAX_DOCUMENT_ROUTING_STEPS} steps.`);
  const ids = new Set<string>();
  routing.forEach(step => {
    const at = `Step ${position(routing, step)}: `;
    if (!step.id || ids.has(step.id) || step.id.length > 120) problems.push(at + 'each step needs its own id.');
    ids.add(step.id);
    if (!Number.isInteger(step.order) || step.order < 1 || step.order > MAX_DOCUMENT_ROUTING_ORDER) problems.push(at + `needs an order number from 1 to ${MAX_DOCUMENT_ROUTING_ORDER}.`);
    if (!(DOCUMENT_ROUTING_ACTIONS as readonly string[]).includes(step.action)) problems.push(at + 'choose Review, Approve or Sign.');
    if (step.pick !== undefined && step.pick !== 'any' && step.pick !== 'roundRobin') problems.push(at + 'choose any member or round robin.');
    const who = step.who;
    if (!who || !['routing', 'group', 'people', 'employee', 'directSuperior'].includes(who.kind)) problems.push(at + 'choose who acts at this step.');
    else if (who.kind === 'routing' && !refs.routingExists(who.routingId)) problems.push(at + 'the chosen routing no longer exists.');
    else if (who.kind === 'group' && !refs.groupExists(who.groupId)) problems.push(at + 'the chosen assignment group no longer exists.');
    else if (who.kind === 'people') {
      if (!who.userIds.length || who.userIds.length > MAX_DOCUMENT_ROUTING_PEOPLE || new Set(who.userIds).size !== who.userIds.length) problems.push(at + `choose between 1 and ${MAX_DOCUMENT_ROUTING_PEOPLE} people.`);
      else if (who.userIds.some(id => !refs.personExists(id))) problems.push(at + 'a chosen person can no longer be found.');
    }
  });
  if (policy.requireSign !== false && !routing.some(step => step.action === 'sign')) problems.push('At least one step must be a Sign step, or nobody signs the document.');
  if (routing.filter(step => step.owner).length > 1) problems.push('Only one step can own the document. Untick the others.');
  if (policy.requireOwner && routing.filter(step => step.owner).length === 0) problems.push('Tick the step that owns the document. Send-backs return to this step.');
  return problems;
}

/** The template editor's link checks: a Sign step with no signature block, and a signature block not linked to a step. */
export function documentRoutingSignatureProblems(routing: DocumentRouting, blocks: readonly DocumentRoutingBlock[]): string[] {
  const problems: string[] = [];
  if (!routing.length) return problems;
  const signatures = blocks.filter(block => block.type === 'signature'), signSteps = documentRoutingSignSteps(routing);
  for (const step of signSteps) if (!signatures.some(block => signatureBlockStepId(block) === step.id)) problems.push(`Sign step ${position(routing, step)} has no signature block, so that signature has nowhere to print. Add one in the content.`);
  blocks.forEach((block, index) => {
    if (block.type !== 'signature') return;
    const id = signatureBlockStepId(block);
    if (!id || !signSteps.some(step => step.id === id)) problems.push(`Signature block ${index + 1} is not linked to a signing step.`);
  });
  return problems;
}

export type DocumentRoutingResolveContext = {
  employeeUserId: string | null;
  directSuperiorUserId: string | null;
  /** Organisation facts that routings match on. */
  facts: RoutingFacts;
  routing: (id: string) => Routing | null;
  groupMembers: (groupId: string) => readonly string[] | null;
  /** Picks one person for a step (V9 `assign` semantics; see the module comment). `groupId` is null for named people. */
  choose: (candidates: readonly string[], rule: DocumentRoutingPick, groupId: string | null) => string | null;
  /** Why the last `choose` found nobody (for example everyone is on leave or at the open-task limit), when known. */
  choiceProblem?: () => string | null;
  fallback: {groupId: string; members: readonly string[]} | null;
  /** Plain description of a "who", recorded when the fallback takes a step. */
  describe: (who: DocumentRoutingWho) => string;
  /** Contract never delegates the employee's signature. Existing modules retain their own fallback policy. */
  holdMissingEmployee?: boolean;
};
export type DocumentRoutingUnresolved = {stepId: string; meantFor: string; reason: string; fallbackGroupId: string | null; holderId: string | null};

/** Candidates (and, for groups, the group they come from) that a "who" names for this employee. */
function candidatesFor(who: DocumentRoutingWho, ctx: DocumentRoutingResolveContext): {userIds: string[]; groupId: string | null; reason: string | null} {
  if (who.kind === 'employee') return ctx.employeeUserId ? {userIds: [ctx.employeeUserId], groupId: null, reason: null} : {userIds: [], groupId: null, reason: 'The employee has no sign-in.'};
  if (who.kind === 'directSuperior') return ctx.directSuperiorUserId ? {userIds: [ctx.directSuperiorUserId], groupId: null, reason: null} : {userIds: [], groupId: null, reason: 'No Direct Superior is recorded.'};
  if (who.kind === 'people') return {userIds: [...new Set(who.userIds)], groupId: null, reason: who.userIds.length ? null : 'Nobody is named.'};
  const groupMembers = (groupId: string) => { const members = ctx.groupMembers(groupId); return members ? {userIds: [...new Set(members)], groupId, reason: members.length ? null : 'The group has no members.'} : {userIds: [], groupId, reason: 'The group no longer exists.'}; };
  if (who.kind === 'group') return groupMembers(who.groupId);
  const routing = ctx.routing(who.routingId);
  if (!routing) return {userIds: [], groupId: null, reason: 'The routing no longer exists.'};
  const match = resolveRoutingRow(routing, ctx.facts);
  if (!match) return {userIds: [], groupId: null, reason: `No row of “${routing.name}” matches this employee.`};
  if (match.row.assignTo.kind === 'people') return {userIds: [...new Set(match.row.assignTo.userIds)], groupId: null, reason: match.row.assignTo.userIds.length ? null : `“${routing.name}” names nobody for this employee.`};
  return groupMembers(match.row.assignTo.groupId);
}

/**
 * Freezes a template version's routing into the route a generated document carries. Each step resolves to one holder;
 * unresolved steps go to the fallback group and are reported so the subject can record who they were meant for.
 */
export function resolveDocumentRouting(routing: DocumentRouting, ctx: DocumentRoutingResolveContext): {route: SigningRoute; unresolved: DocumentRoutingUnresolved[]} {
  const unresolved: DocumentRoutingUnresolved[] = [];
  const steps: SigningStep[] = sortedDocumentRouting(routing).map(step => {
    const rule = step.pick ?? 'any', candidates = candidatesFor(step.who, ctx);
    // The employee and the Direct Superior are fixed holders; only routings, groups and named people are assigned.
    const fixed = step.who.kind === 'employee' || step.who.kind === 'directSuperior';
    let holderId = candidates.userIds.length ? fixed ? candidates.userIds[0] : ctx.choose(candidates.userIds, rule, candidates.groupId) : null;
    let meantFor: string | undefined;
    if (!holderId) {
      meantFor = ctx.describe(step.who);
      const reason = candidates.reason ?? (candidates.userIds.length ? ctx.choiceProblem?.() : null) ?? 'Nobody available could take this step.';
      const heldEmployee = ctx.holdMissingEmployee && step.who.kind === 'employee';
      holderId = !heldEmployee && ctx.fallback?.members.length ? ctx.choose(ctx.fallback.members, rule, ctx.fallback.groupId) : null;
      unresolved.push({stepId: step.id, meantFor, reason, fallbackGroupId: heldEmployee ? null : ctx.fallback?.groupId ?? null, holderId});
    }
    const role = step.who.kind === 'employee' ? 'employee' : step.who.kind === 'directSuperior' ? 'lm' : step.who.kind === 'routing' ? `routing:${step.who.routingId}` : step.who.kind === 'group' ? `group:${step.who.groupId}` : 'people';
    return {id: step.id, role, kind: step.action, stage: step.order, holderId, required: true, ...(step.owner ? {owner: true} : {}), ...(meantFor ? {meantFor} : {})};
  });
  return {route: {version: 1, steps}, unresolved};
}
