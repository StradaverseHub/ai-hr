import {notFound} from 'next/navigation';
import {requireModule} from '@/lib/authz';
import {probationAdministrationOptions,probationSetup,DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes} from '@/packs/probation/service';
import {ConfigurationEditor} from './configuration-editor';
export async function Preparation({kind,query}:{kind:'settings'|'form'|'route';query:Record<string,string|string[]|undefined>}){
 const ctx=await requireModule('lifecycle'),options=await probationAdministrationOptions(ctx),company=typeof query.company==='string'?options.companies.find(c=>c.id===query.company):options.companies[0];if(!company)notFound();
 const setup=await probationSetup(ctx,company.id),initial=setup.drafts[kind]?.data??setup[kind]?.data??(kind==='settings'?DEFAULT_PROBATION_CONFIG:kind==='form'?DEFAULT_PROBATION_FORM:defaultProbationRoutes());
 return <ConfigurationEditor key={company.id+':'+kind+':'+setup.latestVersion[kind]} company={company} options={options} setup={setup} kind={kind} initial={initial}/>;
}
