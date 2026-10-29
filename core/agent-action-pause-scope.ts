/** WP12 (R8): which registry action an Assistant review-route command is serving, so the hr_assistant pause check can
 * also apply that action's own pause key (`hr_assistant:<actionId>`, migration 0696) INSIDE the owning transaction.
 *
 * The Assistant review routes (app/api/assistant/module-actions, app/api/assistant/own-leave) run every command in a
 * review-route scope. Each source's existing `assertAiActionUnpausedTx(tx, ctx, 'hr_assistant')` reads it:
 *   - scope with an action id  → the module pause AND that action's own pause, same lock, same transaction;
 *   - scope WITHOUT an action  → refused (fail closed): a review-route command whose action could not be named must
 *                                 never run under the module pause alone;
 *   - no scope at all          → module pause only. That is native human pages and chat reads, which a per-action
 *                                 pause deliberately does not stop.
 * The scope carries a registry id only — never a user, authority or input value — and grants nothing. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {isAgentActionId,type AgentActionId} from '../lib/ai/agent-action-registry';

type ReviewRouteScope=Readonly<{action:AgentActionId|null}>;
const scope=new AsyncLocalStorage<ReviewRouteScope>();

/** Run `work` as a review-route command for one registry action, or for `null` when the route could not name one
 * (every pause check inside then refuses). An unknown id is refused before `work` runs. */
export function withAgentActionPauseScope<T>(actionId:string|null,work:()=>Promise<T>):Promise<T>{
 if(actionId!==null&&!isAgentActionId(actionId))return Promise.reject(Error('Unknown agent action.'));
 return scope.run(Object.freeze({action:actionId as AgentActionId|null}),work);
}
/** undefined = not a review-route command; {action:null} = a review-route command with no nameable action. */
export const currentAgentActionScope=():ReviewRouteScope|undefined=>scope.getStore();
