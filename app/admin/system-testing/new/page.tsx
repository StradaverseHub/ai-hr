import {notFound} from 'next/navigation';
import {settingsActionAccess} from '@/core/organisation-access';
import { getTranslations } from 'next-intl/server';
import { requireAdmin,requireModule } from '@/lib/authz';
import { listTestableModules } from '@/core/system-testing';
import { SCREENS } from '@/lib/permissions';
import { testingInstructionDraftFrom } from '@/lib/system-testing/editor-model';
import { TestingInstructionEditor } from '@/components/system-testing/instruction-editor';
import { Card,PageHeader,pageWideCls } from '@/components/ui';
export default async function NewTestCasePage() {
  await requireAdmin(); const ctx=await requireModule('system_testing');
  const access=await settingsActionAccess(ctx,'systemTesting');if(!access.view||!access.add)notFound();
  const t=await getTranslations('systemTestingWorkspace'),labels=await getTranslations();
  return <div className={pageWideCls}><PageHeader title={t('newCase')} description={t('publishNote')} back={{href:'/admin/system-testing',label:t('library')}}/><Card className="p-4"><TestingInstructionEditor canDraft={access.add} canPublish={access.add&&access.edit} initial={testingInstructionDraftFrom(null)} caseId={null} versionId={null} draftRevision={0} modules={listTestableModules(ctx)} screens={SCREENS.map(screen=>({screenKey:screen.screenKey,label:labels(screen.labelKey)}))}/></Card></div>;
}
