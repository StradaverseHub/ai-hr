'use client';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {PROBATION_PREPARATION_LINKS,probationPreparationHref} from '@/lib/probation-preparation-navigation';
export function PreparationNav({companyId}:{companyId:string}){
 const t=useTranslations('probation');return <nav className="probation-actions" aria-label={t('configuration')}>{PROBATION_PREPARATION_LINKS.map(({path,labelKey,navigationId})=><Link className="v9-button" key={path} data-navigation-destination={navigationId} href={probationPreparationHref(path,companyId)}>{t(labelKey)}</Link>)}</nav>;
}
