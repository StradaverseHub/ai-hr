'use client';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {AUTOMATION_FILTERS,type AutomationFilter} from './types';

/** Module filter of the shared builders (prototype chips: All modules, Onboarding, Offboarding, Contract staff, Probation). */
export function FilterChips({path,current}:{path:string;current:AutomationFilter}){
 const t=useTranslations('automation');
 return <nav className="automation-chips" aria-label={t('filterLabel')}>
  {AUTOMATION_FILTERS.map(filter=><Link key={filter} href={`${path}?module=${filter}`} aria-current={filter===current?'page':undefined} className="automation-chip">{t('modules.'+filter)}</Link>)}
 </nav>;
}

/** A module that keeps its own builder until it moves to the shared engine (ADR decision 2). */
export function LegacyBuilderCard({module,href,allowed,kind}:{module:Exclude<AutomationFilter,'all'|'probation'>;href:string;allowed:boolean;kind:'workflows'|'templates'|'groups'}){
 const t=useTranslations('automation');
 return <section className="v9-panel v9-stack" aria-label={t('modules.'+module)}>
  <h2>{t('modules.'+module)}</h2>
  <p className="v9-muted">{t('legacy.'+kind+'Intro')}</p>
  {allowed?<p><Link className="v9-button" href={href}>{t(module==='contract_staff'?'legacy.openContract':'legacy.openV9',{what:t('legacy.'+kind)})}</Link></p>:<p className="v9-muted">{t('legacy.notAllowed')}</p>}
 </section>;
}
