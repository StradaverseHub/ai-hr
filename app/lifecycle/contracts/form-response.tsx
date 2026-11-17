'use client';
import {DocumentBody} from '@/components/lifecycle-v9/document-body';
import type {Document} from '@/lib/lifecycle-v9-model';
import type {ContractSharedLetter,ContractSharedForm} from '@/packs/contracts/service';
import {useContractSharedCopy} from '@/lib/contract-shared-copy';
import {contractTimestamp} from './shared';

export function ContractFormResponse({form,document,values,busy,dirty,missing,history,change,save,discard}:{
 form:Extract<ContractSharedForm,{visible:true}>;document:Document;values:Record<string,string>;busy:boolean;dirty:boolean;
 missing:string[];history:ContractSharedLetter['history'];change:(id:string,value:string)=>void;save:()=>void;discard:()=>void;
}){
 const copy=useContractSharedCopy();
 return <div className="v9-stack">
  <DocumentBody document={{...document,values}} values={values} editableFieldIds={new Set(form.editableFieldIds)} disabled={busy} change={change}/>
  {form.missingLockedFields.length>0&&<div className="v9-notice v9-error" role="status"><strong>{copy('Required source fields need attention')}</strong><ul>{form.missingLockedFields.map(id=><li key={id}>{document.fields.find(field=>field.id===id)?.label??copy('Required source field')}</li>)}</ul><p>{copy('An authorised Personnel owner must correct these locked source fields before this form can be completed.')}</p></div>}
  {form.editableFieldIds.length>0&&<div className="v9-actions"><button type="button" className="v9-button v9-button-primary" disabled={busy||!dirty} onClick={save}>{copy('Save form answers')}</button><span className="v9-muted">{copy('Answers are recorded for this form. Personnel records are unchanged.')}</span></div>}
  {missing.length>0&&<p role="status">{copy('Complete the required answers before completing this step:')} {missing.join(', ')}</p>}
  {dirty&&<><p role="status">{copy('Save your answers before completing this step or signing.')}</p><button type="button" className="v9-button" disabled={busy} onClick={discard}>{copy('Discard unsaved answers and reload')}</button></>}
  {form.receipts.length>0&&<section><h2>{copy('Recorded form answers')}</h2><ol className="contract-rail">{form.receipts.map(receipt=>{const action=history.find(item=>item.id===receipt.actionId);return <li key={receipt.actionId}><div><strong>{receipt.actorName??action?.actorName??copy(receipt.scope==='employee'?'Employee answer receipt':'HR answer receipt')}</strong><p>{receipt.at||action?.at?contractTimestamp(receipt.at??action!.at)+' · ':''}{copy('Response version')} {receipt.responseRevision}</p><dl>{Object.entries(receipt.values).map(([id,value])=><div key={id}><dt>{document.fields.find(field=>field.id===id)?.label??copy('Recorded field')}</dt><dd>{value||'—'}</dd></div>)}</dl></div></li>})}</ol></section>}
 </div>;
}
