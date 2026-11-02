import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
export default async function NotFound(){const t=await getTranslations('probation');return <main className="v9-panel v9-stack"><h1>{t('errors.notFound')}</h1><Link href="/lifecycle/probation">{t('backTracker')}</Link></main>;}
