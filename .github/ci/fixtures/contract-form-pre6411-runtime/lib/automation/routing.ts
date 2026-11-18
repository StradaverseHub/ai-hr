/**
 * Shared routing rules (ADR 2026-11-15-probation-shared-automation, build step 2; handoff A3).
 *
 * A routing ("BP by business group", "HOD by business group and department") finds who acts for an employee. Each row
 * matches on business group, company, department and job title; an empty dimension matches everyone and several values
 * in one dimension are alternatives. The most specific matching row wins; equally specific rows keep list order.
 * A row assigns to an assignment group or to named people.
 *
 * Specificity keeps the V9 PBP rule's order exactly (business group over company over department, then list order;
 * `lib/lifecycle-v9-model.ts` resolvePbp) and adds job title as the finest dimension, so a converted `bpRules` list
 * resolves to the same person it does today.
 *
 * How a match becomes people depends on where the routing is used (state this in the UI):
 *  - in an approval or signing step it yields ONE person, chosen by that step's rule (any member or round robin);
 *  - as a To or CC recipient it yields EVERYONE in the matched group or list.
 * Pure: choosing one member uses the caller's existing assignment owner (V9 `assign`, leave and open-task limits).
 */
export const ROUTING_DIMENSIONS = ['businessGroup', 'company', 'department', 'jobTitle'] as const;
export type RoutingDimension = typeof ROUTING_DIMENSIONS[number];
export type RoutingMatch = Partial<Record<RoutingDimension, string[]>>;
export type RoutingTarget = { kind: 'group'; groupId: string } | { kind: 'people'; userIds: string[] };
export type RoutingRow = { match: RoutingMatch; assignTo: RoutingTarget };
export type Routing = { id: string; name: string; rows: RoutingRow[] };
/**
 * The employee's value per dimension. A module may give several identities of one value (for example a business group as
 * its business unit id and its group company id, or an id and a name saved before ids); a row matches when it names any.
 */
export type RoutingFacts = Partial<Record<RoutingDimension, string | readonly string[] | null>>;

const WEIGHT: Record<RoutingDimension, number> = { businessGroup: 8, company: 4, department: 2, jobTitle: 1 };
export const MAX_ROUTING_ROWS = 500;
export const MAX_ROUTING_PEOPLE = 50;

export function routingRowMatches(row: RoutingRow, facts: RoutingFacts): boolean {
  return ROUTING_DIMENSIONS.every(dimension => {
    const values = row.match[dimension], fact = facts[dimension];
    if (!values?.length) return true;
    return (typeof fact === 'string' || fact === null || fact === undefined ? [fact ?? ''] : fact).some(value => values.includes(value));
  });
}
export function routingRowSpecificity(row: RoutingRow): number {
  return ROUTING_DIMENSIONS.reduce((total, dimension) => total + (row.match[dimension]?.length ? WEIGHT[dimension] : 0), 0);
}
/** The winning row for an employee, or null when no row matches (the caller then uses the fallback group). */
export function resolveRoutingRow(routing: Routing, facts: RoutingFacts): { row: RoutingRow; index: number } | null {
  let best: { row: RoutingRow; index: number; score: number } | null = null;
  routing.rows.forEach((row, index) => {
    if (!routingRowMatches(row, facts)) return;
    const score = routingRowSpecificity(row);
    if (!best || score > best.score) best = { row, index, score };
  });
  const winner = best as { row: RoutingRow; index: number; score: number } | null;
  return winner ? { row: winner.row, index: winner.index } : null;
}

/**
 * The people a routed approval or signing step may choose (I8): those named on the step itself, and those named on the
 * matching row of a routing the step uses. The assignment owner's eligibility facts must include them, or a row that
 * names people never resolves. Group rows need nothing here: every group's members are already in the facts.
 */
export function routedStepPeople(steps: readonly {who: {kind: string; userIds?: readonly string[]; routingId?: string}}[], routing: (id: string) => Routing | null, facts: RoutingFacts): string[] {
  const people = new Set<string>();
  for (const step of steps) {
    if (step.who.kind === 'people') for (const id of step.who.userIds ?? []) people.add(id);
    if (step.who.kind === 'routing' && step.who.routingId) {
      const found = routing(step.who.routingId), match = found ? resolveRoutingRow(found, facts) : null;
      if (match?.row.assignTo.kind === 'people') for (const id of match.row.assignTo.userIds) people.add(id);
    }
  }
  return [...people].slice(0, 200);
}
/** Everyone the routing reaches as a recipient: all members of the matched group, or all named people. */
export function routingRecipients(routing: Routing, facts: RoutingFacts, groupMembers: (groupId: string) => readonly string[] | null, options: {defaultOnEmpty?: boolean} = {}): { userIds: string[]; missing: string | null } {
  const resolved=resolveRoutingTarget(routing,facts,groupMembers,options);
  return {userIds:resolved.userIds,missing:resolved.missing};
}
/** The same recipient resolution with the winning group retained for an approval's membership and pick policy. */
export function resolveRoutingTarget(routing: Routing, facts: RoutingFacts, groupMembers: (groupId: string) => readonly string[] | null, options: {defaultOnEmpty?: boolean} = {}): {userIds:string[];missing:string|null;groupId:string|null} {
  const match = resolveRoutingRow(routing, facts);
  if (!match) return { userIds: [], missing: `No row of “${routing.name}” matches this employee.`,groupId:null };
  const resolve = (row: RoutingRow): {userIds: string[]; missing: string | null;groupId:string|null} => {
    if (row.assignTo.kind === 'people') return row.assignTo.userIds.length ? {userIds: [...new Set(row.assignTo.userIds)], missing: null,groupId:null} : {userIds: [], missing: `“${routing.name}” names nobody for this employee.`,groupId:null};
    const members = groupMembers(row.assignTo.groupId);
    if (!members) return {userIds: [], missing: `The group chosen in “${routing.name}” no longer exists.`,groupId:row.assignTo.groupId};
    return members.length ? {userIds: [...new Set(members)], missing: null,groupId:row.assignTo.groupId} : {userIds: [], missing: `The group chosen in “${routing.name}” has no members.`,groupId:row.assignTo.groupId};
  };
  const result = resolve(match.row);
  // Contract's explicit default is the last resort inside the routing, before the module fallback group.
  // Do not try a different, less-specific business rule or change existing consumers' matching semantics.
  if (result.userIds.length || !options.defaultOnEmpty || routingRowSpecificity(match.row) === 0) return result;
  const defaultRow = routing.rows.find(row => routingRowSpecificity(row) === 0);
  return defaultRow ? resolve(defaultRow) : result;
}

/** Save-time problems for a routing. Empty means valid. */
export function routingProblems(routing: Routing, groupExists: (groupId: string) => boolean): string[] {
  const problems: string[] = [];
  if (!routing.name.trim()) problems.push('Name this routing.');
  if (routing.rows.length > MAX_ROUTING_ROWS) problems.push(`A routing can have at most ${MAX_ROUTING_ROWS} rows.`);
  routing.rows.forEach((row, i) => {
    const at = `Row ${i + 1}: `;
    for (const key of Object.keys(row.match)) if (!(ROUTING_DIMENSIONS as readonly string[]).includes(key)) problems.push(at + `unknown match ${key}.`);
    if (row.assignTo.kind === 'group' && !groupExists(row.assignTo.groupId)) problems.push(at + 'choose an existing assignment group.');
    if (row.assignTo.kind === 'people' && (row.assignTo.userIds.length === 0 || row.assignTo.userIds.length > MAX_ROUTING_PEOPLE)) problems.push(at + `choose between 1 and ${MAX_ROUTING_PEOPLE} people.`);
  });
  return problems;
}

/** The V9 `bpRules` list as the routing "BP by business group", unchanged in meaning. */
export function routingFromV9BpRules(bpRules: readonly { rules: { businessGroup?: string[]; company?: string[]; department?: string[] }; userId: string }[], id = 'bp-by-business-group', name = 'BP by business group'): Routing {
  return { id, name, rows: bpRules.map(rule => ({ match: { businessGroup: rule.rules.businessGroup, company: rule.rules.company, department: rule.rules.department }, assignTo: { kind: 'people', userIds: [rule.userId] } })) };
}
