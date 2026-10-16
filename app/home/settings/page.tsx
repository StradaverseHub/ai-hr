import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { ownLiveEmployment } from '@/core/own-employment-selection';
import { OwnEmploymentSelectionError } from '@/lib/own-employment-selection';
import { isAdmin } from '@/lib/authz-model';
import { HomeSettings } from '@/components/home-settings';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { isCalendarDate } from '@/lib/calendar-date';
export default async function HomeSettingsPage({ searchParams }: {
    searchParams: Promise<{
        employmentId?: string;
        date?: string;
    }>;
}) {
    const { s, scopeIds } = await scopedSession(), t = await getTranslations('home'), query = await searchParams;
    let employmentId: string | undefined;
    if (query.employmentId || !isAdmin(s)) {
        let own;
        try {
            own = await ownLiveEmployment(s, query.employmentId);
        }
        catch (error) {
            if (!(error instanceof OwnEmploymentSelectionError))
                throw error;
            return <section className="space-y-3"><p role="alert">{t('noEmployment')}</p><Link className="inline-flex min-h-11 items-center text-primary underline" href="/">{t('backHome')}</Link></section>;
        }
        if (!scopeIds.includes(own.companyProof.companyId!))
            return <p>{t('noEmployment')}</p>;
        employmentId = own.employmentId;
    }
    return <main className="mx-auto max-w-3xl space-y-5"><Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={'/' + (employmentId ? '?employmentId=' + encodeURIComponent(employmentId) : '')}>{t('backHome')}</Link><h1 className="text-2xl font-semibold">{t('settings')}</h1><HomeSettings key={s.userId + ':' + scopeIds.join(',') + ':' + (employmentId ?? 'admin')} employmentId={employmentId} today={todayInKualaLumpur()} initialDate={query.date && isCalendarDate(query.date) && query.date >= todayInKualaLumpur() ? query.date : undefined}/></main>;
}
