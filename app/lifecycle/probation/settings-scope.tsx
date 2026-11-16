import {probationAdministrationOptions,type ProbationSettingsScopeView} from '@/packs/probation/service';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {SettingsScopeEditor,type ScopeSelection} from './settings-scope-editor';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Group standard and company settings (decision 3). Shown only to holders of the tenant-level Probation module permission. */
export async function SettingsScope({view,query,live}:{view:ProbationSettingsScopeView;query:Record<string,string|string[]|undefined>;live?:{live:number;total:number}}){
 if(!view.canConfigure)return null;
 const ctx=await requireScopedLifecycleModule(),options=await probationAdministrationOptions(ctx);
 const setting=typeof query.setting==='string'?query.setting:null,from=typeof query.from==='string'&&UUID.test(query.from)?query.from:null;
 const selection:ScopeSelection|null=setting==='standard'?{kind:'standard',settingKey:view.standard?.settingKey??null,fromCompanyId:from}:setting==='new'?{kind:'company',settingKey:null}:setting&&UUID.test(setting)&&view.companySettings.some(s=>s.settingKey===setting)?{kind:'company',settingKey:setting}:null;
 return <SettingsScopeEditor view={view} options={options} selection={selection} live={live}/>;
}
