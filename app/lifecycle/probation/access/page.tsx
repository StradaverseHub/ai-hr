import {getTranslations} from 'next-intl/server';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationAccessView} from '@/packs/probation/service';
import {ConfigHead} from '../settings/config-head';
import {AccessSection} from './section';
import '../../../automation/pcg.css';

/**
 * Probation Confirmation › Configuration › Access on its own address (handoff B7). The prototype draws Access inside
 * Probation settings; the settings page renders the same AccessSection for viewers who configure Probation, and this
 * page keeps working for links, redirects after a save, and access administrators who do not configure Probation.
 * The database decides who may open it.
 */
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const session=await requireScopedLifecycleModule(),query=await searchParams,t=await getTranslations('probationAccess');
 const view=await probationAccessView(session);
 if(!view)return <main className="pcg"><ConfigHead crumb={t('breadcrumb')} title={t('title')}/><p className="v9-notice v9-warning" role="alert">{t('forbidden')}</p></main>;
 return <main className="pcg">
  <ConfigHead crumb={t('breadcrumb')} title={t('title')} sub={t('intro')}/>
  <AccessSection session={session} view={view} query={query} host="access"/>
 </main>;
}
