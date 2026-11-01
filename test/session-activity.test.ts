/**
 * ADR-0171 provider contract for idle activity. The regression that matters across PR196 (idle sign-out) and
 * PR194 (Entra sessions in their own store): a live web session that no enforcing provider owns must answer
 * `not-enforced`, never `expired`, so the shell can never sign a federated user out within seconds of arrival.
 */
import { describe, expect, it, vi } from 'vitest';
import { recordWebActivity, type ActivityRecorder } from '../lib/session-activity';

const allowance = { idleTimeoutSeconds: 900, remainingSeconds: 840 };
const none: ActivityRecorder = async () => null;

describe('recordWebActivity', () => {
  it('reports the allowance of the first enforcing provider that owns the session', async () => {
    const later = vi.fn<ActivityRecorder>(async () => ({ idleTimeoutSeconds: 1, remainingSeconds: 1 }));
    const liveIdentity = vi.fn(async () => ({ subject: 'fictional' }));
    expect(await recordWebActivity('token', { recorders: [async () => allowance, later], liveIdentity }))
      .toEqual({ status: 'active', ...allowance });
    expect(later).not.toHaveBeenCalled();
    expect(liveIdentity).not.toHaveBeenCalled();
  });

  it('a live session owned only by a non-enforcing provider is not-enforced, never expired', async () => {
    const federated = { subject: 'fictional-entra-object', issuer: 'https://login.microsoftonline.test/tenant/v2.0' };
    expect(await recordWebActivity('federated-token', { recorders: [none], liveIdentity: async () => federated }))
      .toEqual({ status: 'not-enforced' });
  });

  it('no live session at all is expired', async () => {
    expect(await recordWebActivity(undefined, { recorders: [none], liveIdentity: async () => null })).toEqual({ status: 'expired' });
  });

  it('reads the live identity only after the recorders, so a session an enforcing provider just ended counts as expired', async () => {
    let live = true;
    const endsIdleSession: ActivityRecorder = async () => { live = false; return null; };
    expect(await recordWebActivity('idle-token', { recorders: [endsIdleSession], liveIdentity: async () => (live ? {} : null) }))
      .toEqual({ status: 'expired' });
  });

  it('a later enforcing provider (for example a federated store that adopts the limit) is consulted in order', async () => {
    expect(await recordWebActivity('federated-token', { recorders: [none, async () => allowance], liveIdentity: async () => null }))
      .toEqual({ status: 'active', ...allowance });
  });
});
