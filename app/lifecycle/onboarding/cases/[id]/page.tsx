import { notFound } from 'next/navigation';
import { OnboardingError } from '@/lib/onboarding-model';
import { requireModule } from '@/lib/authz';
import { onboardingDetail, onboardingOptions } from '@/packs/lifecycle/service';
import { OnboardingCaseView } from '../../case-view';
export default async function Page({ params }: {
    params: Promise<{
        id: string;
    }>;
}) { const s = await requireModule('lifecycle'), { id } = await params; if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    notFound(); const detail = await onboardingDetail(s, id).catch(e => { if (e instanceof OnboardingError && ['not_found', 'forbidden'].includes(e.code))
    notFound(); throw e; }); const options = await onboardingOptions(s); return <OnboardingCaseView key={detail.revision} detail={detail} options={options}/>; }
