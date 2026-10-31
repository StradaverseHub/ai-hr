import { requireAdmin } from '@/lib/authz';
import { AiAssistantSection } from '../assistant-section';
import { AiManagementScreen, type AiManagementSearch } from '../screen';

/** The HR assistant and its 20 module specialists: availability, versions, evaluations and promotion. */
export default async function AiManagementAssistantPage({searchParams}:{searchParams:Promise<AiManagementSearch>}) {
  const session = await requireAdmin();
  return AiManagementScreen({session,section:'assistant',searchParams,children:await AiAssistantSection({session,searchParams})});
}
