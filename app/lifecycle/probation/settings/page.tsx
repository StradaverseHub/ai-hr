import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationAccessView,probationActivationCounts,probationSettingsScope} from '@/packs/probation/service';
import {Preparation} from '../preparation';
import {SettingsScope} from '../settings-scope';
import {AccessSection} from '../access/section';
import {ConfigHead} from './config-head';
import '../../../automation/pcg.css';

/**
 * Probation Confirmation › Configuration › Probation settings (prototype SettingsPage, lane M3): ConfigHead, the group
 * standard and company settings (decision 3), each company's own settings version, then Access (prototype
 * AccessSection) for viewers the database lets manage it. Every section reads and saves through its existing service.
 */
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const ctx=await requireScopedLifecycleModule(),query=await searchParams,t=await getTranslations('probationConfig');
 const [view,access]=await Promise.all([probationSettingsScope(ctx),probationAccessView(ctx)]);
 // "Live in n of m companies": one bounded set-based read over the companies the settings view lists.
 const counts=view.canConfigure&&view.companies.length?await probationActivationCounts(ctx,view.companies.map(c=>c.id)):[];
 const live=counts.length?{live:counts.filter(c=>c.live).length,total:view.companies.length}:undefined;
 const published=view.standard?.published;
 const sub=!view.canConfigure?t('settings.subCompany'):published?t('settings.sub',{version:published.version}):t('settings.subNoStandard');
 const actions=view.canConfigure?<>
  {view.standard&&<Link className="v9-button" href="/lifecycle/probation/settings?setting=standard">{t('settings.editStandard')}</Link>}
  <Link className="v9-button v9-button-primary" href="/lifecycle/probation/settings?setting=new">{t('settings.newCompanySetting')}</Link>
 </>:null;
 return <main className="pcg">
  <ConfigHead crumb={t('crumb',{page:t('settings.title')})} title={t('settings.title')} sub={sub} actions={actions}/>
  <SettingsScope view={view} query={query} live={live}/>
  <Preparation kind="settings" query={query} embedded/>
  {access&&<AccessSection session={ctx} view={access} query={query} host="settings"/>}
 </main>;
}
