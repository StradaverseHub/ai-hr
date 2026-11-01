import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';

/** AI centre: the work queue this page repeated is the Control Tower overview's own section, so the old
 * address forwards there instead of showing the same queue twice. Same guard as before the forward. */
export default async function AiManagementOrchestratorPage() {
  await requireAdmin();
  redirect('/control-tower');
}
