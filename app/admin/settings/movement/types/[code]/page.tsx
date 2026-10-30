import { requireAdmin } from '@/lib/authz';
import { EventTypeConfigPage } from '../../event-type-config-page';

/** 1d58019a — Edit Event Type: the configuration page for one catalogue code (built-in or the tenant's own). */
export default async function EditMovementEventTypePage({ params }: { params: Promise<{ code: string }> }) {
  // The route's own guard (see ../new/page.tsx); an unknown code is a 404 in the shared component.
  await requireAdmin();
  const { code } = await params;
  return <EventTypeConfigPage code={decodeURIComponent(code)} />;
}
