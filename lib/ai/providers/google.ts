/**
 * Google (Gemini) adapter (ADR-0023). Uses the current unified SDK `@google/genai` (Gemini Developer
 * API, not Vertex). Per-call client; generic error mapping. The system prompt goes in
 * `config.systemInstruction`; `response.text` is a getter that may be undefined.
 */
import { ApiError, GoogleGenAI, type Candidate, type Content, type FunctionDeclaration, type GenerateContentResponse, type GenerateContentResponseUsageMetadata, type Part } from '@google/genai';
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

function client(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey });
}

export const googleAdapter: AiAdapter = {
  provider: 'google',

  async generate(cfg: ResolvedAiConfig, args: GenerateArgs): Promise<string> {
    try {
      const response = await client(cfg.apiKey).models.generateContent({
        model: cfg.model,
        contents: args.prompt,
        config: { systemInstruction: args.system, maxOutputTokens: args.maxTokens ?? 2048 },
      });
      return (response.text ?? '').trim();
    } catch (e) {
      throw mapError(e);
    }
  },

  async validate(cfg: ResolvedAiConfig): Promise<ValidateResult> {
    try {
      // Cheapest probe that validates BOTH the key and the model id: a 1-token generation.
      await client(cfg.apiKey).models.generateContent({
        model: cfg.model,
        contents: 'hi',
        config: { maxOutputTokens: 1 },
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: reason(e) };
    }
  },

  /**
   * Multi-turn, tool-aware, non-streaming (ADR-0082). Google is the weakest of the three at expressing
   * this contract and the degradations are stated where they bite, not hidden:
   *   - there is NO tool-use finish reason (it returns STOP when it wants a tool), so the shared
   *     `normaliseStop` lets the EVIDENCE of a parsed call beat the provider's label;
   *   - there is NO strict schema validation, so runtime validation of every tool input by the caller
   *     is the ONLY net here;
   *   - `FunctionCall.id` is optional and commonly absent, so ids are synthesised and results are
   *     correlated BY ORDER and by `name`;
   *   - v1 ships NO prompt-cache control (explicit caching needs a cachedContent resource lifecycle);
   *     `cachedContentTokenCount` is still read so implicit hits are visible if they happen.
   */
  async converse(cfg: ResolvedAiConfig, args: ConverseArgs): Promise<ConverseResult> {
    try {
      const declarations = requestTools(args.tools);
      const response = await client(cfg.apiKey).models.generateContent({
        model: cfg.model,
        contents: requestContents(args.turns),
        config: {
          systemInstruction: args.system.join('\n\n'),
          maxOutputTokens: args.maxTokens ?? 2048,
          // The SDK will otherwise RUN the tools itself and hide the loop — the loop is where the turn
          // cap, the budget re-check and the audit live.
          automaticFunctionCalling: { disable: true },
          httpOptions: { timeout: args.timeoutMs ?? 120_000 },
          // toolConfig is omitted deliberately: the default mode is AUTO.
          ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] } : {}),
        },
      });
      return readResponse(response);
    } catch (e) {
      // withTools: on THIS path a 400 is as likely to be the tool schema as the key. See reason().
      throw mapError(e, { withTools: true });
    }
  },
};

/* ------------------------------------------------------------------------------------------------
 * Request translation.
 * ---------------------------------------------------------------------------------------------- */

/**
 * A synthesised tool-call id. Google's `FunctionCall.id` is optional and the Gemini Developer API
 * frequently omits it, but the neutral contract requires one — so this adapter mints it and strips it
 * again on the way back out. The prefix (rather than the bare `name#index` the design sketched) is what
 * makes "did the model actually supply this id?" an EXACT test instead of a heuristic: a real Google id
 * can never collide with it.
 */
const SYNTHETIC_ID_PREFIX = 'g-syn:';

function requestTools(tools: AiToolSpec[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // `parametersJsonSchema`, NEVER `parameters`. They are mutually exclusive: `parameters` is an
    // OpenAPI-3.0.3 Schema whose `type` is the UPPERCASE `Type` enum ("OBJECT"), so feeding our
    // lowercase JSON Schema into it type-checks and produces a malformed declaration the model cannot
    // use. `parametersJsonSchema` is documented for plain JSON Schema and supports additionalProperties.
    parametersJsonSchema: t.inputSchema,
  }));
}

function requestContents(turns: AiTurn[]): Content[] {
  const out: Content[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      out.push({ role: 'user', parts: [{ text: turn.content }] });
      continue;
    }
    if (turn.role === 'assistant') {
      // The assistant role is called `model` here, not `assistant`.
      //
      // When we hold Google's own parts for this turn, they go back VERBATIM: `thoughtSignature` is an
      // opaque per-part signature "so it can be reused in subsequent requests", and Gemini attaches it
      // to the part that carries the text or the functionCall — so rebuilding the parts ourselves would
      // either drop the signature or duplicate the call. State minted by another provider is discarded.
      if (turn.providerState?.provider === 'google') {
        out.push({ role: 'model', parts: turn.providerState.blocks as Part[] });
        continue;
      }
      const parts: Part[] = [];
      if (turn.content) parts.push({ text: turn.content });
      for (const call of turn.toolCalls ?? []) {
        parts.push({
          functionCall: {
            ...(call.id.startsWith(SYNTHETIC_ID_PREFIX) ? {} : { id: call.id }),
            name: call.name,
            args: (call.input ?? {}) as Record<string, unknown>,
          },
        });
      }
      if (parts.length > 0) out.push({ role: 'model', parts });
      continue;
    }
    // Empty results would send a content whose parts array is empty — a request error, and a caller bug
    // rather than a state worth transmitting. Dropped, matching the assistant arm above.
    if (turn.results.length === 0) continue;
    // ONE content carrying every functionResponse, in the SAME ORDER as the functionCall parts — with no
    // model-supplied id, position and `name` are the only correlation Google has. And the role is
    // `user`, not a dedicated tool role.
    out.push({
      role: 'user',
      parts: turn.results.map((r) => ({
        functionResponse: {
          ...(r.id.startsWith(SYNTHETIC_ID_PREFIX) ? {} : { id: r.id }),
          name: r.name,
          // Documented keys: "output" for the result, "error" for a failure. Never a dropped result.
          response: r.isError ? { error: r.content } : { output: r.content },
        },
      })),
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Response translation.
 *
 * `response.text` and `response.functionCalls` are NOT used here, though `generate()` above is right to
 * use the former. Both are getters over the first candidate that only LOG a warning when non-text parts
 * are present; walking `candidates[0].content.parts` once instead yields text, calls and thought
 * signatures with their ordering intact, and ordering is load-bearing for Google.
 * ---------------------------------------------------------------------------------------------- */

function readResponse(response: GenerateContentResponse): ConverseResult {
  const usage = usageFor(response.usageMetadata);

  // A BLOCKED PROMPT IS A DISTINCT CODE PATH: there are no candidates at all, and reading finishReason
  // off a missing candidate yields undefined -> 'end' -> an empty answer reported as success.
  if (response.promptFeedback?.blockReason) {
    return { text: '', toolCalls: [], stop: 'refusal', usage };
  }

  const candidate: Candidate | undefined = response.candidates?.[0];
  // No candidate and no block reason is anomalous, not finished. Terminal AND visible.
  if (!candidate) return { text: '', toolCalls: [], stop: 'other', usage };

  const parts: Part[] = candidate.content?.parts ?? [];
  const text = parts
    .filter((p) => p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();

  const calls: AiToolCall[] = [];
  for (const p of parts) {
    const fc = p.functionCall;
    if (!fc) continue;
    const name = fc.name ?? '';
    calls.push({ id: fc.id ?? `${SYNTHETIC_ID_PREFIX}${name}#${calls.length}`, name, input: fc.args ?? {} });
  }

  const { stop, toolCalls } = normaliseStop(stopFor(candidate.finishReason), calls);

  // WHEN normaliseStop SUPPRESSED THE CALLS, THE functionCall PARTS MUST NOT BE REPLAYED.
  //
  // `refusal` and `max_tokens` both return `toolCalls: []` — the gateway is deliberately refusing to
  // hand the caller a call it should not run (a truncated argument list, or one the safety filter
  // stopped). The state carried here is replayed VERBATIM by requestContents() on the next request, so
  // shipping the functionCall part anyway presents that refused call to the model as an outstanding
  // tool request with no functionResponse closing it — and it re-issues the call or invents its result.
  // Nothing errors. Anthropic cannot reach this because its state is filtered to thinking blocks alone;
  // Google's is the whole parts array, which is why the guard has to be here.
  //
  // The functionCall parts are dropped rather than the whole state: a thoughtSignature on a surviving
  // part is still worth carrying, and `signed` is recomputed over what actually survives so a state
  // holding nothing useful is not emitted at all.
  const suppressed = calls.length > 0 && toolCalls.length === 0;
  const blocks = suppressed ? parts.filter((p) => !p.functionCall) : parts;
  const signed = blocks.some((p) => typeof p.thoughtSignature === 'string');

  return {
    text,
    toolCalls,
    stop,
    usage,
    // The WHOLE surviving parts array, not just the signature-bearing parts: a signature belongs to its
    // part, and that part is usually the one carrying the functionCall.
    ...(signed ? { providerState: { provider: 'google' as const, blocks } } : {}),
  };
}

/** `finishReason` is a string enum; it is compared as a string so an unknown future member degrades to
 *  'other' rather than throwing. STOP is ALSO what Google returns when it wants a tool — `normaliseStop`
 *  is what turns that into 'tool_use' on the evidence of a parsed call. */
function stopFor(raw: unknown): AiStop {
  // AN ABSENT finishReason IS NOT 'STOP'. The SDK documents it as "if empty, the model has NOT stopped
  // generating the tokens" (genai.d.ts, Candidate.finishReason) — so defaulting it to STOP reports a
  // half-written answer as a finished one, and the caller's loop terminates on a truncated sentence.
  // Anthropic (null stop_reason) and OpenAI (undefined finish_reason) both send this case to 'other';
  // Google now agrees. A genuine tool call is unaffected: normaliseStop promotes any parsed call to
  // 'tool_use' regardless of the raw label.
  if (raw == null) return 'other';
  switch (String(raw)) {
    case 'STOP':
      return 'end';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    // BLOCKLIST is "the content contains forbidden terms" — a content-policy stop, so it renders the
    // localised refusal rather than the generic "something else happened". Both are terminal and
    // visible, so this choice cannot hide a failure either way.
    case 'BLOCKLIST':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
      return 'refusal';
    default:
      // RECITATION | LANGUAGE | OTHER | MALFORMED_FUNCTION_CALL | UNEXPECTED_TOOL_CALL |
      // FINISH_REASON_UNSPECIFIED | NO_IMAGE | IMAGE_RECITATION | IMAGE_OTHER | anything added later.
      return 'other';
  }
}

/**
 * `promptTokenCount` INCLUDES `cachedContentTokenCount`, so the cached count is subtracted out.
 * `toolUsePromptTokenCount` and `thoughtsTokenCount` are DISJOINT from both — the SDK documents
 * totalTokenCount as the sum of all four — so `candidatesTokenCount` alone EXCLUDES reasoning and a
 * thinking-heavy answer would be metered as almost free. Both are added, on the correct side.
 */
function usageFor(u: GenerateContentResponseUsageMetadata | undefined): AiUsage {
  const cached = finiteOrZero(u?.cachedContentTokenCount);
  return {
    inputTokens: Math.max(0, finiteOrZero(u?.promptTokenCount) - cached) + finiteOrZero(u?.toolUsePromptTokenCount),
    outputTokens: finiteOrZero(u?.candidatesTokenCount) + finiteOrZero(u?.thoughtsTokenCount),
    cachedInputTokens: cached,
  };
}

/**
 * 400 IS AMBIGUOUS ON GOOGLE, AND UNIQUELY SO — which is why this takes the path as an argument.
 *
 * The Gemini Developer API answers a BAD KEY with 400 INVALID_ARGUMENT ("API key not valid"), not the
 * 401 that Anthropic and OpenAI use. That is why `validate()` and `generate()` read 400 as an auth
 * fault, and they are right to: their request shape is fixed and trivial, so nothing else about it can
 * be invalid. A test pins that branch deliberately — do not "simplify" it away.
 *
 * `converse()` broke the assumption by making the request shape variable. A tool schema this model will
 * not accept, or a functionResponse that fails to correlate, is also a 400 — so on that path "Invalid
 * API key" sends the tenant admin to rotate a key that works, while the Test-connection button (which
 * probes WITHOUT tools) keeps answering ok and contradicts it. On that path alone the message names
 * both causes instead of asserting the wrong one.
 */
function reason(e: unknown, opts?: { withTools?: boolean }): string {
  const s = e instanceof ApiError ? e.status : undefined;
  if (s === 400 && opts?.withTools) return 'Invalid API key, or a request this model will not accept';
  if (s === 400 || s === 401 || s === 403) return 'Invalid API key';
  if (s === 404) return 'Model not available for this key';
  if (s === 429) return 'Rate limited — try again shortly';
  return 'Could not reach Google';
}

function mapError(e: unknown, opts?: { withTools?: boolean }): AiGatewayError {
  return new AiGatewayError(reason(e, opts));
}
