/**
 * Value-level guard for the "Create Payroll Run Cycle" rename (R8).
 *
 * The general i18n coverage test (test/i18n-coverage.test.ts, Check A) only asserts key
 * PRESENCE and non-empty/non-null — it passes identically whether a non-English locale is
 * correctly re-translated, left stale, or pasted with raw English. It gives zero signal on
 * this rename's actual caption.
 *
 * This closes that CI gap deterministically for the two renamed surfaces (the button caption
 * `payroll.list.newRun` and the guided-tour copy `payroll.tour.create`): every locale carries a
 * non-empty value, the English caption/title/body match the new wording, and each non-English
 * locale differs from English (catching a future regression to English or a blank). It does NOT
 * assert semantic translation quality — that remains human translator review.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MESSAGES = path.resolve(__dirname, '../messages');
const NON_EN_LOCALES = ['ms', 'ta', 'th', 'vi', 'zh'] as const;

type Dict = Record<string, unknown>;
const load = (loc: string): Dict => JSON.parse(fs.readFileSync(path.join(MESSAGES, `${loc}.json`), 'utf8'));
const getPath = (obj: Dict, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

const NEW_CAPTION_KEY = 'payroll.list.newRun';
// Guided-tour copy lives under the onboarding namespace (lib/module-tours.json references it as
// tour.payroll.create.*, i.e. onboarding.tour.payroll.create.*), NOT under payroll.tour.
const TOUR_TITLE_KEY = 'onboarding.tour.payroll.create.title';
const TOUR_BODY_KEY = 'onboarding.tour.payroll.create.body';

describe('payroll "Create Payroll Run Cycle" rename — value-level i18n guard', () => {
  const en = load('en');

  it('English caption and tour copy carry the new "Create Payroll Run Cycle" wording', () => {
    expect(getPath(en, NEW_CAPTION_KEY)).toBe('Create Payroll Run Cycle');
    expect(getPath(en, TOUR_TITLE_KEY)).toBe('Create Payroll Run Cycle');
    // body keeps its surrounding sentence + bold markers; only the label token inside the bold changed.
    expect(getPath(en, TOUR_BODY_KEY)).toContain('**Create Payroll Run Cycle**');
    // the old caption must not survive anywhere in the English strings.
    expect(getPath(en, NEW_CAPTION_KEY)).not.toBe('New payroll run');
    expect(getPath(en, TOUR_BODY_KEY)).not.toContain('New payroll run');
  });

  it('every non-English locale carries a non-empty caption + tour copy, distinct from English', () => {
    const enCaption = getPath(en, NEW_CAPTION_KEY);
    const enTitle = getPath(en, TOUR_TITLE_KEY);
    for (const loc of NON_EN_LOCALES) {
      const dict = load(loc);
      const caption = getPath(dict, NEW_CAPTION_KEY);
      const title = getPath(dict, TOUR_TITLE_KEY);
      const body = getPath(dict, TOUR_BODY_KEY);

      expect(typeof caption, `${loc} ${NEW_CAPTION_KEY}`).toBe('string');
      expect((caption as string).trim().length, `${loc} ${NEW_CAPTION_KEY} empty`).toBeGreaterThan(0);
      expect(caption, `${loc} caption regressed to English`).not.toBe(enCaption);

      expect(typeof title, `${loc} ${TOUR_TITLE_KEY}`).toBe('string');
      expect((title as string).trim().length, `${loc} ${TOUR_TITLE_KEY} empty`).toBeGreaterThan(0);
      expect(title, `${loc} tour title regressed to English`).not.toBe(enTitle);

      expect(typeof body, `${loc} ${TOUR_BODY_KEY}`).toBe('string');
      expect((body as string).trim().length, `${loc} ${TOUR_BODY_KEY} empty`).toBeGreaterThan(0);
      // markdown-bold markers must survive the re-translation.
      expect(body as string, `${loc} tour body lost bold markers`).toMatch(/\*\*.+\*\*/);
    }
  });
});
