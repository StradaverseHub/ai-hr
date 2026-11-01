/**
 * ADR-0171 provider contract for idle sign-out: what one report of real user activity means for a web session.
 *
 * - `active`: a provider that enforces the organization's idle limit recorded the activity.
 * - `not-enforced`: the browser holds a live web session that no enforcing provider owns (for example a
 *   federated sign-in with its own session store). The shell hides the countdown; it must never sign this person
 *   out on the strength of a provider that does not know the session.
 * - `expired`: no live web session at all, or an enforcing provider just ended it for inactivity.
 *
 * A provider with its own session store joins by adding a recorder here that returns `null` for tokens it does not
 * own, and by refusing its own idle sessions on read with the same limit (`idleTimeoutMinutesFor`).
 */
export type WebActivity =
  | { status: 'active'; idleTimeoutSeconds: number; remainingSeconds: number }
  | { status: 'not-enforced' }
  | { status: 'expired' };

export type ActivityRecorder = (token: string | undefined) => Promise<{ idleTimeoutSeconds: number; remainingSeconds: number } | null>;

export async function recordWebActivity(token: string | undefined, deps: {
  recorders: readonly ActivityRecorder[];
  /** The live web identity across every provider, read after the recorders so an idle-ended session is gone. */
  liveIdentity: () => Promise<unknown | null>;
}): Promise<WebActivity> {
  for (const record of deps.recorders) {
    const allowance = await record(token);
    if (allowance) return { status: 'active', ...allowance };
  }
  return await deps.liveIdentity() ? { status: 'not-enforced' } : { status: 'expired' };
}
