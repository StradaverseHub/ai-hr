import { describe, expect, it } from 'vitest';
import { readinessActionFor, READINESS_CORRECTIONS } from '../lib/readiness-correction-actions';
import { PROFILE_REQUESTABLE_FIELDS } from '../lib/profile-requestable-fields';

const facts = { hasStatutoryProfile: true, allowedFields: new Set(PROFILE_REQUESTABLE_FIELDS.map(f => f.key)), pending: [], approver: 'admin' as const };
describe('governed readiness correction catalogue', () => {
  it('points every employee correction at the existing permitted form', () => {
    for (const rule of Object.values(READINESS_CORRECTIONS)) for (const key of rule.fields) {
      expect(PROFILE_REQUESTABLE_FIELDS.find(f => f.key === key)?.tab).toBe(rule.tab);
    }
    expect(readinessActionFor('no_compensation', facts).type).toBe('review_record');
    expect(readinessActionFor('no_bank_account', facts).type).toBe('submit_correction');
  });
  it('requires the complete bank pair, but permits either identity field', () => {
    expect(readinessActionFor('no_bank_account', { ...facts, allowedFields: new Set(['bankAccountNo']) }).type).toBe('review_record');
    expect(readinessActionFor('no_identity', { ...facts, allowedFields: new Set(['passportNumber']) }).type).toBe('submit_correction');
    expect(readinessActionFor('no_identity', { ...facts, allowedFields: new Set(['oldIcNumber']) }).type).toBe('review_record');
    expect(readinessActionFor('no_tax_number', { ...facts, hasStatutoryProfile: false }).type).toBe('review_record');
  });
  it('a relevant pending request moves work to review, never completion or duplicate submission', () => {
    expect(readinessActionFor('no_bank_account', { ...facts, pending: [{ id: 'request', fields: ['bankName', 'bankAccountNo'] }] }))
      .toMatchObject({ type: 'review_submission', audience: 'hr', requestId: 'request' });
    expect(readinessActionFor('no_bank_account', { ...facts, pending: [{ id: 'irrelevant', fields: ['taxNumber'] }] }).type).toBe('submit_correction');
    expect(readinessActionFor('no_bank_account', { ...facts, pending: [{ id: 'half', fields: ['bankAccountNo'] }] }).type).toBe('submit_correction');
  });
});
