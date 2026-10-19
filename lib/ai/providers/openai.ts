import { hasTokenCounts } from '../usage';
/**
 * OpenAI adapter (ADR-0023). Per-call client; generic error mapping. Uses chat.completions with the
 * `developer` role for the system message and `max_completion_tokens` (current models reject the
 * legacy `max_tokens`).
 */
import OpenAI from 'openai';
import { AiImageReadError,imageReadError,imageReadInstruction } from '../image-protocol';
import {
  AiGatewayError,
  type AiAdapter,
  type ConverseArgs,
  type ConverseResult,
  type GenerateArgs,
  type ResolvedAiConfig,
  type ValidateResult,
} from '../types';
// Request/response translation lives in openai-shared.ts (shared with the OpenRouter adapter); the
// comments that explain each mechanic moved with the code.
import { readCompletion, requestMessages, requestTools, usageFor } from './openai-shared';

function client(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

/** Conversation client — separate from `client()` so the drafting path keeps the SDK defaults it has
 *  always run with. Defaults are `timeout` = 10 minutes and `maxRetries` = 2 (client.d.ts:171,174),
 *  which an 8-turn loop turns into hours. */
function converseClient(apiKey: string, timeoutMs: number | undefined, governed = false): OpenAI {
  return new OpenAI({ apiKey, timeout: timeoutMs ?? 120_000, maxRetries: governed ? 0 : 1 });
}

export const openaiAdapter: AiAdapter = {
  provider: 'openai',
  async readImage(cfg,args){
    try{
      const result=await new OpenAI({apiKey:cfg.apiKey,timeout:args.timeoutMs,maxRetries:0}).chat.completions.create({model:cfg.model,max_completion_tokens:2500,messages:[{role:'developer',content:imageReadInstruction},{role:'user',content:[{type:'image_url',image_url:{url:`data:${args.mimeType};base64,${Buffer.from(args.data).toString('base64')}`,detail:'high'}}]}]},{signal:args.signal});
      if(hasTokenCounts(result.usage,['prompt_tokens','completion_tokens']))args.onUsage?.(usageFor(result.usage));
      if(result.choices[0]?.message.refusal)throw new AiImageReadError(false);
      return result.choices[0]?.message.content??'';
    }catch(error){throw imageReadError(error);}
  },

  async generate(cfg: ResolvedAiConfig, args: GenerateArgs): Promise<string> {
    try {
      const completion = await (args.signal?new OpenAI({apiKey:cfg.apiKey,timeout:args.timeoutMs,maxRetries:0}):cfg.governance?new OpenAI({apiKey:cfg.apiKey,maxRetries:0}):client(cfg.apiKey)).chat.completions.create({
        model: cfg.model,
        max_completion_tokens: args.maxTokens ?? 2048,
        messages: [
          { role: 'developer', content: args.system },
          { role: 'user', content: args.prompt },
        ],
      },args.signal?{signal:args.signal}:undefined);
      if(hasTokenCounts(completion.usage,['prompt_tokens','completion_tokens']))args.onUsage?.(usageFor(completion.usage));
      if(args.signal&&(completion.choices[0]?.finish_reason==='length'||completion.choices[0]?.message.refusal))throw new AiGatewayError('No complete assessment was produced.');
      return (completion.choices[0]?.message?.content ?? '').trim();
    } catch (e) {
      throw mapError(e);
    }
  },

  async validate(cfg: ResolvedAiConfig): Promise<ValidateResult> {
    try {
      // Metadata-only probe: validates the key (401) and the model id (404) with no generation cost.
      await client(cfg.apiKey).models.retrieve(cfg.model);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: reason(e) };
    }
  },

  /**
   * Multi-turn, tool-aware, non-streaming (ADR-0082).
   *
   * `.create()` deliberately — NOT `.parse()`, `.stream()` or `.runTools()`. Those helpers throw
   * `LengthFinishReasonError` / `ContentFilterFinishReasonError`, which extend `OpenAIError` and NOT
   * `APIError` (core/error.d.ts:51,54), so `e instanceof OpenAI.APIError` misses them and a length
   * truncation would be mislabelled as a network fault. `.runTools()` is additionally disqualified: it
   * hides the loop, which is exactly where the turn cap, the budget re-check and the audit live.
   *
   * chat.completions, not `responses`, for v1 — one SDK surface per adapter and an explicit
   * `finish_reason === 'tool_calls'` discriminator. THE COST IS REAL AND IS NOT HIDDEN: chat.completions
   * has no reasoning item, so on gpt-5.x models reasoning state is LOST between tool turns. The
   * `providerState` carrier exists so a later swap to `responses` is an adapter-internal change with no
   * contract edit and no caller edit.
   */
  async converse(cfg: ResolvedAiConfig, args: ConverseArgs): Promise<ConverseResult> {
    try {
      const tools = requestTools(args.tools);
      const completion = await converseClient(cfg.apiKey, args.timeoutMs, Boolean(cfg.governance)).chat.completions.create({
        model: cfg.model,
        max_completion_tokens: args.maxTokens ?? 2048,
        messages: [
          { role: 'developer', content: args.system.join('\n\n') },
          ...requestMessages(args.turns),
        ],
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const, parallel_tool_calls: true } : {}),
        // A cache-ROUTING hint only. Must never be a tenant id, user id or email — the gateway's caller
        // passes a non-reversible digest of (tenant, role).
        ...(args.cacheKey ? { prompt_cache_key: args.cacheKey } : {}),
      });
      return readCompletion(completion);
    } catch (e) {
      throw mapError(e);
    }
  },
};

function status(e: unknown): number | undefined {
  return e instanceof OpenAI.APIError ? e.status ?? undefined : undefined;
}

function reason(e: unknown): string {
  const s = status(e);
  if (s === 401 || s === 403) return 'Invalid API key';
  if (s === 404) return 'Model not available for this key';
  if (s === 429) return 'Rate limited — try again shortly';
  return 'Could not reach OpenAI';
}

function mapError(e: unknown): AiGatewayError {
  return new AiGatewayError(reason(e));
}
