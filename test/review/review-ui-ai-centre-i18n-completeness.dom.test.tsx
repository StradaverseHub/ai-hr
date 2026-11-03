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
// Wave 1 integration (AI v2 Phase 2): templates that are only their arguments and punctuation; the statutory bodies'
// own names (EPF, SOCSO, EIS, PCB, PCB (CP39)), which every locale uses as they are; and "HR". Malay also writes Status,
// Bonus and Audit as English does.
const ARGUMENTS_ONLY = ['aiCentre.autonomy.summaryNamed', 'aiCentre.autonomy.promote.actual.changed', 'aiCentre.payrollCycle.salary.runLine',
  'aiCentre.payrollCycle.salaryPage.cause', 'payrollAudit.stepLabel', 'payrollAudit.pack.captureLine', 'payrollAudit.pack.findingItem'];
const BODIES = ['aiCentre.payrollCycle.bodies.epf', 'aiCentre.payrollCycle.bodies.socso', 'aiCentre.payrollCycle.bodies.eis', 'aiCentre.payrollCycle.bodies.pcb',
  'payrollAudit.forms.epf', 'payrollAudit.forms.pcb_cp39', 'today.autonomy.byHr'];
// AI v2 Phase 2 P2-5 (the Living Handbook): "v{version}" and "RM {amount}", an argument with the version mark and the ringgit sign.
const HANDBOOK = ['aiCentre.policies.versionShort', 'aiCentre.policies.values.money'];
// Wave 2 (P2-6, AI quality): a proposal's place is only its arguments and a separator ("{loop} · {company}"), and the product
// area named "AI Centre" is the product's name in every locale; Malay writes Status as English does.
const QUALITY = ['aiCentre.quality.proposals.where', 'aiCentre.quality.areas.ai'];
const PHASE2 = [...ARGUMENTS_ONLY, ...BODIES, ...HANDBOOK, ...QUALITY];
const SAME_AS_ENGLISH_ALLOWED: Readonly<Record<string, readonly string[]>> = { ms: ['aiCentre.how.layers.model', LOOP_STEP, 'aiCentre.loops.cases.columns.status', ...PHASE2,
  'aiCentre.autonomy.actions.columns.status', 'aiCentre.payrollCycle.salaryPage.columns.status', 'aiCentre.payrollCycle.runType.bonus', 'aiCentre.payrollCycle.byCompany.columns.audit',
  'aiCentre.quality.gaps.status'],
  zh: [LOOP_STEP, ...PHASE2], vi: [LOOP_STEP, ...PHASE2], ta: [LOOP_STEP, ...PHASE2], th: [LOOP_STEP, ...PHASE2] };

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
      loop: 'Missed clock-outs', company: 'Fictional Ceria Sdn Bhd', kind: 'Overtime',
      // Argument of the letter request card title (aiCentre.conversation.letterRequest*, slice 3).
      letterType: 'Employment confirmation',
      // Arguments of the HR capacity ledger (aiCentre.capacity.*, AI v2 Phase 2 P2-4) and the "Before payroll" checklist
      // (payrollReadiness.*, AI v2 Phase 2 P2-3); month, from and to are shared by both.
      hours: '38.5', minutes: '3', values: 'June 0 hours', month: 'September', cap: 15, max: 1440, from: 'Jun 16, 2026', to: 'Sep 13, 2026',
      cases: 40, completed: 36, actions: 52, perCase: '1.3', min: 10, label: 'Annual Leave',
      // Wave 1 integration: arguments of the autonomy ladder (aiCentre.autonomy.*, today.autonomy.*, P2-1), the Payroll cycle
      // pages (aiCentre.payrollCycle.*, P2-2a) and the Audit loop (payrollAudit.*, P2-2b), none of which this list carried.
      status: 'processed', level: 'Prepare', reason: 'limit', condition: 'roster end', percent: '1%', size: 5, week: 'Nov 2',
      sponsor: 'Aisyah Fictional', asker: 'Ravi Fictional', actor: 'AI Centre loop', cutOff: 'Nov 20', payDay: 'Nov 28', due: 'Dec 15',
      started: 1, type: 'Salary', interval: 'Checked daily', threshold: '15%', exclusions: 1, source: 'set by an administrator', seq: 1,
      cause: 'Salary change', bodies: 'PCB', swing: '31.1%', pattern: 'Meal Allowance', expected: 5, flags: 6, share: '83.33%', problems: 1,
      corrected: 1, applied: 120, by: 'Aisyah Fictional', released: 40, prepared: 4, forms: 5, filed: 3, matched: 1, disposed: 1,
      changed: 'Nov 25', last4: '5678', people: 2, paid: 2, lastDay: 'Oct 31', runType: 'Salary', runSeq: 1, closedAt: 'Nov 26, 2026',
      releasedAt: 'Nov 27, 2026', control: 'Shared bank account', action: 'unlock', at: 'Nov 28, 2026', note: 'Late overtime',
      head: 'a1b2c3d4', chained: 12, who: 'Aisyah Fictional', state: 'Open', id: 'u-1',
      // AI v2 Phase 2 P2-5: arguments of the Living Handbook (aiCentre.policies.*).
      author: 'Aisyah Fictional', handbook: 'RM 0.60 per km', system: 'RM 0.55 per km', owner: 'claims', setting: 'Mileage rates',
      message: 'The first mileage band must start at 0 km', accepted: 2, rejected: 1,
      // Wave 2: arguments of AI quality (aiCentre.quality.*, P2-6) this list did not carry.
      helpful: 4, marked: 5, unchanged: 7, decided: 9, edited: '11.1%', editedCount: 1, discarded: 1, questions: 6, roles: 'Employee, Manager',
      intent: 'Could not answer about leave', signal: 'A prepared action was discarded', role: 'Employee', locale: 'Malay',
      example: 'Can NAME_A take leave on DATE_A?', expectation: 'Gives the balance in one line.' };
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
