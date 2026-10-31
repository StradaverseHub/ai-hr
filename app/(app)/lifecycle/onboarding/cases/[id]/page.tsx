import { notFound } from 'next/navigation';
import { OnboardingError } from '@/lib/onboarding-model';
import { requireModule } from '@/lib/authz';
import { onboardingDetail, onboardingOptions, v9CaseDetail, v9Workspace } from '@/packs/lifecycle/service';
import { NativeCaseDocuments } from '../../../v9/native-case-documents';
import '../../../v9/workspace.css';
import { OnboardingCaseView } from '../../case-view';
export default async function Page({ params }: {
    params: Promise<{
        id: string;
    }>;
}) { const s = await requireModule('lifecycle'), { id } = await params; if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    notFound(); const detail = await onboardingDetail(s, id).catch(e => { if (e instanceof OnboardingError && ['not_found', 'forbidden'].includes(e.code))
    notFound(); throw e; }); const options = await onboardingOptions(s);
    const documents = (detail.actor.module||detail.actor.caseActions) && detail.actor.hr && detail.config.v9ChecklistRevision ? await v9CaseDetail(s, id) : null;
    const signers=documents?.native?(await v9Workspace(s)).options.signatoryCandidatesByModule?.onb[documents.case.facts.company]:undefined;
    return <><OnboardingCaseView key={detail.revision} detail={detail} options={options}/>{documents?.native && <NativeCaseDocuments key={id} initial={documents.case} writableKeys={documents.personnelWritableKeys} config={documents.native.config} actor={documents.native.actor} users={detail.directory} eligibleSignatoryIds={signers}/>}</>; }
