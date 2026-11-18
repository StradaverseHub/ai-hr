import {Suspense} from 'react';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {readTodayContractWork,todayContractsEnabled,type TodayContractWork} from './contract-read';
import {PanelBoundary} from './employee/panel-boundary';
import {PanelNote} from './employee/panel';
import {ContractSection} from './contract-section';

/** Every Today draws the actual signing owner's bounded page, independently of the other panels. */
export function TodayContracts({session,work}:{session:SessionContext;work?:Promise<TodayContractWork>}){
 if(!todayContractsEnabled(session))return null;
 return <PanelBoundary fallback={<ContractUnavailable/>}><Suspense fallback={null}><ContractSignatures work={work??readTodayContractWork(session)}/></Suspense></PanelBoundary>;
}
async function ContractUnavailable(){const t=await getTranslations('contractHome');return <PanelNote>{t('unavailable')} <Link className="underline underline-offset-4" href="/tasks">{t('openTasks')}</Link></PanelNote>;}
async function ContractSignatures({work}:{work:Promise<TodayContractWork>}){
 const [t,result]=await Promise.all([getTranslations('contractHome'),work]);
 if(result.status==='disabled')return null;
 if(result.status==='unavailable')return <ContractUnavailable/>;
 const page=result.page;
 return <ContractSection items={page.items} total={page.taskTotal} title={t('title')} countLabel={t('count',{count:page.taskTotal})} signLabel={t('sign')} continueLabel={t('bindEmployee')} allLabel={t('all',{count:page.taskTotal})}/>;
}
