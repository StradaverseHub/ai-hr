import {employeeIdTemplateStatusEntryAvailable} from '@/core/assistant-actions/employee-id-template-status-review-store';
import {departmentArchiveEntryAvailable} from '@/core/assistant-actions/department-archive-review-store';
import {positionArchiveEntryAvailable} from '@/core/assistant-actions/position-archive-review-store';
import {getBrowserCommandSession} from '@/lib/session';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModuleOrgActionSection} from '@/components/assistant/module-org-action-section';
/** GET only composes guarded human input; structural effects remain explicit authenticated POST. */
export default async function AssistantOrgReportingPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.orgActions'),catalogue=await getTranslations('assistant.workspace.positionArchive'),departments=await getTranslations('assistant.workspace.departmentArchive'),templates=await getTranslations('assistant.workspace.employeeIdTemplateStatus'),query=await searchParams;
 let showCatalogue=false,showDepartments=false,showTemplates=false;try{const selected=await getBrowserCommandSession(),ctx={...selected,roles:selected.roles?.slice(),grants:selected.grants?.map(g=>({...g}))};const [positions,depts,ids]=await Promise.allSettled([positionArchiveEntryAvailable(ctx),departmentArchiveEntryAvailable(ctx),employeeIdTemplateStatusEntryAvailable(ctx)]);showCatalogue=positions.status==='fulfilled'&&positions.value;showDepartments=depts.status==='fulfilled'&&depts.value;showTemplates=ids.status==='fulfilled'&&ids.value;}catch{}
 return <div className="mx-auto max-w-3xl space-y-5"><Link href="/assistant?job=org" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link>{showCatalogue&&<Link href="/assistant/org-positions" className="inline-flex min-h-11 items-center underline">{catalogue('title')}</Link>}{showDepartments&&<Link href="/assistant/org-departments" className="inline-flex min-h-11 items-center underline">{departments('title')}</Link>}{showTemplates&&<Link href="/assistant/org-employee-id" className="inline-flex min-h-11 items-center underline">{templates('title')}</Link>}<PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><ModuleOrgActionSection resumeActionId={query.review}/></Card></div>;
}
