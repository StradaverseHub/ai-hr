/** Bounded source-only Assistant orchestration. Model output is an untrusted proposal.
 * The closed Assistant owner repeats authorization and canonical facts per step in one carrier.
 */
import type { SessionContext } from '../db/client';
import { withAssistantRead, type AssistantReadSession } from './assistant-read-session';
import { isAgentModuleCode, type AgentModuleCode } from '../lib/ai/module-agents';
import { AiGatewayError } from '../lib/ai/types';
export type ModuleReadPlan = { version: 1; modules: readonly AgentModuleCode[] };
export function captureModuleReadPlan(value: unknown): ModuleReadPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AiGatewayError('Choose supported Assistant tasks.');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => key !== 'version' && key !== 'modules') || object.version !== 1 ||
    !Array.isArray(object.modules) || object.modules.length === 0 || object.modules.length > 4 ||
    !object.modules.every(isAgentModuleCode) || new Set(object.modules).size !== object.modules.length) {
    throw new AiGatewayError('Choose up to four distinct supported Assistant tasks.');
  }
  return Object.freeze({ version: 1, modules: Object.freeze([...object.modules]) });
}
export async function runModuleReadPlan(ctx: SessionContext, proposed: unknown, existing?: AssistantReadSession) {
  const plan = captureModuleReadPlan(proposed);
  return withAssistantRead(ctx, null, async read => {
    const results = [];
    // Deliberately sequential and bounded: no privilege union, child jobs or cross-user cache.
    for (const module of plan.modules) results.push(await read.moduleWork(module));
    return { version: 1 as const, results, effects: [] };
  }, existing);
}
