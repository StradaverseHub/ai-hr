import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';

/** AI centre: the work queue this page repeated is part of Operations › Record readiness (who acts, Refresh and what the
 * missing-data loop asked), so the old address forwards there instead of showing the same queue twice. Same guard as
 * before the forward. */
export default async function AiManagementOrchestratorPage() {
  await requireAdmin();
  redirect('/control-tower/readiness');
}
