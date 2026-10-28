/** Predefined public replies. Never interpolate a caught exception, identifier or hidden record fact.
 * A missing and an inaccessible record use exactly the same access wording.
 */
export const ASSISTANT_PUBLIC_REPLIES = Object.freeze({
  access: 'That door is staying closed for now. I cannot show that information with your current access. Your HR administrator can help check your access.',
  lookup: 'That lookup hit a little speed bump. Please try again in a moment.',
  tool: 'That shortcut is not available here. Try asking another way.',
  arguments: 'I need a little more to go on. Please check the details and try again.',
});

/** Internal refusal codes stay in the server audit, not in the model's reply material. */
export function assistantPublicToolResult(outcome: ({ ok: true } & Record<string, unknown>) | { ok: false; message: string }) {
  return outcome.ok ? outcome : Object.freeze({ ok: false, message: outcome.message });
}
