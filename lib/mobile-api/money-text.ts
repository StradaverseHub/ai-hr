/**
 * An owner's amount as a two-place decimal string for the mobile v2 contracts — moved verbatim from
 * lib/mobile-api/pay-routes.ts (M09) so a core composition (core/mobile-claims.ts, M11) can use the same
 * formatting. Dependency-free and free of 'server-only'; pay-routes.ts re-exports it unchanged.
 *
 * `formatMoney`'s coercion (a numeric string or a number) and its two places, half away from zero — without the
 * grouping or the currency prefix. Null where the web prints '—'. Formatting, not arithmetic: the figure is the
 * owner's.
 */
export function moneyText(n: unknown): string | null {
  // An owner decimal string is padded as text, never through a float; an empty or non-decimal string is absent
  // (Number('') is 0, and an absent box must never print as 0.00).
  if (typeof n === 'string') {
    // Database numeric text may carry trailing zero scale ("12.3400"); a non-zero third place is not a sen amount.
    const m = /^(-?)(\d+)(?:\.(\d{1,2})(0*))?$/.exec(n.trim());
    if (!m) return null;
    const fixed = `${m[2].replace(/^0+(?=\d)/, '')}.${(m[3] ?? '').padEnd(2, '0')}`;
    return m[1] && fixed !== '0.00' ? `-${fixed}` : fixed;
  }
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const fixed = Math.abs(n).toFixed(2);
  return n < 0 && fixed !== '0.00' ? `-${fixed}` : fixed;
}
