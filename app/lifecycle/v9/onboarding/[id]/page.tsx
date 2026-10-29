import { notFound } from 'next/navigation';
import { requireAdmin, requireModule } from '@/lib/authz';
import { OnboardingError, effectiveFacts } from '@/lib/onboarding-model';
import { onboardingDetail, onboardingOptions, v9CaseDetail } from '@/packs/lifecycle/service';
import { OnboardingCaseView } from '@/app/lifecycle/onboarding/case-view';
import { NativeCaseDocuments } from '../../native-case-documents';
import { V9Workspace } from '../../workspace';
import { readV9Workspace } from '../../read-workspace';
import '../../workspace.css';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const session = await requireModule('lifecycle'), { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const detail = await onboardingDetail(session, id).catch(error => { if (error instanceof OnboardingError && ['not_found', 'forbidden'].includes(error.code)) notFound(); throw error; });
  if (!detail.actor.hr || !detail.config.v9ChecklistRevision) notFound();
  const [workspace, options, documents] = await Promise.all([readV9Workspace(session), onboardingOptions(session), v9CaseDetail(session, id)]);
  if (!documents.native) notFound();
  return <V9Workspace {...workspace} nativeCase={{ name: effectiveFacts(detail.case).fullName, content: <><OnboardingCaseView key={detail.revision} detail={detail} options={options} registerHref="/lifecycle/v9"/><NativeCaseDocuments key={id} initial={documents.case} writableKeys={documents.personnelWritableKeys} config={documents.native.config} actor={documents.native.actor}/></> }}/>;
}
