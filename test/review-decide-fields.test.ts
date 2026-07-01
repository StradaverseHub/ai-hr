/**
 * Probation / contract / internship review — HR-decision progressive-disclosure field map (R4 Build #4).
 *
 * The decide form is a UI-only progressive-disclosure island: selecting Confirm / Extend / Terminate
 * reveals ONLY that decision's fields. The suite has no DOM tooling, so these tests assert the pure field
 * map (`fieldsForDecision` — the single source of truth the client component keys off) instead of rendering
 * the component. The behavioural guarantees "the recorded decision is unchanged from today" and "no auto
 * date-move / terminate" live in test/employment-review.test.ts (the advisory `decideReview` test, left
 * untouched) — this file only proves the disclosure logic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REVIEW_DECISIONS,
  TERMINATION_REASONS,
  fieldsForDecision,
  isFieldRequired,
} from '../app/approvals/review-decide-fields';

describe('review decide — progressive disclosure field map', () => {
  it('confirm reveals NO extra fields (single-step submit)', () => {
    expect(fieldsForDecision('confirm')).toEqual([]);
  });

  it('extend reveals ONLY the new end date (required) + extension reason (optional)', () => {
    expect(fieldsForDecision('extend')).toEqual(['extendToDate', 'extensionReason']);
    expect(isFieldRequired('extendToDate')).toBe(true); // New End Date is required
    expect(isFieldRequired('extensionReason')).toBe(false); // reason is optional
  });

  it('terminate reveals ONLY the termination-reason dropdown (required)', () => {
    expect(fieldsForDecision('terminate')).toEqual(['terminationReason']);
    expect(isFieldRequired('terminationReason')).toBe(true);
  });

  it('each decision reveals a DISJOINT field set — no cross-branch field leaks', () => {
    const confirm = new Set(fieldsForDecision('confirm'));
    const extend = new Set(fieldsForDecision('extend'));
    const terminate = new Set(fieldsForDecision('terminate'));
    // confirm shows nothing that extend/terminate show
    expect([...extend].some((f) => confirm.has(f))).toBe(false);
    expect([...terminate].some((f) => confirm.has(f))).toBe(false);
    // extend and terminate never share a field (their required inputs are distinct)
    expect([...extend].some((f) => terminate.has(f))).toBe(false);
  });

  it('exposes exactly the three HR decisions in select order', () => {
    expect(REVIEW_DECISIONS).toEqual(['confirm', 'extend', 'terminate']);
  });

  it('exposes the advisory termination-reason vocabulary', () => {
    expect([...TERMINATION_REASONS]).toEqual([
      'contract_end',
      'involuntary',
      'voluntary',
      'retired',
      'death',
      'other',
    ]);
  });
});

/** i18n presence guard: every label the decide form renders must resolve in ALL 6 locales (the coverage
 *  test catches missing keys generally, but this asserts the specific new review keys directly). */
describe('review decide — i18n keys present in all 6 locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const load = (loc: string) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'messages', `${loc}.json`), 'utf8')).review;

  it('extensionReason + terminationReason.{label,placeholder,<reason>} exist and are non-empty', () => {
    for (const loc of LOCALES) {
      const r = load(loc);
      expect(r.extensionReason, `${loc}.extensionReason`).toBeTruthy();
      expect(r.terminationReason?.label, `${loc}.terminationReason.label`).toBeTruthy();
      expect(r.terminationReason?.placeholder, `${loc}.terminationReason.placeholder`).toBeTruthy();
      for (const reason of TERMINATION_REASONS) {
        expect(r.terminationReason?.[reason], `${loc}.terminationReason.${reason}`).toBeTruthy();
      }
      // extendToDate (New End Date) is reused, not renamed — must still exist.
      expect(r.extendToDate, `${loc}.extendToDate`).toBeTruthy();
    }
  });
});
