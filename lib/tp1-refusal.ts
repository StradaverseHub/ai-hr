import { getTranslations } from 'next-intl/server';
// THROUGH THE PACK FACADE, not `core/tax-relief` directly (ADR-0080 D9/D11), exactly as
// lib/tp1-form-input.ts does. test/payroll-pack-drift.test.ts fails the build for a new direct import —
// the allowlist only ever shrinks — and it caught this file on its first run.
import { Tp1LimitError } from '@/packs/payroll/service';

/**
 * ══ A TP1 LIMIT REFUSAL, SAID IN THE READER'S LANGUAGE (r352, item 0df7dd44) ════════════════════════
 *
 * ⚠️ WHAT WAS WRONG: the refusals were prepared ENGLISH SENTENCES built inside `core/tax-relief.ts`, and
 * the actions put them straight on the screen. Five of the six locales therefore showed English to a
 * reader filling in a Malay statutory form. The kernel cannot fix that itself — it has no request, no
 * locale and no message catalogue, and giving it one would put a screen concern inside the money code.
 *
 * So the kernel states WHAT it refused (`Tp1LimitError.breach`: which box, its limit, what is already
 * approved this assessment year, what is therefore left) and this — the UI layer, where the request and
 * the locale live — says it. ONE translator for BOTH surfaces (the HR admin-on-behalf action and the
 * employee's own /me action), because the same refusal reaching two screens in two wordings is how a
 * reader learns not to trust either.
 *
 * ⚠️ EVERY RINGGIT FIGURE IS INTERPOLATED, NEVER WRITTEN INTO A CATALOGUE. The annual limits are the
 * country pack's (`payroll.taxReliefCatalogue`); a statutory number restated in six message files is six
 * copies that do not move when the law does, which is the mistake the legacy "RM 9,000" help text made
 * and test/tp1-2026-form.test.ts now fails the build over.
 *
 * Anything that is NOT a limit refusal keeps its own message. A missing employee, an unticked Section E
 * declaration or a self-approval refusal are already single sentences with no figures in them, and
 * inventing a second catalogue for them is a different item.
 */

const rm = (n: number) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The message a TP1 write failure should put in front of the reader.
 *
 * Note the fallback: `(e as Error).message`. That is deliberate rather than lazy — a refusal this
 * function does not recognise must still be SHOWN, in English, rather than swallowed into a generic
 * "something went wrong". A silent failure on a statutory form is worse than an untranslated true one.
 */
export async function tp1RefusalMessage(e: unknown): Promise<string> {
  if (!(e instanceof Tp1LimitError)) return (e as Error).message;
  const t = await getTranslations('taxRelief.limit');
  const b = e.breach;
  if (b.code === 'annualRemaining') {
    return t('annualRemaining', {
      label: b.label,
      limit: rm(b.limit),
      already: rm(b.already ?? 0),
      // ⚠️ limit − already, never the limit. The same number the screen clamps to.
      remaining: rm(b.remaining),
      over: rm(b.over),
    });
  }
  return t(b.code === 'lineLimit' ? 'lineLimit' : 'itemLimit', {
    label: b.label,
    limit: rm(b.limit),
    claim: rm(b.claim),
  });
}
