/**
 * AI gateway (ADR-0007, ADR-0022 slice 5). The single, governed boundary between this product and
 * the LLM. Two safety rails live HERE so a call site cannot forget them:
 *
 *   1. Graceful degradation — with no `ANTHROPIC_API_KEY` the feature is simply OFF:
 *      `isAiConfigured()` returns false and `generateDraft` throws `AiNotConfiguredError`. The build,
 *      the test suite, and every non-AI page never depend on a live key. Gate UI affordances on
 *      `isAiConfigured()` so we never render a dead button.
 *
 *   2. PII redaction — `redactPII()` scrubs direct identifiers (emails, Malaysian IC numbers, phone
 *      numbers) from any free text before it leaves the tenant for the model. Callers should redact
 *      every employee/peer-authored string they assemble into a prompt.
 *
 * Draft-only by contract: this boundary returns prose a human edits before it touches state. Nothing
 * here writes a review, a rating, or pay. The model is config-driven (`AI_DRAFT_MODEL`, default
 * `claude-opus-4-8`) so an operator picks the cost tier without a code change.
 */
import Anthropic from '@anthropic-ai/sdk';

export class AiNotConfiguredError extends Error {
  constructor(message = 'AI drafting is not configured (set ANTHROPIC_API_KEY to enable).') {
    super(message);
    this.name = 'AiNotConfiguredError';
  }
}

const DEFAULT_MODEL = 'claude-opus-4-8';

const apiKey = (): string | undefined => process.env.ANTHROPIC_API_KEY?.trim() || undefined;

/** True when a key is present. Gate the UI affordance on this so we never show a dead button. */
export function isAiConfigured(): boolean {
  return Boolean(apiKey());
}

/** The configured model id (operator override via AI_DRAFT_MODEL, else the default Opus). */
export function aiModel(): string {
  return process.env.AI_DRAFT_MODEL?.trim() || DEFAULT_MODEL;
}

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  const key = apiKey();
  if (!key) throw new AiNotConfiguredError();
  if (!cachedClient) cachedClient = new Anthropic({ apiKey: key });
  return cachedClient;
}

/**
 * Scrub direct identifiers before any free text leaves the tenant. Conservative by design — it only
 * removes high-precision patterns (emails, Malaysian IC numbers, long phone-like digit runs), so it
 * never mangles ordinary prose. Names are handled at the prompt level (the employee is referred to
 * generically; peer feedback is anonymous), not by this regex.
 */
export function redactPII(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b\d{6}-\d{2}-\d{4}\b/g, '[id]') // MY IC, dashed: YYMMDD-PB-###G
    .replace(/\b\d{12}\b/g, '[id]') // MY IC, undashed
    .replace(/\b(?:\+?6?0)\d[\d\s-]{6,}\d\b/g, '[phone]') // MY phone-like runs
    .trim();
}

/**
 * A single, non-streaming LLM call. Adaptive thinking (this is a reasoning-shaped task) and a tight
 * system prompt that asks for the final prose only. Drafts are short, so non-streaming is safe.
 * Returns the concatenated text blocks. Throws `AiNotConfiguredError` when no key is set.
 */
export async function generateDraft(args: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const message = await client().messages.create({
    model: aiModel(),
    max_tokens: args.maxTokens ?? 2048,
    thinking: { type: 'adaptive' },
    system: args.system,
    messages: [{ role: 'user', content: args.prompt }],
  });
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}
