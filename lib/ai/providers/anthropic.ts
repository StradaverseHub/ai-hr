/**
 * Anthropic (Claude) adapter (ADR-0023). Client is constructed PER CALL from the resolved key — never
 * memoized at module scope (a singleton would pin one tenant's key process-wide). Provider errors are
 * mapped to the generic AiGatewayError so no key fragment or raw SDK body escapes.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  AiGatewayError,
  finiteOrZero,
  normaliseStop,
  type AiAdapter,
  type AiStop,
  type AiToolCall,
  type AiToolSpec,
  type AiTurn,
  type AiUsage,
  type ConverseArgs,
  type ConverseResult,
  type GenerateArgs,
  type ResolvedAiConfig,
  type ValidateResult,
} from '../types';

function client(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

/**
 * The conversation client. SEPARATE from `client()` so the drafting path keeps the SDK defaults it has
 * always run with, byte for byte.
 *
 * Why a timeout and maxRetries at all: the SDK defaults are `timeout` = 10 MINUTES and `maxRetries` = 2
 * (client.d.ts:195,198). Under an 8-turn assistant loop that is a worst case of 8 x 10min x 3 attempts —
 * about four hours pinned inside one server action. Per-call ceilings do not bound the LOOP; the caller
 * must also enforce a whole-exchange deadline.
 */
function converseClient(apiKey: string, timeoutMs: number | undefined): Anthropic {
  return new Anthropic({ apiKey, timeout: timeoutMs ?? 120_000, maxRetries: 1 });
}

export const anthropicAdapter: AiAdapter = {
  provider: 'anthropic',

  async generate(cfg: ResolvedAiConfig, args: GenerateArgs): Promise<string> {
    try {
      const message = await client(cfg.apiKey).messages.create({
        model: cfg.model,
        max_tokens: args.maxTokens ?? 2048,
        thinking: { type: 'adaptive' },
        system: args.system,
        messages: [{ role: 'user', content: args.prompt }],
      });
      return message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
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

  /** Multi-turn, tool-aware, non-streaming (ADR-0082). Anthropic is the reference implementation: it is
   *  the only provider with a real tool-use stop reason, explicit cache breakpoints, and reasoning
   *  blocks that can be handed back as INPUT for multi-turn continuity. */
  async converse(cfg: ResolvedAiConfig, args: ConverseArgs): Promise<ConverseResult> {
    try {
      const tools = requestTools(args.tools);
      const message = await converseClient(cfg.apiKey, args.timeoutMs).messages.create({
        model: cfg.model,
        max_tokens: args.maxTokens ?? 2048,
        thinking: { type: 'adaptive' },
        system: requestSystem(args.system),
        messages: requestMessages(args.turns),
        // tool_choice without tools is a request error, so both are conditional.
        ...(tools.length > 0 ? { tools, tool_choice: { type: 'auto' as const } } : {}),
      });
      return readMessage(message);
    } catch (e) {
      throw mapError(e);
    }
  },
};

/* ------------------------------------------------------------------------------------------------
 * Request translation. Render order is tools -> system -> messages, and prompt caching is a PREFIX
 * match: one changed byte anywhere invalidates everything after it. Three breakpoints are placed here,
 * of a maximum of FOUR (blowing the cap is a request error, not a degradation):
 *   1. the last tool definition   — caches every tool spec;
 *   2. the last system block      — caches tools + system together;
 *   3. the last block of a FINAL tool-result turn — stops turns 2..N re-paying full input price on
 *      everything the earlier turns established.
 * Nothing volatile may reach 1 or 2 — that is the CALLER's contract (see ConverseArgs.system), and it
 * is why `system` is an array: only a block can carry `cache_control`.
 * ---------------------------------------------------------------------------------------------- */

const CACHE_BREAKPOINT: Anthropic.CacheControlEphemeral = { type: 'ephemeral' };

function requestTools(tools: AiToolSpec[]): Anthropic.Tool[] {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    // Assigns with NO cast: AiJsonSchema is a type alias, so it gets an implicit index signature and
    // satisfies Tool.InputSchema's `[k: string]: unknown`.
    input_schema: t.inputSchema,
    strict: true,
    ...(i === tools.length - 1 ? { cache_control: CACHE_BREAKPOINT } : {}),
  }));
}

function requestSystem(system: string[]): Anthropic.TextBlockParam[] {
  return system.map((text, i) => ({
    type: 'text' as const,
    text,
    ...(i === system.length - 1 ? { cache_control: CACHE_BREAKPOINT } : {}),
  }));
}

function requestMessages(turns: AiTurn[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  turns.forEach((turn, index) => {
    const isFinal = index === turns.length - 1;
    if (turn.role === 'user') {
      out.push({ role: 'user', content: turn.content });
      return;
    }
    if (turn.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      // Thinking blocks FIRST and verbatim — the API accepts ThinkingBlockParam / RedactedThinkingBlockParam
      // as input, and `thinking: adaptive` returns a signature expressly "for multi-turn continuity".
      // Tagged state from another provider is DISCARDED rather than fed to Anthropic.
      if (turn.providerState?.provider === 'anthropic') {
        blocks.push(...(turn.providerState.blocks as Anthropic.ContentBlockParam[]));
      }
      if (turn.content) blocks.push({ type: 'text', text: turn.content });
      for (const call of turn.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} });
      }
      // An assistant message with an empty content array is a request error; a turn that carries no
      // text, no calls and no state carries no information either, so it is dropped rather than sent.
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
      return;
    }
    // ONE user message carrying EVERY tool_result for the preceding assistant turn. Splitting them does
    // not error — it silently stops the model issuing parallel calls (ADR-0082 §2.2 mechanic 1).
    const results: Anthropic.ToolResultBlockParam[] = turn.results.map((r, i) => ({
      type: 'tool_result' as const,
      tool_use_id: r.id,
      content: r.content,
      ...(r.isError ? { is_error: true } : {}),
      ...(isFinal && i === turn.results.length - 1 ? { cache_control: CACHE_BREAKPOINT } : {}),
    }));
    out.push({ role: 'user', content: results });
  });
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Response translation.
 * ---------------------------------------------------------------------------------------------- */

function readMessage(message: Anthropic.Message): ConverseResult {
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const calls: AiToolCall[] = message.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));

  const thinking = message.content.filter(
    (b): b is Anthropic.ThinkingBlock | Anthropic.RedactedThinkingBlock =>
      b.type === 'thinking' || b.type === 'redacted_thinking',
  );

  const { stop, toolCalls } = normaliseStop(stopFor(message.stop_reason), calls);
  return {
    text,
    toolCalls,
    stop,
    usage: usageFor(message.usage),
    // Opaque to everyone above this line. `stop_details.category` is a closed enum and would be safe to
    // record, but `stop_details.explanation` is free provider prose — so NO refusal detail crosses the
    // boundary at all, and the loop renders one localised refusal string for all three providers.
    ...(thinking.length > 0 ? { providerState: { provider: 'anthropic' as const, blocks: thinking } } : {}),
  };
}

function stopFor(raw: Anthropic.StopReason | null): AiStop {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    // `pause_turn` only arises with server tools, which ADR-0082 §2.4 forbids. Mapping it to 'end' would
    // report a truncated turn as a finished answer.
    case 'pause_turn':
      return 'other';
    default:
      return 'other';
  }
}

/** input_tokens EXCLUDES both cache reads and cache creation here (unlike OpenAI and Google, where the
 *  cached count is a SUBSET of the prompt count). Cache CREATION is fresh input billed at a premium, so
 *  it belongs in inputTokens; only cache READS are `cachedInputTokens`. */
function usageFor(u: Anthropic.Usage | undefined): AiUsage {
  return {
    inputTokens: finiteOrZero(u?.input_tokens) + finiteOrZero(u?.cache_creation_input_tokens),
    outputTokens: finiteOrZero(u?.output_tokens),
    cachedInputTokens: finiteOrZero(u?.cache_read_input_tokens),
  };
}

function status(e: unknown): number | undefined {
  return e instanceof Anthropic.APIError ? e.status : undefined;
}

function reason(e: unknown): string {
  const s = status(e);
  if (s === 401 || s === 403) return 'Invalid API key';
  if (s === 404) return 'Model not available for this key';
  if (s === 429) return 'Rate limited — try again shortly';
  return 'Could not reach Anthropic';
}

function mapError(e: unknown): AiGatewayError {
  return new AiGatewayError(reason(e));
}
