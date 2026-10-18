import Link from 'next/link';
import { requireModule } from '@/lib/authz';
import { onboardingRequisitions } from '@/packs/lifecycle/service';
import { RequisitionsView } from './requisitions-view';
export default async function Page() {
    const s = await requireModule('lifecycle');
    return <div className="space-y-5"><RequisitionsView rows={await onboardingRequisitions(s)}/><Link className="text-sm text-primary underline" href="/lifecycle/requisitions">Previous requisitions, returns and standalone requests</Link></div>;
}
