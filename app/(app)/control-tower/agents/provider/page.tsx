import { redirect } from 'next/navigation';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { aiManagementHref } from '../sections';
import { AiProviderScreen } from '@/app/(app)/admin/ai/provider-screen';
import { AiManagementScreen, type AiManagementSearch } from '../screen';

/** Provider and key setup, moved here from Administration › AI (which now forwards to this page). */
export default async function AiManagementProviderPage({searchParams}:{searchParams:Promise<AiManagementSearch>}) {
  const session = await requireAdmin();
  // A company administrator passes requireAdmin but holds no tenant-wide provider authority; the
  // configuration read would refuse, so go to the Overview as an unavailable section does.
  if(!isGroupAdmin(session)) redirect(aiManagementHref('overview'));
  return AiManagementScreen({session,section:'provider',searchParams,children:await AiProviderScreen({searchParams})});
}
