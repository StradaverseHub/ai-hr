import { requireAdmin } from '@/lib/authz';
import { EventTypeConfigPage } from '../../event-type-config-page';

/** 1d58019a — Add Event Type: the configuration page with no code (see ../../event-type-config-page.tsx). */
export default async function NewMovementEventTypePage() {
  // The route's own guard, so the users/roles matrix (lib/permissions.ts) and test/function-access.test.ts
  // see it on this page; the shared component and the service check again.
  await requireAdmin();
  return <EventTypeConfigPage code={null} />;
}
