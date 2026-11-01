/** ADR-0170 step 1 — the model client the harness is given, never one it builds.
 *
 * Product code must not import a provider, gateway or OpenRouter module: that would pull the harness into
 * the approved provider-data closure (scripts/ai-provider-data-source-manifest.mjs). So the harness speaks
 * only this neutral interface. Tests pass a scripted fake (test/harness-ratchet/scripted-model.ts); the
 * real-model probe can supply an OpenRouter client from test code; production wiring (core/teras-wiring/model-client.ts)
 * supplies an adapter over the governed gateway. Types only. */

export type HarnessToolCall=Readonly<{id:string;name:string;arguments:string}>;
export type HarnessMessage=Readonly<
 |{role:'system'|'user';content:string}
 |{role:'assistant';content:string|null;toolCalls?:readonly HarnessToolCall[]}
 |{role:'tool';toolCallId:string;content:string}>;
export type HarnessToolDeclaration=Readonly<{name:string;description:string;parameters:Readonly<Record<string,unknown>>}>;
export type ModelRequest=Readonly<{messages:readonly HarnessMessage[];tools:readonly HarnessToolDeclaration[];toolChoice:'required';
 maxOutputTokens:number;signal:AbortSignal}>;
/** `length` means the output cap cut the answer off. Usage figures are the client's own report; unknown is 0. */
export type ModelResponse=Readonly<{content:string|null;toolCalls:readonly HarnessToolCall[];finish:'stop'|'tool_calls'|'length'|'other';
 usage:Readonly<{inputTokens:number;outputTokens:number;costUsd:number}>}>;
export interface ModelClient{
 /** Recorded in the trace, e.g. `openai/gpt-6-luna`. */
 readonly modelId:string;
 complete(request:ModelRequest):Promise<ModelResponse>;
}
