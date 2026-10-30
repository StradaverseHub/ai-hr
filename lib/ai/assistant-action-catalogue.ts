/** ADR-0151 §4.3 and §4.6a, review R6 — the chat's action-proposal catalogue, DERIVED from the agent action
 * registry and filtered per caller. Pure and browser-safe: no session, database, provider or effect.
 *
 * What a chat answer may propose = caller authority ∩ registry ∩ tier ∩ switches and pauses:
 *   registry   an AGENT_ACTIONS entry whose prepare and confirm phases are implemented and that has an inline
 *              chat card (a typed hint shape in assistant-action-proposal-hints.ts);
 *   tier       Confirm or Approve only. Automatic never needs a chat card and Handoff is a link, never a card;
 *   authority  the caller can currently read the action's module and holds its actor class (offering only:
 *              the guarded choices, prepare and confirm paths re-check the caller's real authority);
 *   switches   the action's pause key is not paused for this caller (read fresh by the caller's owner).
 *
 * The catalogue is computed by code from the registry and the caller's own session facts. Nothing a model,
 * a record or a tool result says can add an entry, widen it or change a tier: there is no input for it.
 *
 * Confirmation is NOT here and never will be. A proposal is a suggestion sealed in the exchange record; the
 * person prepares and confirms on the card through the existing separate same-origin, digest-bound command.
 *
 * Prompt caching: the catalogue block varies per caller, so it is appended AFTER the constant system prefix
 * and the caller's strategy block (lib/ai/assistant-conversation-system.ts), and lists actions in registry
 * order so one caller's prefix stays byte-stable between questions.
 */
import {AGENT_ACTIONS,agentActionPauseKey,type AgentAction,type AgentActionActor,type AgentActionPauseKey,type AgentActionOwnPauseKey} from './agent-action-registry';
import type {AgentTier} from './agent-action-tiers';
import {AGENT_MODULE_CODES,type AgentModuleCode} from './module-agents';
import {ASSISTANT_PROPOSAL_HINT_KEYS,isAssistantProposableAction,type AssistantProposableAction} from './assistant-action-proposal-hints';

/** Tiers that can be proposed as an inline card. Automatic and Handoff never are. */
export const CHAT_PROPOSABLE_TIERS=Object.freeze(['confirm','approve'] as const satisfies readonly AgentTier[]);
/** Every actor class in the registry's permission union. The type check below fails if the union grows. */
export const AGENT_ACTION_ACTORS=Object.freeze(['lifecycle_staff','self','assigned_approver','hr_admin','workforce_maintainer','tenant_admin','payroll_admin','rewards_admin','assigned_tester','agent_principal'] as const satisfies readonly AgentActionActor[]);
type MissingActor=Exclude<AgentActionActor,typeof AGENT_ACTION_ACTORS[number]>;
const actorsAreExhaustive:[MissingActor] extends [never]?true:never=true;void actorsAreExhaustive;

/** The current caller's facts, built by the caller's own session owner (core/assistant-action-catalogue.ts),
 * never posted by a browser or produced by a model. */
export type AssistantProposalCaller=Readonly<{
 readableModules:readonly AgentModuleCode[];
 actors:readonly AgentActionActor[];
 pausedKeys:readonly (AgentActionPauseKey|AgentActionOwnPauseKey)[];
}>;
/** A caller that may propose nothing: the fail-closed value whenever current facts cannot be read. */
export const CLOSED_PROPOSAL_CALLER:AssistantProposalCaller=Object.freeze({readableModules:Object.freeze([]),actors:Object.freeze([]),pausedKeys:Object.freeze([])});

/** Registry entries with an inline chat card, in registry order. Load-time constant. */
export const ASSISTANT_CHAT_ACTIONS:readonly AgentAction[]=Object.freeze(AGENT_ACTIONS.filter(action=>
 isAssistantProposableAction(action.id)&&action.prepare.status==='implemented'&&action.confirm.status==='implemented'
 &&action.store!=='human_workflow_only'&&(CHAT_PROPOSABLE_TIERS as readonly string[]).includes(action.policy.tier)));
/** Distinct pause keys the chat catalogue depends on (what the caller's owner must read fresh). */
export const ASSISTANT_CHAT_PAUSE_KEYS:readonly AgentActionPauseKey[]=Object.freeze([...new Set(ASSISTANT_CHAT_ACTIONS.map(action=>action.pauseKey))]);

function strings(value:unknown):ReadonlySet<string>|null{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return null;
 const out=new Set<string>();for(const item of value){if(typeof item!=='string')return null;out.add(item);}return out;
}
/** The actions this caller may be offered and may propose, in registry order. Malformed facts offer nothing. */
export function assistantProposalCatalogue(caller:unknown):readonly AssistantProposableAction[]{
 if(caller===null||typeof caller!=='object')return Object.freeze([]);
 const facts=caller as Record<string,unknown>,readable=strings(facts.readableModules),actors=strings(facts.actors),paused=strings(facts.pausedKeys);
 if(!readable||!actors||!paused)return Object.freeze([]);
 return Object.freeze(ASSISTANT_CHAT_ACTIONS.filter(action=>readable.has(action.module)&&actors.has(action.permission.actor)&&!paused.has(action.pauseKey)&&!paused.has(agentActionPauseKey(action)))
  .map(action=>action.id as AssistantProposableAction));
}

/** The per-caller catalogue as one system block. Only registry ids and hint keys: no user, tenant, locale or
 * clock bytes. An empty catalogue says so, so a model cannot infer one from earlier conversations. */
export function assistantProposalCatalogueBlock(actions:readonly AssistantProposableAction[]):string{
 const offered=actions.filter(isAssistantProposableAction);
 return offered.length===0
  ?'Proposable-actions catalogue for this person: none. Do not use mode propose; for a requested change use refuse human_review_required.'
  :'Proposable-actions catalogue for this person, with each action\'s only hint keys (? optional): '
   +offered.map(action=>`${action} {${ASSISTANT_PROPOSAL_HINT_KEYS[action].join(',')}}`).join('; ')
   +'. Any other action is unavailable to this person; for it use refuse human_review_required.';
}

/** SYNTHETIC evaluation only (fictional holdouts and the conversation harness): every actor class, nothing
 * paused, the case's own module read set. Never used for a real caller. */
export function syntheticAssistantProposalCaller(readableModules:readonly AgentModuleCode[]=AGENT_MODULE_CODES):AssistantProposalCaller{
 return Object.freeze({readableModules:Object.freeze([...readableModules]),actors:AGENT_ACTION_ACTORS,pausedKeys:Object.freeze([])});
}
