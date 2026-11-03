/** REVIEW (independent UI/i18n review) — drafted as test/review/ai-centre-i18n-completeness.dom.test.tsx.
 *
 * PASSING coverage test. Pins what the review verified on 7d57fc6a4:
 *  - every key in messages/ai-centre/en.json exists, non-empty, in ms, zh, vi, ta and th, with no extra keys;
 *  - every ICU argument name ({name}, {count}, ...) in English is the same set in each locale (parsed by
 *    brace depth, so plural branch text such as `=0 {Today}` is not mistaken for an argument);
 *  - no non-English value is identical to English except an explicit allowlist;
 *  - every enumerated key the AI centre components build at runtime exists in English
 *    (tab keys, subnav labels, worker families/triggers/effects, recommendation checks/verdicts);
 *  - every value formats through next-intl without throwing, in every locale. */
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '../../messages/ai-centre/en.json';
import ms from '../../messages/ai-centre/ms.json';
import zh from '../../messages/ai-centre/zh.json';
import vi from '../../messages/ai-centre/vi.json';
import ta from '../../messages/ai-centre/ta.json';
import th from '../../messages/ai-centre/th.json';
import { ADMIN_GROUPS, CENTRE_SECTIONS, CENTRE_TABS } from '../../lib/ai-centre/centre-nav';
import { BUILT_IN_PLACEMENT, FEATURE_PLACEMENT, WORKER_FAMILIES } from '../../lib/ai-centre/worker-families';
import { RECOMMENDATION_CHECKS, RECOMMENDATION_VERDICTS } from '../../core/semantic-model/entities-recommend';

type Dict = Record<string, unknown>;
const LOCALES = { ms, zh, vi, ta, th } as const;
/** Values that may legitimately equal English (a loanword, the untranslated product name). */
// AI v2 W8 loops: the step label is only its two arguments and a separator ("{n} · {step}"), and Malay's word for a
// case's status column is "Status" as in English.
const LOOP_STEP = 'aiCentre.loops.stepLabel';
const SAME_AS_ENGLISH_ALLOWED: Readonly<Record<string, readonly string[]>> = { ms: ['aiCentre.how.layers.model', LOOP_STEP, 'aiCentre.loops.cases.columns.status'],
  zh: [LOOP_STEP], vi: [LOOP_STEP], ta: [LOOP_STEP], th: [LOOP_STEP] };

function flat(d: Dict, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flat(v as Dict, key));
    else out[key] = String(v);
  }
  return out;
}
/** ICU argument names. A `{` opened at even depth starts an argument; at odd depth it starts a plural or
 * select branch body. Apostrophe quoting is not used in these catalogues. */
function icuArguments(message: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  for (let i = 0; i < message.length; i++) {
    const ch = message[i];
    if (ch === '{') {
      if (depth % 2 === 0) { const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(message.slice(i + 1)); if (m) names.add(m[1]); }
      depth++;
    } else if (ch === '}') depth--;
  }
  return [...names].sort();
}
const english = flat(en as Dict);

describe('AI centre catalogue completeness', () => {
  it.each(Object.keys(LOCALES) as (keyof typeof LOCALES)[])('REVIEW pass: %s has every English key, non-empty, and no extra keys', locale => {
    const own = flat(LOCALES[locale] as Dict);
    expect(Object.keys(own).filter(key => !(key in english))).toEqual([]);
    expect(Object.keys(english).filter(key => !(key in own))).toEqual([]);
    expect(Object.keys(own).filter(key => own[key].trim() === '')).toEqual([]);
  });

  it.each(Object.keys(LOCALES) as (keyof typeof LOCALES)[])('REVIEW pass: %s keeps the same ICU arguments as English', locale => {
    const own = flat(LOCALES[locale] as Dict);
    const mismatched = Object.keys(english).filter(key => JSON.stringify(icuArguments(english[key])) !== JSON.stringify(icuArguments(own[key] ?? '')));
    expect(mismatched).toEqual([]);
  });

  it.each(Object.keys(LOCALES) as (keyof typeof LOCALES)[])('REVIEW pass: %s translates every value (allowlist aside)', locale => {
    const own = flat(LOCALES[locale] as Dict);
    const allowed = new Set(SAME_AS_ENGLISH_ALLOWED[locale] ?? []);
    expect(Object.keys(english).filter(key => own[key] === english[key] && !allowed.has(key))).toEqual([]);
  });

  it.each(['en', ...Object.keys(LOCALES)])('REVIEW pass: every %s message formats without error', locale => {
    const messages = (locale === 'en' ? en : LOCALES[locale as keyof typeof LOCALES]) as Dict;
    const errors: string[] = [];
    const t = createTranslator({ locale, messages: messages as never, onError: e => { errors.push(e.message); } });
    const values = { name: 'Noveri', osName: 'Noveri OS', count: 2, n: 1, total: 9, area: 'Leave', version: 3, rate: '50%', active: 1, blocked: 1, attention: 2, overdue: 0, dueSoon: 1, when: '2 Nov 2026', date: '2 Nov 2026',
      // Arguments of the live-chat wiring copy (aiCentre.conversation, PR 197), added by claude/teras-review-fixes.
      time: '3:00 pm', reads: 'your leave balances',
      // Arguments of the leave application card title (aiCentre.conversation.leaveApply*Title, issue 10).
      leaveType: 'Annual Leave', start: 'Thu, Nov 5', end: 'Fri, Nov 6', days: 2,
      // Arguments of the own claim and bank change card titles (aiCentre.conversation.claim*Title, profileBankTitle; AI v2 W2).
      claimType: 'Travel', amount: '42.60', bankName: 'Maybank', ending: '5678',
      // Argument of the second tab row's label (aiCentre.sectionsLabel, issue 17).
      tab: 'Operations',
      // Arguments of the "Why?" panels (why.*, AI v2 W5); current and previous are counts in the payslip-runs plural.
      period: 'October 2026', previousPeriod: 'September 2026', current: 2, previous: 1, companies: 'Fictional Ceria Sdn Bhd', items: 'EPF', annual: '14.00 days', display: '12.00 days',
      // Arguments of the loops pages and cards (aiCentre.loops.*, AI v2 W8) and the approver's decision buttons (slice 3).
      done: 'the clock-out is recorded', step: 'Prepare', open: 3, waiting: 1, opened: 5, closed: 2, item: 'Travel claim',
      loop: 'Missed clock-outs', company: 'Fictional Ceria Sdn Bhd', kind: 'Overtime' };
    for (const key of Object.keys(flat(messages))) t(key as never, values as never);
    expect(errors).toEqual([]);
  });

  it('REVIEW pass: every key the components build at runtime exists in English', () => {
    const need = [
      ...CENTRE_TABS.map(tab => `aiCentre.tabs.${tab.key}`),
      ...Object.values(CENTRE_SECTIONS).flat().map(section => `aiCentre.sections.${section.key}`), 'aiCentre.sectionsLabel',
      ...Object.values(ADMIN_GROUPS).flat().map(item => `aiCentre.subnav.${item.label}`),
      ...(['workers', 'setup', 'spend'] as const).flatMap(group => [`aiCentre.titles.${group}`, `aiCentre.descriptions.${group}`]),
      ...WORKER_FAMILIES.flatMap(family => [`aiCentre.workers.families.${family}`, `aiCentre.workers.families.${family}Help`]),
      ...[...Object.values(FEATURE_PLACEMENT), ...Object.values(BUILT_IN_PLACEMENT)].flatMap(p => [`aiCentre.workers.triggers.${p.trigger}`, `aiCentre.workers.effects.${p.effect}`]),
      ...RECOMMENDATION_CHECKS.map(check => `aiCentre.recommendation.check.${check}`),
      ...RECOMMENDATION_VERDICTS.map(verdict => `aiCentre.recommendation.verdict.${verdict}`),
      ...['switched_off', 'stopped', 'not_registered', 'no_login', 'not_assigned', 'not_pending', 'failed'].map(r => `aiCentre.recommendation.unavailable.${r}`),
      ...['exceptions', 'proposals', 'readiness'].flatMap(k => [`aiCentre.inbox.items.${k}Title`, `aiCentre.inbox.items.${k}Source`, `aiCentre.inbox.items.${k}Cta`]),
    ];
    expect(need.length).toBeGreaterThan(40);
    expect(need.filter(key => !(key in english))).toEqual([]);
  });
});
