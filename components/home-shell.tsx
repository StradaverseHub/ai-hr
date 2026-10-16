import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz-model';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { ownLiveEmploymentSubjects } from '@/core/own-employment-selection';
import { selectOwnEmployment, OwnEmploymentSelectionError } from '@/lib/own-employment-selection';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { mayUseAssistant } from '@/core/assistant-grant';
import { assistantWorkspaceView } from '@/lib/assistant-session';
import { HomeAssistant } from './home-assistant';
import { HomeGreeting, HomeBrief, HomeDay, HomeTasks, HomeTimeOff, HomeNotices, HomeAround, HomeMoments } from './home-cards';
import { HomeCalendar } from './home-calendar';
export async function PersonalHome({ employmentId }: {
    employmentId?: string | string[];
}) {
    const { s, scopeIds } = await scopedSession(), t = await getTranslations('home'), pick = await getTranslations('ownEmployment');
    const subjects = (await ownLiveEmploymentSubjects(s)).filter(subject => scopeIds.includes(subject.companyProof.companyId!));
    const admin = isAdmin(s);
    const operations = admin ? <Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href="/?workspace=operations">{t('operations')}</Link> : null;
    const settings = <Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={'/home/settings' + (typeof employmentId === 'string' ? '?employmentId=' + encodeURIComponent(employmentId) : '')}>{t('settings')}</Link>;
    let own;
    try {
        if (Array.isArray(employmentId))
            throw new OwnEmploymentSelectionError();
        if (subjects.length)
            own = selectOwnEmployment(subjects, employmentId);
        else if (employmentId !== undefined)
            throw new OwnEmploymentSelectionError();
    }
    catch (error) {
        if (!(error instanceof OwnEmploymentSelectionError))
            throw error;
        return <section className="mx-auto max-w-2xl space-y-4"><h1 className="text-2xl font-semibold">{t('title')}</h1><p role={employmentId ? 'alert' : undefined} className="text-sm text-muted-foreground">{employmentId ? pick('unavailable') : pick('choose')}</p><ul className="space-y-2">{subjects.map(subject => <li key={subject.employmentId}><Link className="flex min-h-11 items-center rounded-md border border-input p-3" href={'/?employmentId=' + encodeURIComponent(subject.employmentId)}>{subject.employeeCode} · {subject.company}</Link></li>)}</ul>{operations}</section>;
    }
    const access = await mayUseAssistant(s).catch(() => ({ allowed: false as const })), workspace = access.allowed ? await assistantWorkspaceView().catch(() => null) : null;
    const assistant = workspace ? <HomeAssistant workspaceKey={workspace.key} scopeNames={workspace.companyNames} canReviewPayroll={admin && isModuleEnabledOrFalse(s, 'payroll')}/> : <p className="text-sm text-muted-foreground">{t('assistantUnavailable')}</p>;
    if (!own)
        return <main className="mx-auto max-w-4xl space-y-6"><h1 className="text-3xl font-semibold">{t('title')}</h1><p className="text-sm text-muted-foreground">{t('noEmployment')}</p>{assistant}<div className="flex flex-wrap gap-4">{operations}{settings}</div></main>;
    const id = own.employmentId, query = '?employmentId=' + encodeURIComponent(id);
    return <main key={(workspace?.key ?? s.userId + ':' + scopeIds.join(',')) + ':' + id} className="mx-auto w-full max-w-7xl space-y-6 pb-8"><nav aria-label={t('personalNavigation')} className="flex flex-wrap gap-x-5 gap-y-1 border-b border-border pb-3 text-sm"><Link className="inline-flex min-h-11 items-center font-medium" href={'/' + query}>{t('title')}</Link><Link className="inline-flex min-h-11 items-center" href={'/home/calendar' + query}>{t('calendar')}</Link><Link className="inline-flex min-h-11 items-center" href={'/leave' + query}>{t('myLeave')}</Link>{isModuleEnabledOrFalse(s, 'payroll') && <Link className="inline-flex min-h-11 items-center" href={'/me?tab=payroll&employmentId=' + encodeURIComponent(id)}>{t('myPay')}</Link>}<Link className="inline-flex min-h-11 items-center" href={'/notices?employmentId='+encodeURIComponent(id)}>{t('notices')}</Link>{isModuleEnabledOrFalse(s, 'performance') && <Link className="inline-flex min-h-11 items-center" href="/me/performance">{t('growth')}</Link>}</nav><header className="space-y-3"><p className="text-xs text-muted-foreground">{own.employeeCode} · {own.company}</p><HomeGreeting employmentId={id} name={own.personName.split(/\s+/)[0] ?? own.personName}/><div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-prose text-sm text-muted-foreground">{t('intro')}</p><div className="flex flex-wrap gap-4">{subjects.length > 1 && <Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href="/">{t('changeEmployment')}</Link>}{operations}<Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={'/home/settings' + query}>{t('settings')}</Link></div></div></header><div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]"><div className="space-y-4"><HomeBrief employmentId={id}/><div className="rounded-xl border border-border bg-card p-5"><p className="mb-3 text-sm text-muted-foreground">{t('assistantHelp')}</p>{assistant}</div></div><HomeDay employmentId={id}/></div><HomeCalendar employmentId={id} today={todayInKualaLumpur()}/><div className="grid gap-5 lg:grid-cols-3"><HomeTasks employmentId={id}/><HomeTimeOff employmentId={id}/><HomeNotices employmentId={id}/></div><div className="grid gap-5 lg:grid-cols-2"><HomeAround employmentId={id}/><HomeMoments employmentId={id}/></div></main>;
}
