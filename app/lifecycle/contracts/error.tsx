'use client';
import {useTranslations} from 'next-intl';
export default function ErrorPage({reset}:{reset:()=>void}){const t=useTranslations('contractManagement');return <section className="space-y-4 rounded-xl border p-6" role="alert"><h1 className="text-xl font-semibold">{t('title')}</h1><p>{t('failed')}</p><button type="button" className="v9-button" onClick={reset}>{t('retry')}</button></section>;}
