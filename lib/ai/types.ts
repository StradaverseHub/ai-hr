/**
 * Provider abstraction for the AI gateway (ADR-0023). One narrow interface every provider adapter
 * implements, so the rest of the app is provider-agnostic. Draft-only: adapters generate text and
 * validate credentials; they never persist anything.
 */
export type AiProvider = 'anthropic' | 'openai' | 'google';

/** Resolved, ready-to-use config for one generation — the decrypted key lives only in request memory. */
export type ResolvedAiConfig = {
  provider: AiProvider;
  model: string;
  apiKey: string;
};

export type GenerateArgs = {
  system: string;
  prompt: string;
  maxTokens?: number;
};

/** Result of a credential/model probe. `error` is a GENERIC reason — never raw SDK/provider text. */
export type ValidateResult = { ok: boolean; error?: string };

export interface AiAdapter {
  readonly provider: AiProvider;
  /** Single non-streaming generation. Throws `AiGatewayError` (generic) on any provider failure. */
  generate(cfg: ResolvedAiConfig, args: GenerateArgs): Promise<string>;
  /** Cheapest check that the key+model are usable. Returns ok/false + a generic reason; never throws. */
  validate(cfg: ResolvedAiConfig): Promise<ValidateResult>;
}

/** Generic, client-safe gateway error — provider SDK errors are mapped to this so no key fragment or
 *  raw provider body ever reaches a log, a server-action return, or the browser. */
export class AiGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiGatewayError';
  }
}
