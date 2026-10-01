import { requireAdmin } from '@/lib/authz';
import { redirect } from 'next/navigation';
export default async function LegacyLeaveImportPage() {
  await requireAdmin();
  redirect('/admin/leave-config/data-import?type=bf');
}
