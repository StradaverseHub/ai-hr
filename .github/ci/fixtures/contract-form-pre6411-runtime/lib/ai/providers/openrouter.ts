import {assertProviderEgressDispatch,consumeProviderEgressDispatch} from '../provider-egress';
/** OpenRouter adapter. No tools execute here. No image capability, retries, automatic route/model,
 * environment key or captured tenant state. Metadata validation is not a real tool/quality evaluation.
 * Gateway callers still own fresh scope/minimal-field authorization and canonical effects. */
import { z } from 'zod';
import { AiGatewayError, type AiAdapter, type ResolvedAiConfig, type ValidateResult } from '../types';
import { readOpenRouterOptions } from './openrouter-configuration';
import { buildOpenRouterRequest, createOpenRouterTransport, readOpenRouterJsonResponse, OpenRouterTransportConfiguration } from './openrouter-transport';
const unavailable = () => new AiGatewayError('AI provider response unavailable.');
function configuration(cfg: ResolvedAiConfig) {
  if (cfg.provider !== 'openrouter') throw unavailable();
  const options = readOpenRouterOptions(cfg.providerOptions);
  return { model: cfg.model, apiKey: cfg.apiKey, routing: options.routing };
}
const Key = z.object({ error: z.unknown().optional(), data: z.object({ label: z.string().max(1024),
  usage: z.number().finite().nonnegative(), is_management_key: z.boolean().optional(), is_provisioning_key: z.boolean().optional() }) });
const Models = z.object({ error: z.unknown().optional(), data: z.object({ id: z.string(),
  endpoints: z.array(z.object({ tag: z.string(), supported_parameters: z.array(z.string()).max(256) })).max(1024) }) });
const Zdr = z.object({ error: z.unknown().optional(), data: z.array(z.object({ model_id: z.string(), tag: z.string(),
  supported_parameters: z.array(z.string()).max(256) })).max(16384) });

/** Three metadata-only official GETs; no completion payload, HR fields or synthetic generation.
 * The total ten-second deadline includes body reads even when an injected transport ignores abort.
 * Only a boolean/generic reason escapes; key labels/account details are discarded. */
async function metadata(fetcher: typeof fetch, cfg: ResolvedAiConfig): Promise<ValidateResult> {
  const controller = new AbortController(), started = performance.now();
  let stop!: () => void;
  const cancelled = new Promise<never>((_, reject) => { stop = () => reject(unavailable()); });
  void cancelled.catch(() => {}); controller.signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    consumeProviderEgressDispatch(cfg,'probe');
    const c = configuration(cfg);
    OpenRouterTransportConfiguration.parse(c);
    // Reuse the real request configuration validator without sending a prompt.
    buildOpenRouterRequest({ model: c.model, routing: c.routing }, { system: ['Metadata validation only'], turns: [{ role: 'user', content: 'metadata' }], tools: [] });
    const parts = c.model.split('/'); if (parts.length !== 2) throw unavailable();
    const read = async (path: string) => {
      if (controller.signal.aborted) throw unavailable();
      const response = await fetcher('https://openrouter.ai/api/v1/' + path, { method: 'GET', redirect: 'error', cache: 'no-store',
        headers: { Authorization: 'Bearer ' + c.apiKey }, signal: controller.signal });
      return readOpenRouterJsonResponse(response, controller.signal, () => performance.now() - started >= 10_000);
    };
    await Promise.race([(async () => {
      const key = Key.parse(await read('key'));
      if (key.error !== undefined || key.data.is_management_key === true || key.data.is_provisioning_key === true) throw unavailable();
      const models = Models.parse(await read('models/' + parts.map(encodeURIComponent).join('/') + '/endpoints'));
      if (models.error !== undefined || models.data.id !== c.model) throw unavailable();
      const zdr = Zdr.parse(await read('endpoints/zdr'));
      if (zdr.error !== undefined) throw unavailable();
      // Endpoint tags are matched exactly; no display-name guess or fallback to unapproved endpoints.
      const allowed = new Set(c.routing.allowedProviders);
      const tools = (p: string[]) => p.includes('tools') && p.includes('tool_choice');
      if (!models.data.endpoints.some(e => allowed.has(e.tag) && tools(e.supported_parameters)
        && zdr.data.some(z => z.model_id === c.model && z.tag === e.tag && tools(z.supported_parameters)))) throw unavailable();
    })(), cancelled]);
    if (controller.signal.aborted || performance.now() - started >= 10_000) throw unavailable();
    return { ok: true };
  } catch { return { ok: false, error: 'Approved AI route metadata could not be confirmed.' }; }
  finally { clearTimeout(timer); controller.signal.removeEventListener('abort', stop); }
}

export function createOpenRouterAdapter(fetcher: typeof fetch): AiAdapter {
  const transport = createOpenRouterTransport(fetcher);
  return {
    provider: 'openrouter',
    async generate(cfg, args) {
      try {
        assertProviderEgressDispatch(cfg,'draft',args);
        if (!cfg.governance) throw unavailable();
        const result = await transport(configuration(cfg), { system: [args.system], turns: [{ role: 'user', content: args.prompt }],
          tools: [], maxTokens: args.maxTokens ?? 2048, ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }) }, args.signal,terminal=>{
          if(terminal.accounting.usage)args.onUsage?.(terminal.accounting.usage);
          args.onObservation?.(Object.freeze({version:1,provider:'openrouter',accountCostUnit:'openrouter_account_credits',usage:terminal.accounting.usage,accountCostCredits:terminal.accounting.accountCostCredits,elapsedMs:terminal.elapsedMs}));
        });
        if (result.completion.stop !== 'end' || result.completion.toolCalls.length || !result.completion.text.trim()) throw unavailable();
        return result.completion.text.trim();
      } catch { throw unavailable(); }
    },
    async converse(cfg, args) {
      try {
        assertProviderEgressDispatch(cfg,'conversation',args);
        if (!cfg.governance) throw unavailable();
        const {onObservation,...request}=args;
        const result=await transport(configuration(cfg),request,undefined,terminal=>{
          onObservation?.(Object.freeze({version:1,provider:'openrouter',accountCostUnit:'openrouter_account_credits',usage:terminal.accounting.usage,accountCostCredits:terminal.accounting.accountCostCredits,elapsedMs:terminal.elapsedMs}));
        });
        return result.completion;
      } catch { throw unavailable(); }
    },
    validate: cfg => metadata(fetcher, cfg),
  };
}
// Stateless server dependency only; resolving global fetch here does not open a connection.
export const openrouterAdapter = createOpenRouterAdapter((input, init) => fetch(input, init));
