/** ADR-0151 §4.4. More autonomous execution requires an explicitly reviewed ceiling. */
export type AgentTier='automatic'|'confirm'|'approve'|'handoff';
export const NEVER_AUTOMATIC_CATEGORIES=Object.freeze([
 'pay','claim_money','approvals','access','terminations','ratings','hiring','promotion','discipline','payroll',
] as const);
export type NeverAutomaticCategory=(typeof NEVER_AUTOMATIC_CATEGORIES)[number];
export type AgentActionCategory=NeverAutomaticCategory|'own_work'|'personnel'|'read'|'reminder'|'chaser';
/** The only categories an Automatic tier may ever carry (app.assistant_action_kind enforces the same rule). */
export const AUTOMATIC_CATEGORIES=Object.freeze(['read','reminder','chaser'] as const);
type AutomaticCategory=(typeof AUTOMATIC_CATEGORIES)[number];
export type AgentActionPolicy=
 | Readonly<{category:NeverAutomaticCategory;tier:Exclude<AgentTier,'automatic'>}>
 | Readonly<{category:Exclude<AgentActionCategory,NeverAutomaticCategory>;tier:Exclude<AgentTier,'automatic'>}>
 | Readonly<{category:AutomaticCategory;tier:'automatic'}>;
const authority:Record<AgentTier,number>={handoff:0,approve:1,confirm:2,automatic:3};
export function assertAgentTierPolicy(policy:AgentActionPolicy,requested:AgentTier):void {
 if(!policy||!Object.hasOwn(authority,policy.tier)||!Object.hasOwn(authority,requested)
  ||policy.tier==='handoff'||requested==='handoff'||authority[requested]>authority[policy.tier]
  ||(policy.tier==='automatic'&&((NEVER_AUTOMATIC_CATEGORIES as readonly string[]).includes(policy.category)
   ||!(AUTOMATIC_CATEGORIES as readonly string[]).includes(policy.category))))
  throw new Error('Agent action tier unavailable');
}
