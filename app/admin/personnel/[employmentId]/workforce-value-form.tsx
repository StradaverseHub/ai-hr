import type {WorkforceEditor,WorkforceEditorRow} from '@/core/workforce-maintenance';
import {workforceMaintenanceFields,type WorkforceMaintenanceKind,type WorkforceValue} from '@/lib/workforce-maintenance-fields';
import {personnelFieldChoices} from '@/lib/personnel-import-contract';
import {inputCls} from '@/components/ui';
import {saveWorkforceRecordAction} from './workforce-record-actions';
import {WorkforceSubmit} from './workforce-submit';

type Translator=((key:string)=>string)&{has:(key:string)=>boolean};
type Props={employmentId:string;kind:WorkforceMaintenanceKind;section?:string;row?:WorkforceEditorRow;
 values:Record<string,WorkforceValue>;editor:WorkforceEditor;root:Translator;access:Translator};
function Identity({employmentId,kind,section,row,editor}:Omit<Props,'values'|'root'|'access'>){
 return <>
  <input type="hidden" name="employmentId" value={employmentId}/><input type="hidden" name="kind" value={kind}/>
  {section&&<input type="hidden" name="section" value={section}/>}
  {row&&<input type="hidden" name="rowId" value={row.id}/>}
  {(row||kind==='person')&&<input type="hidden" name="expectedVersion" value={row?.version??editor.profileVersion}/>}
 </>;
}
/** Server-rendered fixed fields, using the same declaration/catalog vocabulary as the existing owners. */
export function WorkforceValueForm(props:Props){
 const {kind,section,row,values,editor,root,access}=props;
 const prefix=`workforce-${kind}-${section??row?.id??'new'}`;
 return <div className="space-y-4 p-4">
  <form action={saveWorkforceRecordAction} className="space-y-4">
   <Identity {...props}/><input type="hidden" name="operation" value={row||kind==='person'?'update':'add'}/>
   <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {workforceMaintenanceFields(kind,section).map(({key,field})=>{
     const id=`${prefix}-${key}`,value=values[key]??(field.type==='boolean'?false:'');
     const label=root.has(field.labelKey)?root(field.labelKey):field.label;
     const category=field.allowedValuesOwner?.startsWith('profile_option:')?field.allowedValuesOwner.slice(15):null;
     const options=category?editor.options.filter(option=>option.category===category).map(option=>({value:option.value,label:option.label})):
      personnelFieldChoices(field).map(option=>({value:option.value,label:root.has(option.labelKey)?root(option.labelKey):option.value}));
     // An inactive stored choice must remain editable without forcing an unrelated replacement.
     const current=String(value);
     if(options.length&&current&&!options.some(option=>option.value===current))options.unshift({value:current,label:current});
     const required=Boolean(field.form?.required?.record)&&((!row&&kind!=='person')||current!=='');
     return <div key={key} className="space-y-1">
      <label className="block text-sm" htmlFor={id}>{label}{required?' *':''}</label>
      {options.length?<select id={id} name={key} className={inputCls} defaultValue={current} required={required}>
       {field.type!=='boolean'&&<option value="">—</option>}
       {options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
      </select>:<input id={id} name={key} className={inputCls} defaultValue={current} maxLength={4000} required={required}
       inputMode={field.form?.widget==='email'?'email':undefined}
       type={field.form?.widget==='month'?'month':field.type==='date'?'date':'text'}/>}
     </div>;
    })}
   </div>
   {kind==='qualification'&&<p className="text-xs text-muted-foreground">{root('people.detail.qualification.highestHint')}</p>}
   {kind==='emergency'&&<p className="text-xs text-muted-foreground">{root('people.detail.emergency.primaryHint')}</p>}
   <WorkforceSubmit label={access('workforceEdit.save')} pendingLabel={access('workforceEdit.saving')}/>
  </form>
  {row&&<details className="border-t pt-3">
   <summary className="cursor-pointer text-sm text-muted-foreground">{access('workforceEdit.archive')}</summary>
   <form action={saveWorkforceRecordAction} className="mt-3 space-y-3">
    <Identity {...props}/><input type="hidden" name="operation" value="archive"/>
    <p className="text-sm text-muted-foreground">{access('workforceEdit.archiveHint')}</p>
    <WorkforceSubmit archive label={access('workforceEdit.archive')} pendingLabel={access('workforceEdit.saving')}/>
   </form>
  </details>}
 </div>;
}
