import { redirect } from 'next/navigation';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { aiManagementHref } from '../sections';
import { AiProviderScreen } from '@/app/admin/ai/provider-screen';
import { AiProviderBaselinePanel } from '@/app/admin/ai/provider-baseline-panel';
import { AiManagementScreen, type AiManagementSearch } from '../screen';

/** Provider and key setup, moved here from Administration › AI (which now forwards to this page). WP14: provider or
 * model changes wait below the provider cards for their baseline checks before they can be activated. */
export default async function AiManagementProviderPage({searchParams}:{searchParams:Promise<AiManagementSearch>}) {
  const session = await requireAdmin();
  // A company administrator passes requireAdmin but holds no tenant-wide provider authority; the
  // configuration read would refuse, so go to the Overview as an unavailable section does.
  if(!isGroupAdmin(session)) redirect(aiManagementHref('overview'));
  const children = <div className="space-y-6">{await AiProviderScreen({searchParams})}<div className="max-w-3xl">{await AiProviderBaselinePanel({session})}</div></div>;
  return AiManagementScreen({session,section:'provider',searchParams,children});
}
