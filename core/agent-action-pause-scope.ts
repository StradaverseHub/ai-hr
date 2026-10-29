/** WP12 (R8): which registry action a request is serving, so the hr_assistant pause check can also apply that
 * action's own pause key (`hr_assistant:<actionId>`, migration 0696) INSIDE the owning transaction.
 *
 * The Assistant review routes (app/api/assistant/module-actions, app/api/assistant/own-leave) run each command in
 * this scope. Every source's existing `assertAiActionUnpausedTx(tx, ctx, 'hr_assistant')` then reads the scope and
 * also refuses a paused action, under the same ai-control lock, in the same Read Committed transaction as the
 * effect. No source signature changes. Outside a scope (native human pages, chat reads) only the module pause
 * applies, which is the intended meaning: a per-action pause stops the agent's part, never the human page.
 *
 * The scope carries a registry id only — never a user, authority or input value — and grants nothing. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {isAgentActionId,type AgentActionId} from '../lib/ai/agent-action-registry';

const scope=new AsyncLocalStorage<AgentActionId>();

/** Run `work` as a command for one registry action. An unknown id refuses rather than running unscoped. */
export function withAgentActionPauseScope<T>(actionId:string,work:()=>Promise<T>):Promise<T>{
 if(!isAgentActionId(actionId))return Promise.reject(Error('Unknown agent action.'));
 return scope.run(actionId,work);
}
/** The action being served, if any. */
export const currentAgentActionScope=():AgentActionId|undefined=>scope.getStore();
