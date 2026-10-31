import { requireAdmin } from '@/lib/authz';
import DelegationPage from '@/app/(app)/delegations/page';

/** HR entry reuses the existing workspace; self-service retains its own guarded route. */
export default async function ApprovalDelegationPage(props: { searchParams: Promise<{ history?: string }> }) {
  await requireAdmin();
  return DelegationPage(props);
}
