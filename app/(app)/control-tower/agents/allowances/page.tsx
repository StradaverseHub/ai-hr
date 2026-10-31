import { requireAdmin } from '@/lib/authz';
import { AiManagementScreen, type AiManagementSearch } from '../screen';

export default async function AiManagementAllowancesPage({searchParams}:{searchParams:Promise<AiManagementSearch>}) {
  const session = await requireAdmin();
  return AiManagementScreen({session,section:'allowances',searchParams});
}
