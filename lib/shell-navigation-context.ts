import { withSharedReadSnapshot, type SessionContext } from '../db/client';
import { readShellNavigationAccess } from '../core/shell-navigation-access';
import { isAdmin } from './authz-model';
import { companyContextForPage } from './scope';
import { viewerIdentity } from './viewer';

/** The first signed-in layout reads share one authorized, read-only transaction. */
export function readShellNavigationContext(session: SessionContext) {
  const admin = isAdmin(session);
  return withSharedReadSnapshot(session, () => Promise.all([
    companyContextForPage(session),
    viewerIdentity(session),
    readShellNavigationAccess(session, !admin, admin),
  ]));
}
