import { notFound } from 'next/navigation';
import { requireModule } from '@/lib/authz';
import { onboardingDetail } from '@/packs/lifecycle/service';
import { OnboardingError } from '@/lib/onboarding-model';
import { OnboardingCaseView } from '../../../onboarding/case-view';
import { HistoricalOnboardingRequisition } from '../historical-view';
export default async function Page({ params, searchParams }: {
    params: Promise<{
        id: string;
    }>;
    searchParams: Promise<{
        generation?: string;
    }>;
}) {
    const s = await requireModule('lifecycle'), { id } = await params, { generation } = await searchParams;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        notFound();
    const detail = await onboardingDetail(s, id, 'requisition', generation).catch(e => {
        if (e instanceof OnboardingError && ['not_found', 'forbidden'].includes(e.code))
            notFound();
        throw e;
    });
    if (!generation)
        return <OnboardingCaseView key={detail.revision} detail={detail} mode="requisition"/>;
    const r = detail.case.requisitions.find(r => r.id === generation);
    if (!r)
        notFound();
    return <HistoricalOnboardingRequisition detail={detail} generation={generation}/>;
}
