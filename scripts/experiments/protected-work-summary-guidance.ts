import { routingDigest } from '../../lib/ai/module-agent-routing';
import type { PilotModel } from '../teras/leave-improvement';

export const guidanceOptions = Object.freeze({
  include_meaning: 'Include the most specific available explanation of what the selected fact means when the explanation directly covers the requested intent.',
  group_evidence: 'Choose the minimal set of available facts needed to make the answer intelligible. Keep facts from the same record together before their explanation.',
  verify_references: 'Before emitting the answer, verify every read, card and fact ordinal matches an available reference, then check that the selected references answer the intent.',
});
export type Guidance = keyof typeof guidanceOptions;
export const guidanceContractDigest = routingDigest(guidanceOptions);
export const protectedStrategyDigest = (rules: readonly Guidance[]) =>
  routingDigest([guidanceContractDigest, 'baseline_v1', rules]);

export function isGuidance(value: unknown): value is Guidance {
  return typeof value === 'string' && Object.hasOwn(guidanceOptions, value);
}

export function withProtectedGuidance(model: PilotModel, rules: readonly Guidance[]): PilotModel {
  if (!rules.length) return model;
  const guidance = rules.map(rule => guidanceOptions[rule]).join('\n');
  return request => model({ ...request, system: request.system + '\n' + guidance });
}
