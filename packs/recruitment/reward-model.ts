/**
 * Recruitment slice 23 — referral rewards and agency fees: the pure rules (no database). The owner decided (D-063) a fixed
 * reward per job, payable once the hire has passed probation, approved by HR and sent to payroll as a one-off earning, and
 * agency fees that are tracked and approved only. Every amount here is one a person typed; nothing is calculated (D-021).
 */

/** The largest reward a job may carry, and the largest agency fee (in the currency's units, two decimals). */
export const REFERRAL_REWARD_MAX = 1_000_000;
export const AGENCY_FEE_MAX = 100_000_000;
export const REWARD_REASON_MAX = 500;
export const FEE_INVOICE_MAX = 100;
export const FEE_NOTE_MAX = 500;
/** A reward is sent to the current Kuala Lumpur pay month or one of the next two. */
export const REWARD_PAY_MONTHS_AHEAD = 2;
/** The note on the payroll earning, and the reference that ties it back to the reward. */
export const REWARD_TXN_NOTE = 'Employee referral reward';
export const rewardSourceRef = (rewardId: string): string => `recruitment-referral-reward:${rewardId}`;

/**
 * A typed amount as a two-decimal string, or null. Accepts digits with an optional decimal point and at most two decimals,
 * ignoring spaces and thousands commas; refuses zero, negatives, exponents and anything above `max`.
 */
export function parseAmount(value: unknown, max: number): string | null {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\s,]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  // Whole cents as an integer: at most 9 digits before the point, so exact well below 2^53.
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > max * 100) return null;
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** An optional job reward: empty clears it (null), otherwise a valid amount; `undefined` is a refusal. */
export function parseJobReward(value: unknown): string | null | undefined {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  return parseAmount(value, REFERRAL_REWARD_MAX) ?? undefined;
}

export const isCurrency = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]{3}$/.test(value);

/** Trimmed text of 1..max characters with no control characters, or null. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
  return text;
}

/** The pay months a reward may be sent to: the month of `todayIso` (a Kuala Lumpur date) and the next `ahead`. */
export function rewardPayMonths(todayIso: string, ahead = REWARD_PAY_MONTHS_AHEAD): string[] {
  const [y, m] = todayIso.split('-').map(Number);
  return Array.from({ length: ahead + 1 }, (_, i) => {
    const index = y * 12 + (m - 1) + i;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
  });
}

/** What app.recruitment_reward_facts returns about the hire's employment (dates are ISO days). */
export type RewardHireFacts = {
  employmentId: string; personId: string; startOn: string | null; confirmationOn: string | null; probationEndOn: string | null;
  dueOn: string | null; noProbationDate: boolean; endedOn: string | null; active: boolean;
};
export type RewardPayee = { employmentId: string; companyId: string; companyName: string; currency: string; employeeCode: string | null };
export type RewardFacts = {
  referralId: string; companyId: string; jobId: string; referrerPersonId: string; amount: string | null; currency: string | null;
  applicationState: 'active' | 'hired' | 'archived'; hire: RewardHireFacts | null; payees: RewardPayee[]; today: string;
};
export type RewardDecision = { decision: 'approved' | 'declined'; txnId: string | null };

export const REWARD_STATES = ['waiting_record', 'waiting_probation', 'ready', 'hire_left', 'approved', 'sent', 'declined'] as const;
export type RewardState = (typeof REWARD_STATES)[number];

/**
 * A hired referral's reward state. Decided rewards read their decision. Otherwise: no employment yet (the hand-off's draft
 * not completed) is waiting for the record; an employment that ended is hire left; an active one is ready on or after its
 * due day; anything else (not started, or before the due day) is waiting for probation.
 */
export function rewardState(facts: Pick<RewardFacts, 'hire' | 'today'>, decided: RewardDecision | null): RewardState {
  if (decided) return decided.decision === 'declined' ? 'declined' : decided.txnId ? 'sent' : 'approved';
  const hire = facts.hire;
  if (!hire) return 'waiting_record';
  if (!hire.active) return hire.endedOn && hire.endedOn < facts.today ? 'hire_left' : 'waiting_probation';
  return hire.dueOn && hire.dueOn <= facts.today ? 'ready' : 'waiting_probation';
}

/** The referrer's view of a reward: no reasons, people or employments. */
export const MY_REWARD_STATES = ['if_hired', 'waiting', 'approved', 'sent', 'not_payable'] as const;
export type MyRewardState = (typeof MY_REWARD_STATES)[number];
export function myRewardState(p: { applicationState: 'active' | 'hired' | 'archived'; removed: boolean; decision: 'approved' | 'declined' | null; payPeriod: string | null }): MyRewardState {
  if (p.decision === 'declined') return 'not_payable';
  if (p.decision === 'approved') return p.payPeriod ? 'sent' : 'approved';
  if (p.applicationState === 'hired') return 'waiting';
  if (p.applicationState === 'archived' || p.removed) return 'not_payable';
  return 'if_hired';
}

export type AgencyFeeInput = { amount?: unknown; currency?: unknown; invoiceRef?: unknown; note?: unknown };
export type ValidAgencyFee = { amount: string; currency: string; invoiceRef: string | null; note: string | null };
export function validateAgencyFee(input: AgencyFeeInput): { ok: true; value: ValidAgencyFee } | { ok: false; fields: string[] } {
  const fields: string[] = [];
  const amount = parseAmount(input.amount, AGENCY_FEE_MAX);
  if (!amount) fields.push('amount');
  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';
  if (!isCurrency(currency)) fields.push('currency');
  const blank = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '');
  const invoiceRef = blank(input.invoiceRef) ? null : cleanText(input.invoiceRef, FEE_INVOICE_MAX);
  if (!blank(input.invoiceRef) && !invoiceRef) fields.push('invoiceRef');
  const note = blank(input.note) ? null : cleanText(input.note, FEE_NOTE_MAX);
  if (!blank(input.note) && !note) fields.push('note');
  if (fields.length || !amount) return { ok: false, fields };
  return { ok: true, value: { amount, currency, invoiceRef, note } };
}
