import { redirect } from 'next/navigation';
import { requireModule } from '@/lib/authz';

/** 70d5e7c5 — Unit set-up moved to Configuration › Review Set-up. Old links (and bookmarks) open it there;
 *  that page applies its own access rule. */
export default async function RewardUnitSetupMoved({ params }: { params: Promise<{ unitId: string }> }) {
  await requireModule('rewards');
  const { unitId } = await params;
  redirect(`/admin/rewards/review-setup/${encodeURIComponent(unitId)}`);
}
