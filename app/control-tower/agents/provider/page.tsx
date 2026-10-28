import { requireAdmin } from '@/lib/authz';
import { AiProviderScreen } from '@/app/admin/ai/provider-screen';
import { AiManagementScreen, type AiManagementSearch } from '../screen';

/** Provider and key setup, moved here from Administration › AI (which now forwards to this page). */
export default async function AiManagementProviderPage({searchParams}:{searchParams:Promise<AiManagementSearch>}) {
  const session = await requireAdmin();
  return AiManagementScreen({session,section:'provider',searchParams,children:await AiProviderScreen({searchParams})});
}
