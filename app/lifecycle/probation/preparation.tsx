import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationAdministrationOptions,probationSetup,DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes,probationFormVersions,probationRequiredWorkflowStatus} from '@/packs/probation/service';
import {ConfigurationEditor} from './configuration-editor';
import {probationApproverChoices} from './approver-choices';
import {WorkflowReadiness} from './workflow-readiness';
export async function Preparation({kind,query,embedded=false}:{kind:'settings'|'form'|'route';query:Record<string,string|string[]|undefined>;embedded?:boolean}){
 const ctx=await requireScopedLifecycleModule(),options=await probationAdministrationOptions(ctx),company=typeof query.company==='string'?options.companies.find(c=>c.id===query.company):options.companies[0];if(!company)notFound();
 const setup=await probationSetup(ctx,company.id),forms=kind==='form'&&setup.canConfigure?await probationFormVersions(ctx,company.id):{versions:[],truncated:false},selectedForm=typeof query.formVersion==='string'?forms.versions.find(v=>v.id===query.formVersion):undefined,initial=selectedForm?.data??setup.drafts[kind]?.data??setup[kind]?.data??(kind==='settings'?DEFAULT_PROBATION_CONFIG:kind==='form'?DEFAULT_PROBATION_FORM:defaultProbationRoutes());
 const status=kind==='settings'?await probationRequiredWorkflowStatus(ctx,company.id):null;
 // 5756: the form editor's approver pickers read the shared routings and assignment groups (HR Automation).
 const approverChoices=kind==='form'&&setup.canConfigure?await probationApproverChoices(ctx):undefined;
 return <><WorkflowReadiness companies={[{id:company.id,status}]}/><ConfigurationEditor key={company.id+':'+kind+':'+setup.latestVersion[kind]+':'+(selectedForm?.id??'current')} company={company} options={options} setup={setup} kind={kind} initial={initial} formVersions={forms} selectedFormId={selectedForm?.id} embedded={embedded} approverChoices={approverChoices}/></>;
}
