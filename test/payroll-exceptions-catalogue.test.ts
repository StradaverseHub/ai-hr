/**
 * AI-native batch (11 November 2026) — the grouped Exceptions page's plain-language catalogue.
 *
 * Fails the build when:
 *  - a payroll check in the detector registry (or the hypothesis id) has no catalogue entry;
 *  - any message the catalogue or the page can ask for is missing, blank or unparseable in any shipped locale;
 *  - any of that copy, rendered with sample values, shows a field name, check id, UUID, camelCase word or an internal
 *    term ("verdict", "detector") — the owner's rule for this page;
 *  - the two reasons a bank profile can be missing share copy with each other or with the generic fallback;
 *  - the pay-change copy hard-codes a percentage (the threshold is the company's own, owner decision 11 November).
 * Pure: reads the catalogue files; no database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { DETECTORS, HYPOTHESIS_DETECTOR_ID } from '../core/payroll-anomaly-detectors';
import { locales } from '../i18n/config';
import {
  BANK_REASONS, CATALOGUE, DETAIL_KEYS, HYPOTHESIS_CHECK_ID, KNOWN_COMPONENTS, NET_SWING_CAUSES, catalogueMessageKeys, checkCopy, entryOf,
} from '../lib/payroll-exceptions';

type Dict = Record<string, unknown>;
const ROOT = path.resolve(__dirname, '..');
const grouped = (locale: string): Dict => {
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/ai-centre', `${locale}.json`), 'utf8')) as Dict;
  return ((file.aiCentre as Dict).exceptions as Dict).grouped as Dict;
};
const leaves = (node: Dict, prefix = '', out: Record<string, unknown> = {}) => {
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v as Dict, key, out); else out[key] = v;
  }
  return out;
};
const get = (node: Dict, dotted: string) => dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), node);

/** Sample values for every argument any of this copy takes. None of them is itself a field name. */
const SAMPLE = {
  total: 135, blocking: 38, groups: 6, people: 31, exceptions: 33, runs: 9, names: 'Demo Sdn Bhd, Fictional Bhd', more: 6, count: 9,
  page: 2, pages: 4, date: '28 Oct 2026', checks: 'No tax profile', component: 'Bonus', grossPay: 'MYR 100.00', totalDeductions: 'MYR 400.00',
  netPay: 'MYR 1,200.00', actual: 'MYR 300.00', cap: 'MYR 250.00', excess: 'MYR 50.00', pcb: 'MYR 12.00', daysWorked: 20, periodDays: 31,
  others: 2, direction: 'down', pct: 82.3, causes: 'a salary change, overtime', priorNetPay: 'MYR 6,386.55', amount: 'MYR 5,000.00', priorAmount: 'MYR 200.00',
};
/** What must never be rendered on this page. */
const JARGON = [/\b[a-z]+[A-Z][A-Za-z]*\b/, /verdict/i, /detector/i, /[0-9a-f]{8}-[0-9a-f]{4}-/i, /_/, /\{|\}/,
  ...Object.keys(CATALOGUE).filter(id => id.includes('-')).map(id => new RegExp(id))];

describe('every check the page can show has plain-language copy', () => {
  it('names every detector in the registry, and the hypothesis id', () => {
    expect(DETECTORS.length).toBeGreaterThanOrEqual(11);
    const missing = [...DETECTORS.map(d => d.id), HYPOTHESIS_DETECTOR_ID].filter(id => entryOf(id) === null);
    expect(missing, `catalogue entries missing for: ${missing.join(', ')}`).toEqual([]);
    expect(HYPOTHESIS_CHECK_ID).toBe(HYPOTHESIS_DETECTOR_ID);
  });

  it('a check nobody catalogued still gets generic copy, never its id', () => {
    expect(entryOf('a-check-added-later')).toBeNull();
    expect(checkCopy('a-check-added-later', null)).toEqual({ title: 'check.unknown.title', why: 'check.unknown.why', todo: 'check.unknown.todo' });
    expect(entryOf('__proto__')).toBeNull();
  });

  it.each([...locales])('%s: every key the catalogue and the page ask for exists, is not blank and renders without jargon', locale => {
    const en = leaves(grouped('en'));
    const mine = grouped(locale);
    const flat = leaves(mine);
    // Same keys as English, all filled.
    expect(Object.keys(flat).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(flat)) expect(typeof value === 'string' && value.trim() !== '', `${locale} ${key}`).toBe(true);
    const required = [...catalogueMessageKeys(), ...DETAIL_KEYS, ...KNOWN_COMPONENTS.map(c => `component.${c}`), 'component.other',
      ...NET_SWING_CAUSES.map(c => `cause.${c}`), 'cause.other', 'tag.blocks', 'tag.blocksClosed', 'list.runClosed'];
    for (const key of required) expect(typeof get(mine, key), `${locale} ${key}`).toBe('string');
    // Every message parses and formats with real values, and what it renders is plain words.
    const t = createTranslator({ locale, messages: { g: mine } as never, namespace: 'g' as never, onError: error => { throw error; } });
    for (const key of Object.keys(flat)) {
      const rendered = (t as unknown as (k: string, v: Record<string, unknown>) => string)(key, SAMPLE);
      for (const pattern of JARGON) expect(rendered, `${locale} ${key}: ${rendered}`).not.toMatch(pattern);
    }
  });

  it('the two reasons a bank profile can be missing each have their own copy, distinct from the generic one', () => {
    const [unset, missing] = BANK_REASONS.map(reason => checkCopy('missing-bank-profile', reason));
    const generic = checkCopy('missing-bank-profile', null);
    expect(new Set([unset.title, missing.title, generic.title]).size).toBe(3);
    expect(checkCopy('missing-bank-profile', 'something-else')).toEqual(generic);
    for (const locale of locales) {
      const g = grouped(locale);
      const titles = [unset, missing, generic].map(c => get(g, c.title));
      const whys = [unset, missing, generic].map(c => get(g, c.why));
      expect(new Set(titles).size, locale).toBe(3);
      expect(new Set(whys).size, locale).toBe(3);
    }
    expect(get(grouped('en'), unset.title)).toBe('We don’t know how to pay these people');
    expect(get(grouped('en'), missing.title)).toBe('Paid by bank transfer, but no bank account');
  });

  it('the pay-change copy says nothing in payroll explains it, and never hard-codes a threshold', () => {
    expect(get(grouped('en'), 'check.netSwing.title')).toBe('Pay changed more than usual, and nothing in payroll explains it');
    for (const locale of locales) {
      const g = grouped(locale);
      for (const key of ['check.netSwing.title', 'check.netSwing.why', 'check.netSwing.todo']) expect(get(g, key), `${locale} ${key}`).not.toMatch(/\d/);
    }
  });
});
