'use client';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import styles from './workflow-module-navigation.module.css';

export type WorkflowModule = 'legacy' | 'probation' | 'contract_staff';
export type WorkflowModuleAvailability = Partial<Record<WorkflowModule, boolean>>;
const routes:Record<WorkflowModule,string>={legacy:'/lifecycle/v9?view=workflows',probation:'/lifecycle/probation/workflows',contract_staff:'/lifecycle/contracts/workflows'};
/** Visibility is resolved by each module owner on the server, never by client role labels. */
export function WorkflowModuleNavigation({current,available}:{current:WorkflowModule;available:WorkflowModuleAvailability}){
 const t=useTranslations('workflowModules');
 const modules=(['legacy','probation','contract_staff'] as const).filter(module=>available[module]===true);
 if(!modules.includes(current))return null;
 return <nav className={styles.navigation} aria-label={t('label')}>
  {modules.map(module=><Link key={module} href={routes[module]} aria-current={module===current?'page':undefined}>{t(module)}</Link>)}
 </nav>;
}
