/**
 * Recruitment slice 23 — the pure reward and fee rules (packs/recruitment/reward-model.ts) and the shape of migration 5875
 * (no database): typed amounts only, the pay months, the reward states from independent dates, the referrer's view, the agency
 * fee form, and the database guards and grants the service relies on.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENCY_FEE_MAX, REFERRAL_REWARD_MAX, myRewardState, parseAmount, parseJobReward, rewardPayMonths, rewardSourceRef, rewardState, validateAgencyFee,
  type RewardHireFacts,
} from '../packs/recruitment/service';

const m5725 = readFileSync(new URL('../db/migrations/5875_recruitment_referral_rewards_agency_fees.sql', import.meta.url), 'utf8');
const section = (from: string, to: string) => {
  const start = m5725.indexOf(from), end = m5725.indexOf(to, start + 1);
  expect(start, from).toBeGreaterThan(-1);
  expect(end, to).toBeGreaterThan(start);
  return m5725.slice(start, end);
};
const hire = (over: Partial<RewardHireFacts> = {}): RewardHireFacts => ({
  employmentId: 'e', personId: 'p', startOn: '2026-01-01', confirmationOn: null, probationEndOn: null, dueOn: '2026-04-01', noProbationDate: false,
  endedOn: null, active: true, ...over,
});

describe('typed amounts', () => {
  it('accepts two-decimal positive amounts up to the maximum and nothing else', () => {
    expect(parseAmount('500', REFERRAL_REWARD_MAX)).toBe('500.00');
    expect(parseAmount(' 1,250.5 ', REFERRAL_REWARD_MAX)).toBe('1250.50');
    expect(parseAmount('0.01', REFERRAL_REWARD_MAX)).toBe('0.01');
    expect(parseAmount('1000000', REFERRAL_REWARD_MAX)).toBe('1000000.00');
    expect(parseAmount(750, REFERRAL_REWARD_MAX)).toBe('750.00');
    for (const bad of ['0', '0.00', '-5', '1000000.01', '1.234', '1e3', 'abc', '', '.5', '5.', null, undefined, {}]) {
      expect(parseAmount(bad, REFERRAL_REWARD_MAX), String(bad)).toBeNull();
    }
    expect(parseAmount('100000000', AGENCY_FEE_MAX)).toBe('100000000.00');
    expect(parseAmount('100000000.01', AGENCY_FEE_MAX)).toBeNull();
  });
  it('treats an empty job reward as none and a bad one as a refusal', () => {
    expect(parseJobReward('')).toBeNull();
    expect(parseJobReward('  ')).toBeNull();
    expect(parseJobReward(null)).toBeNull();
    expect(parseJobReward('300')).toBe('300.00');
    expect(parseJobReward('0')).toBeUndefined();
    expect(parseJobReward('x')).toBeUndefined();
  });
});

describe('pay months and the payroll reference', () => {
  it('offers the Kuala Lumpur month and the next two, across a year end', () => {
    expect(rewardPayMonths('2026-11-16')).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(rewardPayMonths('2026-12-31')).toEqual(['2026-12', '2027-01', '2027-02']);
    expect(rewardPayMonths('2026-01-01', 0)).toEqual(['2026-01']);
  });
  it('references the reward on the earning', () => {
    expect(rewardSourceRef('abc')).toBe('recruitment-referral-reward:abc');
  });
});

describe('reward states', () => {
  const today = '2026-04-01';
  it('reads decisions first, then the hire\'s employment', () => {
    expect(rewardState({ hire: null, today }, { decision: 'declined', txnId: null })).toBe('declined');
    expect(rewardState({ hire: null, today }, { decision: 'approved', txnId: null })).toBe('approved');
    expect(rewardState({ hire: null, today }, { decision: 'approved', txnId: 't' })).toBe('sent');
    expect(rewardState({ hire: null, today }, null)).toBe('waiting_record');
    expect(rewardState({ hire: hire({ dueOn: '2026-04-02' }), today }, null)).toBe('waiting_probation');
    expect(rewardState({ hire: hire({ dueOn: '2026-04-01' }), today }, null)).toBe('ready');
    expect(rewardState({ hire: hire({ dueOn: '2026-03-01' }), today }, null)).toBe('ready');
    // Not active: ended before today is a leaver; otherwise (not started yet) still waiting.
    expect(rewardState({ hire: hire({ active: false, endedOn: '2026-03-31' }), today }, null)).toBe('hire_left');
    expect(rewardState({ hire: hire({ active: false, endedOn: null, startOn: '2026-05-01' }), today }, null)).toBe('waiting_probation');
  });
  it('gives the referrer a state with no reason or person', () => {
    expect(myRewardState({ applicationState: 'active', removed: false, decision: null, payPeriod: null })).toBe('if_hired');
    expect(myRewardState({ applicationState: 'hired', removed: false, decision: null, payPeriod: null })).toBe('waiting');
    expect(myRewardState({ applicationState: 'hired', removed: false, decision: 'approved', payPeriod: null })).toBe('approved');
    expect(myRewardState({ applicationState: 'hired', removed: false, decision: 'approved', payPeriod: '2026-05' })).toBe('sent');
    expect(myRewardState({ applicationState: 'hired', removed: false, decision: 'declined', payPeriod: null })).toBe('not_payable');
    expect(myRewardState({ applicationState: 'archived', removed: false, decision: null, payPeriod: null })).toBe('not_payable');
  });
});

describe('agency fee form', () => {
  it('validates amount, currency, reference and note', () => {
    expect(validateAgencyFee({ amount: '8,000', currency: 'myr', invoiceRef: ' INV-1 ', note: '' })).toEqual({ ok: true,
      value: { amount: '8000.00', currency: 'MYR', invoiceRef: 'INV-1', note: null } });
    expect(validateAgencyFee({ amount: '0', currency: 'MY', invoiceRef: 'x'.repeat(101), note: 'a\u0007b' })).toEqual({ ok: false,
      fields: ['amount', 'currency', 'invoiceRef', 'note'] });
  });
});

describe('migration 5875', () => {
  it('freezes the reward on the referral at insert and guards the job reward', () => {
    expect(m5725).toMatch(/CREATE TRIGGER recruitment_referral_reward_freeze BEFORE INSERT ON public\.recruitment_referral/);
    expect(m5725).toMatch(/CREATE TRIGGER recruitment_job_opening_referral_reward_guard BEFORE INSERT OR UPDATE OF referral_reward ON public\.recruitment_job_opening/);
    expect(section('CREATE FUNCTION app.recruitment_referral_freeze_reward()', 'REVOKE ALL ON FUNCTION app.recruitment_referral_freeze_reward()'))
      .toMatch(/NEW\.reward_amount := v_reward;/);
    expect(m5725).not.toMatch(/GRANT (INSERT|UPDATE)[^;]*ON public\.recruitment_referral TO/);
  });
  it('lets the app role insert decisions and write only the payroll columns, and never delete', () => {
    expect(m5725).toMatch(/GRANT UPDATE \(txn_id, pay_period, sent_by_user_id, sent_at\) ON public\.recruitment_referral_reward TO ai_hr_app;/);
    expect(m5725).not.toMatch(/GRANT[^;]*DELETE[^;]*recruitment_referral_reward/);
    expect(m5725).not.toMatch(/GRANT[^;]*DELETE[^;]*recruitment_agency_fee/);
    expect(m5725).toMatch(/ALTER TABLE public\.recruitment_referral_reward FORCE ROW LEVEL SECURITY;/);
    expect(m5725).toMatch(/ALTER TABLE public\.recruitment_agency_fee FORCE ROW LEVEL SECURITY;/);
  });
  it('re-checks a decision against the facts and a send against the earning of this transaction', () => {
    const guard = section('CREATE FUNCTION app.recruitment_guard_referral_reward()', 'REVOKE ALL ON FUNCTION app.recruitment_guard_referral_reward()');
    expect(guard).toMatch(/v_person = \(f->>'referrerPersonId'\)::uuid OR v_person = \(f->'hire'->>'personId'\)::uuid/);
    expect(guard).toMatch(/\(f->'hire'->>'dueOn'\)::date > \(f->>'today'\)::date/);
    expect(guard).toMatch(/t\.source_ref = 'recruitment-referral-reward:' \|\| NEW\.id::text AND t\.created_at = now\(\)/);
    expect(guard).toMatch(/v_person = v_payee_person/);
    const fee = section('CREATE FUNCTION app.recruitment_guard_agency_fee()', 'REVOKE ALL ON FUNCTION app.recruitment_guard_agency_fee()');
    expect(fee).toMatch(/NEW\.decided_by_user_id = OLD\.recorded_by_user_id/);
    expect(fee).toMatch(/s\.outcome = 'accepted' AND a\.state = 'hired'/);
  });
  it('gives the referrer and payroll only their own narrow views', () => {
    const mine = section('CREATE FUNCTION app.recruitment_my_referral_rewards()', 'REVOKE ALL ON FUNCTION app.recruitment_my_referral_rewards()');
    expect(mine).toMatch(/RETURNS TABLE\(referral_id uuid, amount numeric, currency text, decision text, pay_period text\)/);
    expect(mine).not.toMatch(/reason|decided_by|payee/);
    const queue = section('CREATE FUNCTION app.recruitment_reward_payroll_queue(', 'REVOKE ALL ON FUNCTION app.recruitment_reward_payroll_queue(');
    expect(queue).toMatch(/app\.can_admin_payroll_for\(p_company\)/);
    expect(queue).not.toMatch(/recruitment_candidate|recruitment_job_opening|referral_id/);
  });
});
