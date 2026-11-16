import {Suspense} from 'react';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {isModuleEnabledOrFalse} from '@/lib/authz';
import {contractSharedWorkPage} from '@/packs/contracts/service';
import {PanelBoundary} from './employee/panel-boundary';
import {PanelNote} from './employee/panel';
import {ContractSection} from './contract-section';

/** Every Today draws the actual signing owner's bounded page, independently of the other panels. */
export function TodayContracts({session}:{session:SessionContext}){
 if(!isModuleEnabledOrFalse(session,'lifecycle')&&!session.entitlements?.scopedModules.lifecycle?.length)return null;
 return <PanelBoundary fallback={<ContractUnavailable/>}><Suspense fallback={null}><ContractSignatures session={session}/></Suspense></PanelBoundary>;
}
async function ContractUnavailable(){const t=await getTranslations('contractHome');return <PanelNote>{t('unavailable')} <Link className="underline underline-offset-4" href="/tasks?contractPage=1">{t('openTasks')}</Link></PanelNote>;}
async function ContractSignatures({session}:{session:SessionContext}){
 const t=await getTranslations('contractHome');
 let page:Awaited<ReturnType<typeof contractSharedWorkPage>>;
 try{page=await contractSharedWorkPage(session,{category:'tasks',limit:5,offset:0});}catch{return <ContractUnavailable/>;}
 return <ContractSection items={page.items} total={page.taskTotal} title={t('title')} countLabel={t('count',{count:page.taskTotal})} signLabel={t('sign')} allLabel={t('all',{count:page.taskTotal})}/>;
}
