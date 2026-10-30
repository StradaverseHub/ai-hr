import {routeMessageLayout} from '@/components/route-messages';
import type { ReactNode } from 'react';
import { requireAdmin } from '@/lib/authz';

/** Control Tower pages share the admin guard. Navigation between them is the AI Control Tower menu in the
 * sidebar (28 Oct 2026, owner); the in-page tab row was retired so there is one menu, not two. */
async function ControlTowerLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return <>{children}</>;
}

export default routeMessageLayout('control-tower',ControlTowerLayout);
