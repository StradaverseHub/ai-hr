/** Server-internal stored-row CPU decoding only. No database, fallback, principal proof,
 * snapshot issuance, provider call or command capability. Callers own all authority. */
import { AiGatewayError, type ResolvedAiConfig } from '../lib/ai/types';
import { decryptSecret } from '../lib/ai/crypto';
import { isProvider } from '../lib/ai/registry';
import { readOpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import { readGatewayOptions } from '../lib/ai/providers/gateway-options';
import { OpenRouterTransportConfiguration } from '../lib/ai/providers/openrouter-transport';

const refuse = (): never => { throw new AiGatewayError('The current AI configuration could not be confirmed.'); };

export function decodeStoredActiveAiProviderRow(
  row: Readonly<{ provider: string; model: string; api_key_ciphertext: string; provider_options: unknown }>,
  tenantId: string,
): ResolvedAiConfig {
  if (!isProvider(row.provider) || typeof row.model !== 'string' || !row.model.trim() || row.model !== row.model.trim()) return refuse();
  let providerOptions: ResolvedAiConfig['providerOptions'];
  try {
    let gatewayBaseUrl: string | undefined;
    if (row.provider === 'openrouter') providerOptions = readOpenRouterOptions(row.provider_options);
    // 0661: the gateway's address is its only option; it is re-validated on read and before every call.
    else if (row.provider === 'ai_gateway') gatewayBaseUrl = readGatewayOptions(row.provider_options).baseUrl;
    else if (!row.provider_options || typeof row.provider_options !== 'object' || Array.isArray(row.provider_options) || Object.keys(row.provider_options).length) return refuse();
    const apiKey = decryptSecret(row.api_key_ciphertext, tenantId);
    if (row.provider === 'openrouter' && !OpenRouterTransportConfiguration.safeParse({ model: row.model, apiKey, routing: providerOptions!.routing }).success) return refuse();
    return Object.freeze({ provider: row.provider, model: row.model, apiKey, ...(providerOptions ? { providerOptions } : {}), ...(gatewayBaseUrl ? { gatewayBaseUrl } : {}) });
  } catch { return refuse(); }
}
