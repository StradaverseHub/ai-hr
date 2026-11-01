import { requireAdmin } from '@/lib/authz';
import { agentStatuses } from '@/core/control-domains';
import { AiManagementScreen, type AiManagementSearch } from '../screen';

/** AI centre › Workers. The built-in checks' state is read from the system here (core/control-domains.ts);
 * a failed read shows "unavailable" rather than a declared status. */
export default async function AiManagementFeaturesPage({searchParams}:{searchParams:Promise<AiManagementSearch>}) {
  const session = await requireAdmin();
  const builtInChecks = await agentStatuses(session).catch(() => null);
  return AiManagementScreen({session,section:'features',searchParams,builtInChecks});
}
