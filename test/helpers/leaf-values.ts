/**
 * Assert a secret is absent from a DomainEvent payload — by VALUE, never by substring.
 *
 * WHY THIS EXISTS
 * ---------------
 * The natural way to write "the cleartext amount never reaches the event log" is
 *
 *     expect(JSON.stringify(payload)).not.toContain('275');
 *
 * and it is wrong twice over.
 *
 * FLAKY. A DomainEvent payload carries ids, and ids are random UUIDs whose hex digits are drawn from
 * `0-9a-f` — so a decimal needle made only of hex characters can appear inside one by chance. For a
 * 3-digit needle the odds are (32 - 3 + 1) windows x (1/16)^3 ≈ **0.73% per UUID in the payload**;
 * cp38's loop checks two needles across three payloads, which is the ~1% per-run gate failure that was
 * actually observed. `test/zakat-history.test.ts` hit the identical bug first — a company UUID of
 * `8977a24e-6add-4584-ac1a-066711009fc2` contains `100` — and was patched in 91b2e4d; this helper
 * generalises that fix so the next test does not have to rediscover it.
 *
 * WEAK. A substring scan only ever catches the ONE literal it was given. An amount stored under a
 * different value, or a rounded/formatted variant, sails straight through — so the assertion is at its
 * least trustworthy exactly when it matters.
 *
 * THE FIX. Flatten the payload to its leaf values and compare each WHOLE value against the secret. An
 * id that merely *contains* the digits can never trip it, while a genuine amount field always does —
 * in any position, at any depth, whatever the key is called. Numeric secrets are checked in their
 * number, string and 2dp-string forms, because a leaked amount can be serialised any of those ways.
 */

/** Every leaf (non-object) value in a nested structure, in traversal order. */
export function leafValues(v: unknown): unknown[] {
  return v !== null && typeof v === 'object' ? Object.values(v).flatMap(leafValues) : [v];
}

/**
 * Assert `secret` appears nowhere as a leaf VALUE of `payload`.
 *
 * A number is checked as the number, as `String(n)`, and as `n.toFixed(2)` — the three shapes an
 * amount realistically serialises into. Pass the raw secret, not a pre-stringified one.
 */
export function expectNoLeakedValue(payload: unknown, secret: number | string): void {
  const leaves = leafValues(payload);
  const forms: unknown[] =
    typeof secret === 'number' ? [secret, String(secret), secret.toFixed(2)] : [secret];
  for (const form of forms) {
    if (leaves.includes(form)) {
      throw new Error(
        `Expected no leaked value, but found ${JSON.stringify(form)} as a leaf of the payload.\n` +
          `Leaves: ${JSON.stringify(leaves)}`,
      );
    }
  }
}
