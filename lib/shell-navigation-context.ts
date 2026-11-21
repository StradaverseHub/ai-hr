import { withSharedReadSnapshot, type SessionContext } from '../db/client';
import { readShellNavigationAccess } from '../core/shell-navigation-access';
import { isAdmin } from './authz-model';
import { companyContextForPage } from './scope';
import { readShellFeatureNavigation } from './shell-feature-navigation';
import { viewerIdentity } from './viewer';

/** The first signed-in layout reads share one authorized, read-only transaction. */
export function readShellNavigationContext(session: SessionContext, includeIdentityEmailOperator = false) {
  const admin = isAdmin(session);
  return withSharedReadSnapshot(session, () => Promise.all([
    companyContextForPage(session),
    viewerIdentity(session),
    readShellNavigationAccess(session, !admin, admin, includeIdentityEmailOperator),
  ]));
}

/** Resolve scope before feature links on the same authenticated database snapshot. */
export function readSignedInShellNavigation(session: SessionContext, includeIdentityEmailOperator = false) {
  return withSharedReadSnapshot(session, async () => {
    const context = await readShellNavigationContext(session, includeIdentityEmailOperator);
    const [{ scopeIds }] = context;
    const features = await readShellFeatureNavigation(session, scopeIds);
    return { context, features };
  });
}
