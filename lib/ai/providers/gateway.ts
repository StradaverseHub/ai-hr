import {assertProviderEgressDispatch} from '../provider-egress';
/** General AI gateway adapter (0661): the OpenAI adapter pointed at the tenant's gateway address, after the
 * address is re-checked as public. Uses the plain 'system' role, which OpenAI-style gateways accept for
 * every model they route to. Cost is not reported in a verified form, so spend-capped work stays refused
 * by the spend owner (unknown cost is never zero). */
import { openaiAdapter } from './openai';
import { assertPublicGateway } from './gateway-options';
import type { AiAdapter, ResolvedAiConfig } from '../types';

const routed = (cfg: ResolvedAiConfig): ResolvedAiConfig => ({ ...cfg, provider: 'ai_gateway' });
export const gatewayAdapter: AiAdapter = {
  provider: 'ai_gateway',
  async generate(cfg, args) { assertProviderEgressDispatch(cfg,'draft',args); await assertPublicGateway(cfg.gatewayBaseUrl); return openaiAdapter.generate(routed(cfg), args); },
  async validate(cfg) { try { assertProviderEgressDispatch(cfg,'probe'); await assertPublicGateway(cfg.gatewayBaseUrl); } catch { return { ok: false, error: 'The AI gateway address is not allowed or could not be reached.' }; } return openaiAdapter.validate(routed(cfg)); },
  async converse(cfg, args) { assertProviderEgressDispatch(cfg,'conversation',args); await assertPublicGateway(cfg.gatewayBaseUrl); return openaiAdapter.converse!(routed(cfg), args); },
  ...(openaiAdapter.readImage ? { async readImage(cfg: ResolvedAiConfig, args: Parameters<NonNullable<AiAdapter['readImage']>>[1]) { assertProviderEgressDispatch(cfg,'image',args); await assertPublicGateway(cfg.gatewayBaseUrl); return openaiAdapter.readImage!(routed(cfg), args); } } : {}),
};
