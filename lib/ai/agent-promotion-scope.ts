/** WP11 (R5; ADR-0151 §4.6d, migration 0695): who an approved Assistant promotion applies to. The approver
 * chooses. 'user' is the candidate owner only (every promotion before WP11); 'company' is every current
 * employee of one company subtree; 'tenant' is every login of the tenant. Pure constants, browser-safe. */
export const AGENT_PROMOTION_SCOPES=Object.freeze(['user','company','tenant'] as const);
export type AgentPromotionScope=typeof AGENT_PROMOTION_SCOPES[number];
export const isAgentPromotionScope=(value:unknown):value is AgentPromotionScope=>typeof value==='string'&&(AGENT_PROMOTION_SCOPES as readonly string[]).includes(value);
