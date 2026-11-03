'use client';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
export default function Error({reset}:{error:Error;reset:()=>void}){const t=useTranslations('probation');return <main className="v9-panel v9-stack"><h1>{t('errors.title')}</h1><p role="alert">{t('errors.unavailable')}</p><div className="probation-actions"><button type="button" className="v9-button" onClick={reset}>{t('reload')}</button><Link className="v9-button" href="/lifecycle/probation">{t('backTracker')}</Link></div></main>;}
