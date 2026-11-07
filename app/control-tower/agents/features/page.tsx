import {AiCentreControls} from '../centre-controls';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { agentStatuses } from '@/core/control-domains';
import { listWorkers, workerDetail } from '@/core/agent-registry/views';
import { outcomeSummary } from '@/core/agent-registry/export';
import { AiManagementScreen, type AiManagementSearch } from '../screen';

/** AI centre › Workers. The built-in checks' state is read from the system here (core/control-domains.ts);
 * a failed read shows "unavailable" rather than a declared status. A group administrator also gets the
 * worker registry (step 5): the registry services refuse anyone else, and any failed read leaves it out. */
export default async function AiManagementFeaturesPage({searchParams}:{searchParams:Promise<AiManagementSearch>}) {
  const session = await requireAdmin();
  const sp = await searchParams;
  const builtInChecks = await agentStatuses(session).catch(() => null);
  const registry = isGroupAdmin(session) ? await Promise.all([
    listWorkers(session),
    outcomeSummary(session).catch(() => null),
    typeof sp.worker === 'string' && /^[a-z_]{1,64}$/.test(sp.worker) ? workerDetail(session, sp.worker).catch(() => null) : Promise.resolve(null),
  ]).then(([rows, summary, detail]) => ({ rows, summary, detail })).catch(() => null) : null;
  return AiManagementScreen({session,section:'features',searchParams:Promise.resolve(sp),builtInChecks,registry,children:isGroupAdmin(session)?await AiCentreControls({session}):undefined});
}
