import { describe, expect, it } from 'vitest';
import { reconcileOwnLeaveConfirmation } from '../core/assistant-actions/own-leave-reconciliation';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = { tenantId: id(1), userId: id(2), personId: id(3), companyId: id(4), employmentId: id(5) };
const now = new Date();
const expires = new Date(now.getTime() + 60_000);
const afterExpiry = new Date(expires.getTime() + 1);
const actionId = id(6);
const confirmation = { actionId, contractVersion: 1, reviewedDigest: 'a'.repeat(64) };
const metadata = { actionId, action: 'leave.apply', contractVersion: 1, binding,
  intentDigest: 'b'.repeat(64), reviewedDigest: confirmation.reviewedDigest, state: 'completed',
  createdAt: now.toISOString(), expiresAt: expires.toISOString() };
const receipt = { actionId, contractVersion: 1, state: 'completed', leaveRequestId: id(7), submissionEventId: id(8) };
const checking = { status: 'checking_submission', actionId };

describe('own-leave uncertain transport reconciliation', () => {
  it('returns the recorded submission after card expiry without claiming approval', () => {
    const outcome = reconcileOwnLeaveConfirmation(metadata, receipt, confirmation, binding, afterExpiry);
    expect(outcome).toEqual({ status: 'submission_recorded', actionId, leaveRequestId: id(7) });
    expect(outcome).not.toHaveProperty('approved');
    expect(outcome).not.toHaveProperty('submissionEventId');
  });

  it.each([
    null, {}, { ...receipt, submissionEventId: undefined }, { ...receipt, leaveRequestId: undefined },
    { ...receipt, contractVersion: 2 }, { ...receipt, actionId: id(9) },
    { ...receipt, state: 'refused', code: 'source_refused' },
    { ...receipt, reason: 'Private sentinel' }, { ...receipt, approved: true },
  ])('keeps missing, malformed or conflicting evidence unconfirmed: %j', value => {
    const outcome = reconcileOwnLeaveConfirmation(metadata, value, confirmation, binding, now);
    expect(outcome).toEqual(checking);
    expect(JSON.stringify(outcome)).not.toContain('Private sentinel');
  });

  it('cannot promote an awaiting action using a detached completion receipt', () => {
    expect(reconcileOwnLeaveConfirmation({ ...metadata, state: 'awaiting_confirmation' },
      receipt, confirmation, binding, now)).toEqual(checking);
  });

  it.each(['tenantId', 'userId', 'personId', 'companyId', 'employmentId'] as const)(
    'does not disclose the recorded request when current %s changes', key => {
      expect(reconcileOwnLeaveConfirmation(metadata, receipt, confirmation, { ...binding, [key]: id(9) }, now))
        .toEqual({ status: 'refused', actionId, code: 'unavailable' });
    },
  );

  it('refuses a changed review and does not echo malformed confirmation input', () => {
    expect(reconcileOwnLeaveConfirmation(metadata, receipt,
      { ...confirmation, reviewedDigest: 'c'.repeat(64) }, binding, now))
      .toEqual({ status: 'refused', actionId, code: 'review_changed' });
    expect(reconcileOwnLeaveConfirmation(metadata, receipt,
      { ...confirmation, reason: 'Private sentinel' }, binding, now)).toEqual({ status: 'unavailable' });
  });

  it('returns a bounded refusal without requiring or disclosing a leave-request reference', () => {
    expect(reconcileOwnLeaveConfirmation({ ...metadata, state: 'refused' },
      { actionId, contractVersion: 1, state: 'refused', code: 'source_refused' }, confirmation, binding, afterExpiry))
      .toEqual({ status: 'refused', actionId, code: 'source_refused' });
    expect(reconcileOwnLeaveConfirmation({ ...metadata, state: 'refused' },
      { actionId, contractVersion: 1, state: 'refused', code: 'Private source error' }, confirmation, binding, now))
      .toEqual(checking);
  });

  it('keeps discard and expiry separate from a submitted request', () => {
    expect(reconcileOwnLeaveConfirmation({ ...metadata, state: 'discarded' },
      { actionId, contractVersion: 1, state: 'discarded' }, confirmation, binding, afterExpiry))
      .toEqual({ status: 'discarded', actionId });
    expect(reconcileOwnLeaveConfirmation({ ...metadata, state: 'expired' },
      { actionId, contractVersion: 1, state: 'expired' }, confirmation, binding, afterExpiry))
      .toEqual({ status: 'refused', actionId, code: 'expired' });
  });
});
