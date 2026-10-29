import { requireAdmin } from '@/lib/authz';
import { AiManagementScreen, type AiManagementSearch } from '../screen';

/** WP12 (R8): the one AI inventory. requireAdmin opens it; core/ai-inventory.ts narrows a company HR administrator
 *  to the read-only registry/tier view (ADR-0151 §4.7). */
export default async function AiManagementInventoryPage({searchParams}:{searchParams:Promise<AiManagementSearch>}) {
  const session = await requireAdmin();
  return AiManagementScreen({session,section:'inventory',searchParams});
}
