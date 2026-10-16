import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { ownLiveEmployment } from '@/core/own-employment-selection';
import { OwnEmploymentSelectionError } from '@/lib/own-employment-selection';
import { HomeCalendar } from '@/components/home-calendar';
import { todayInKualaLumpur } from '@/lib/hr-date';
export default async function MyCalendarPage({ searchParams }: {
    searchParams: Promise<{
        employmentId?: string;
    }>;
}) {
    const { s, scopeIds } = await scopedSession(), t = await getTranslations('home'), query = await searchParams;
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
    return <main className="mx-auto max-w-7xl space-y-5"><Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={'/?employmentId=' + encodeURIComponent(own.employmentId)}>{t('backHome')}</Link><HomeCalendar employmentId={own.employmentId} today={todayInKualaLumpur()} full/></main>;
}
