/** Real authenticated server binding, deliberately UNMOUNTED until release acceptance.
 * No route.ts, model tool or orchestrator registers this function. It must never accept posted
 * session/locale/tenant/actor data or a callback that bypasses the canonical review command.
 */
import 'server-only';
import { getLocale } from 'next-intl/server';
import { isLocale } from '../../i18n/config';
import { getBrowserCommandSession } from '../../lib/session';
import { createOwnLeaveBrowserCommandHandler } from './own-leave-browser';

export const handleAuthenticatedOwnLeaveBrowserCommand = createOwnLeaveBrowserCommandHandler(async () => {
  const source = await getBrowserCommandSession();
  // Session resolution is request-scoped; capture before the next await so no shared cached object
  // can retarget this command while locale resolution or the actual source transaction waits.
  const ctx = { ...source, roles: source.roles?.slice(), grants: source.grants?.map(grant => ({ ...grant })) };
  const locale = await getLocale();
  if (!isLocale(locale)) throw new Error('Own-leave browser session unavailable.');
  return Object.freeze({ ctx, locale });
});
