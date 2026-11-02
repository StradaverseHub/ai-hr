'use client';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
export function PreparationNav({companyId}:{companyId:string}){
 const t=useTranslations('probation');return <nav className="probation-actions" aria-label={t('configuration')}>{[['settings','settings.title'],['forms','form.title'],['routes','routes.title'],['workflows','workflows.title'],['templates','templates.title'],['intake','intake.title']].map(([path,key])=><Link className="v9-button" key={path} href={'/lifecycle/probation/'+path+'?company='+encodeURIComponent(companyId)}>{t(key)}</Link>)}</nav>;
}
