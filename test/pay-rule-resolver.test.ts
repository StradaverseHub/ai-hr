/**
 * Payroll Setup — pure-unit tests for the pay-rule resolver/validator (core/pay-rule.ts). No DB, no AI.
 * The whole "eval-injection / sandbox-escape" class is GONE — there is no string to inject into; this is a
 * typed discriminated union resolved by a switch. We assert: each kind resolves correctly; validatePayRule
 * accepts valid + rejects out-of-enum, out-of-bounds, and the per_day/per_hour-on-a-prorating-component
 * conflict; and the finite-guard fails closed on a corrupted value.
 */
import { describe, expect, it } from 'vitest';
import {
  PayRuleEvalError,
  resolvePayRule,
  validatePayRule,
  type PayRule,
} from '../core/pay-rule';

const scope = { basic: 5000, daysWorked: 20, hours: 160 };

describe('resolvePayRule', () => {
  it('null / fixed ⇒ the caller-supplied amount (byte-identical to legacy)', () => {
    expect(resolvePayRule(null, scope, 1234.56)).toBe(1234.56);
    expect(resolvePayRule({ kind: 'fixed' }, scope, 1234.56)).toBe(1234.56);
  });
  it('percent_of basic ⇒ pct% of the resolved BASIC', () => {
    expect(resolvePayRule({ kind: 'percent_of', base: 'basic', pct: 10 }, scope, 0)).toBeCloseTo(500, 6);
    expect(resolvePayRule({ kind: 'percent_of', base: 'basic', pct: 150 }, scope, 0)).toBeCloseTo(7500, 6);
  });
  it('per_day ⇒ rate × days_worked (no division)', () => {
    expect(resolvePayRule({ kind: 'per_day', rate: 50 }, scope, 0)).toBeCloseTo(1000, 6);
  });
  it('per_hour ⇒ rate × hours (no division)', () => {
    expect(resolvePayRule({ kind: 'per_hour', rate: 12 }, scope, 0)).toBeCloseTo(1920, 6);
  });
  it('flat_capped ⇒ min(value, cap)', () => {
    expect(resolvePayRule({ kind: 'flat_capped', value: 800, cap: 500 }, scope, 0)).toBe(500);
    expect(resolvePayRule({ kind: 'flat_capped', value: 300, cap: 500 }, scope, 0)).toBe(300);
  });
  it('zero days / zero hours resolve to 0 — never a division-by-zero abort', () => {
    const empty = { basic: 0, daysWorked: 0, hours: 0 };
    expect(resolvePayRule({ kind: 'per_day', rate: 50 }, empty, 0)).toBe(0);
    expect(resolvePayRule({ kind: 'per_hour', rate: 12 }, empty, 0)).toBe(0);
  });
  it('finite-guard: a corrupted (non-finite) value fails closed with PayRuleEvalError', () => {
    // A corrupted JSONB rate (NaN) is unreachable through a validated rule, but the resolver fails closed.
    expect(() => resolvePayRule({ kind: 'per_day', rate: NaN } as PayRule, scope, 0)).toThrow(PayRuleEvalError);
  });
});

describe('validatePayRule', () => {
  it('accepts null + every well-formed kind (non-prorating component)', () => {
    expect(validatePayRule(null, false).ok).toBe(true);
    expect(validatePayRule({ kind: 'fixed' }, false).ok).toBe(true);
    expect(validatePayRule({ kind: 'percent_of', base: 'basic', pct: 10 }, false).ok).toBe(true);
    expect(validatePayRule({ kind: 'per_day', rate: 50 }, false).ok).toBe(true);
    expect(validatePayRule({ kind: 'per_hour', rate: 12 }, false).ok).toBe(true);
    expect(validatePayRule({ kind: 'flat_capped', value: 300, cap: 500 }, false).ok).toBe(true);
  });
  it('rejects an out-of-enum kind ⇒ BAD_KIND', () => {
    const r = validatePayRule({ kind: 'gross_of', base: 'gross', pct: 10 } as unknown as PayRule, false);
    expect(r).toEqual({ ok: false, code: 'BAD_KIND' });
  });
  it('rejects percent_of with a non-basic base ⇒ BAD_KIND', () => {
    const r = validatePayRule({ kind: 'percent_of', base: 'gross', pct: 10 } as unknown as PayRule, false);
    expect(r).toEqual({ ok: false, code: 'BAD_KIND' });
  });
  it('rejects out-of-bounds numbers ⇒ OUT_OF_RANGE', () => {
    expect(validatePayRule({ kind: 'percent_of', base: 'basic', pct: 5000 }, false)).toEqual({ ok: false, code: 'OUT_OF_RANGE' });
    expect(validatePayRule({ kind: 'per_day', rate: -5 }, false)).toEqual({ ok: false, code: 'OUT_OF_RANGE' });
    expect(validatePayRule({ kind: 'per_hour', rate: Infinity }, false)).toEqual({ ok: false, code: 'OUT_OF_RANGE' });
    expect(validatePayRule({ kind: 'flat_capped', value: -1, cap: 500 }, false)).toEqual({ ok: false, code: 'OUT_OF_RANGE' });
  });
  it('rejects a per_day / per_hour rule on a PRORATING component ⇒ PRORATION_CONFLICT (no double-proration)', () => {
    expect(validatePayRule({ kind: 'per_day', rate: 50 }, true)).toEqual({ ok: false, code: 'PRORATION_CONFLICT' });
    expect(validatePayRule({ kind: 'per_hour', rate: 12 }, true)).toEqual({ ok: false, code: 'PRORATION_CONFLICT' });
  });
  it('period-agnostic kinds are allowed on a prorating component (the kernel prorates them as today)', () => {
    expect(validatePayRule({ kind: 'percent_of', base: 'basic', pct: 10 }, true).ok).toBe(true);
    expect(validatePayRule({ kind: 'flat_capped', value: 300, cap: 500 }, true).ok).toBe(true);
    expect(validatePayRule({ kind: 'fixed' }, true).ok).toBe(true);
  });
});
