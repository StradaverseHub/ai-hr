import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationAdministrationOptions,probationSetup,DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes,probationFormVersions} from '@/packs/probation/service';
import {ConfigurationEditor} from './configuration-editor';
export async function Preparation({kind,query}:{kind:'settings'|'form'|'route';query:Record<string,string|string[]|undefined>}){
 const ctx=await requireScopedLifecycleModule(),options=await probationAdministrationOptions(ctx),company=typeof query.company==='string'?options.companies.find(c=>c.id===query.company):options.companies[0];if(!company)notFound();
 const setup=await probationSetup(ctx,company.id),forms=kind==='form'&&setup.canConfigure?await probationFormVersions(ctx,company.id):{versions:[],truncated:false},selectedForm=typeof query.formVersion==='string'?forms.versions.find(v=>v.id===query.formVersion):undefined,initial=selectedForm?.data??setup.drafts[kind]?.data??setup[kind]?.data??(kind==='settings'?DEFAULT_PROBATION_CONFIG:kind==='form'?DEFAULT_PROBATION_FORM:defaultProbationRoutes());
 return <ConfigurationEditor key={company.id+':'+kind+':'+setup.latestVersion[kind]+':'+(selectedForm?.id??'current')} company={company} options={options} setup={setup} kind={kind} initial={initial} formVersions={forms} selectedFormId={selectedForm?.id}/>;
}
