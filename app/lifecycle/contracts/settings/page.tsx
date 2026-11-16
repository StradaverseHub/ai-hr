import {redirect,notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {contractSharedConfigurationChoices,contractSharedSettings,contractSharedAccess,contractSharedSetup} from '@/packs/contracts/service';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {SharedContractSettings} from './shared-settings';
import '../../v9/workspace.css';
import '../shared-contract.css';
export default async function Page({searchParams}:{searchParams:Promise<{companyId?:string}>}){const s=await requireScopedLifecycleModule();if(!s)redirect('/login');const choices=await contractSharedConfigurationChoices(s);if(!choices.accessAdmin&&!choices.companies.length)notFound();const requested=(await searchParams).companyId,companyId=choices.companies.find(c=>c.id===requested)?.id??choices.companies[0]?.id??null;const [settings,access,setup]=await Promise.all([companyId?contractSharedSettings(s,companyId):null,choices.accessAdmin?contractSharedAccess(s):null,companyId?contractSharedSetup(s,companyId):null]);return <main className="v9-workspace"><SharedContractSettings key={companyId+':'+settings?.revision} choices={choices} companyId={companyId} stored={settings} access={access} setup={setup} today={todayInKualaLumpur()}/></main>;}
