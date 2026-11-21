import {z} from 'zod';

export type AutomationEditorQuery=Record<string,string|string[]|undefined>;
export type ContractTemplateEditorTarget={kind:'document'|'email';id:string};
const id=(value:unknown)=>{const parsed=z.uuid().safeParse(value);return parsed.success?parsed.data.toLowerCase():undefined;};
/** A selection hint only. The component still selects exclusively from its already-authorized list. */
export function contractTemplateEditorTarget(query:AutomationEditorQuery):ContractTemplateEditorTarget|undefined{
 if(query.module!=='contract_staff')return;
 const keys=(['document','email'] as const).filter(key=>query[key]!==undefined);
 const kind=keys[0];
 if(keys.length!==1||!kind)return;
 const selected=id(query[kind]);
 return selected?{kind,id:selected}:undefined;
}
export function contractWorkflowEditorId(query:AutomationEditorQuery):string|undefined{
 return query.module==='contract_staff'?id(query.workflow):undefined;
}
