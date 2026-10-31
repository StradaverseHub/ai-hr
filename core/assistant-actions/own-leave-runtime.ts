/** Configured Next/Web Request binding for the unreleased candidate POST. Deployment still requires
 * migration/source/security/browser acceptance. No provider, model tool or arbitrary callback is an
 * effect caller. */
import 'server-only';
import { appOrigin } from '../../lib/real-auth';
import { createOwnLeaveBrowserCommandHandler } from './own-leave-browser';
import { withAgentActionPauseScope } from '../agent-action-pause-scope';
import { authenticateOwnLeaveBrowserSession } from './own-leave-server';

/** Deployment selection owns public origin. Missing/invalid configuration refuses before session or
 * DB work; reflected Host/Forwarded/Origin/requestURL never supplies the allow-list. Resolve per
 * request, and keep the canonical authenticator's strict cookie selection plus server-owned locale.
 * Standard Request/Response are supported by installed Next route handlers; no proxy URL rewrite.
 */
export async function handleConfiguredOwnLeaveBrowserCommand(request: Request): Promise<Response> {
  // appOrigin already bounds malformed selected-provider configuration. Keep this last server
  // boundary defensive as well: a future config implementation must never turn failure into a
  // reflected Host fallback or expose its exception before the transport's bounded refusal.
  let publicOrigin: string | undefined;
  try { publicOrigin = appOrigin(); } catch { publicOrigin = undefined; }
  // WP12 (R8): every own-leave Assistant command serves leave.apply; its own pause key applies in the owning transaction.
  return withAgentActionPauseScope('leave.apply', () => createOwnLeaveBrowserCommandHandler(authenticateOwnLeaveBrowserSession,
    { publicOrigin })(request));
}
