/**
 * The public signing anchors compiled into the mobile app (mobile/connections/trust.json), read by the
 * server so it judges a workplace setup exactly as the installed app will. One file owns the anchors;
 * this module only consumes it. A new anchor still requires an app release (ADR-0161).
 */
import anchors from '../mobile/connections/trust.json';
import type { TrustAnchor } from './mobile-workplace-setup-verify';

export const INSTALLED_APP_TRUST: readonly TrustAnchor[] = Object.freeze(
  (anchors as TrustAnchor[]).map(anchor => Object.freeze({ ...anchor })),
);
