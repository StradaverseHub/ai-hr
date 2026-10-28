import { requireAdmin } from '@/lib/authz';
import { AiManagementScreen, type AiManagementSearch } from '../screen';

export default async function AiManagementSpendingPage({searchParams}:{searchParams:Promise<AiManagementSearch>}) {
  const session = await requireAdmin();
  return AiManagementScreen({session,section:'spending',searchParams});
}
