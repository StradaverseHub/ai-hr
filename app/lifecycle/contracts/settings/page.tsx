import {redirect,notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {contractCompanies,contractSettings,contractConfigurationChoices,contractTemplates} from '@/packs/contracts/service';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {ContractSettingsEditor} from './settings';
import '../../v9/workspace.css';
export default async function Page(){const s=await requireScopedLifecycleModule();if(!s)redirect('/login');const companies=(await contractCompanies(s)).filter(c=>c.configure);if(!companies.length)notFound();const settings=await contractSettings(s),choices=await Promise.all(companies.map(async c=>({companyId:c.id,...await contractConfigurationChoices(s,c.id)})));return <main className="v9-workspace"><ContractSettingsEditor companies={companies} templatesAvailable={companies.some(c=>c.gbs)||(await contractTemplates(s)).length>0} settings={settings} choices={choices} today={todayInKualaLumpur()}/></main>;}
