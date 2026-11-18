/**
 * One person for a routed Review, Approve or Sign step (ADR 2026-11-15-probation-shared-automation, build steps 2-3;
 * handoff A2/A3; lane F2). The choice is the V9 assignment owner's (lib/lifecycle-v9-model.ts `assign`): eligible
 * (active) members only, nobody on approved leave today, nobody at the group's open-task limit, then the lowest open
 * load; ties go to the least recently assigned member (`roundRobin`, V9 tie-break `recent`) or to member order (`any`,
 * V9 tie-break `memberOrder`). Named people behave like a small group without a limit. Each choice counts towards the
 * next one within the same document, as V9 counts tasks assigned in one submission.
 *
 * The facts come from app.probation_assignment_facts (migration 5755): open load is the unfinished steps a person
 * holds on open Probation documents; "last assigned" is their latest routing, group or named-people step.
 */
import {assign,type Config,type Environment} from './lifecycle-v9-model';
import type {DocumentRoutingPick} from './document-signing-routing';

export type RoutedAssignmentFacts = {
  today: string;
  groups: {id: string; name: string; limit: number; members: string[]}[];
  users: {id: string; load: number; lastAssigned: string | null; onLeave: boolean}[];
};
export type RoutedStepChooser = {
  choose: (candidates: readonly string[], rule: DocumentRoutingPick, groupId: string | null) => string | null;
  /** Why the last choice found nobody (V9's reason), or null. */
  problem: () => string | null;
  available:(userId:string)=>boolean;
};
export function routedStepChooser(facts: RoutedAssignmentFacts): RoutedStepChooser {
  const users = new Map(facts.users.map(user => [user.id, user])), extra: Record<string, number> = {};
  let problem: string | null = null;
  const environment: Pick<Environment, 'eligibleUser' | 'onLeave' | 'openLoad' | 'lastAssigned'> = {
    eligibleUser: id => users.has(id),
    onLeave: id => users.get(id)?.onLeave ?? false,
    openLoad: id => Number(users.get(id)?.load ?? 0),
    lastAssigned: id => { const at = users.get(id)?.lastAssigned; return at ? Date.parse(at) || 0 : 0; },
  };
  return {
    choose(candidates, rule, groupId) {
      const known = groupId ? facts.groups.find(group => group.id === groupId) : undefined;
      const group = {id: groupId ?? 'named-people', name: known?.name ?? 'the named people', members: [...candidates], limit: known?.limit ?? 0};
      const result = assign({groups: [group]} as unknown as Config, group.id, facts.today, environment as Environment, extra, rule === 'roundRobin' ? 'recent' : 'memberOrder');
      problem = result.reason;
      if (result.userId) extra[result.userId] = (extra[result.userId] ?? 0) + 1;
      return result.userId;
    },
    problem: () => problem,
    available:userId=>users.has(userId)&&!users.get(userId)?.onLeave,
  };
}
