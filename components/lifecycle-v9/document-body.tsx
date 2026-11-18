'use client';
import { v9SignatureBlockRole, v9SignaturePresentation } from '@/lib/lifecycle-v9-signature-presentation';
import { v9Letterhead } from '@/lib/lifecycle-v9-letterhead';
import {useId,useState,type ReactNode} from 'react';
import {effectivePersonnelCompletion,personnelCompletionIssues,personnelCompletionMergeValues,personnelCompletionLocked} from '@/lib/lifecycle-v9-personnel-completion';
import { merge, type Document, type Field } from '@/lib/lifecycle-v9-model';

export function DocumentBody({ document, values = document.values, editableBy, disabled = false, change,completionCopy,fieldErrors={} }: {
  document: Document; values?: Record<string, string>; editableBy?: 'employee' | 'hr'; disabled?: boolean;
  change?: (id: string, value: string) => void;completionCopy?:(key:string)=>string;fieldErrors?:Record<string,string>;
}) {
  const[touched,setTouched]=useState<Record<string,boolean>>({});
  const copy=(key:string,fallback:string)=>completionCopy?.(key)??fallback;
  const effectiveValues={...(document.personnelCompletion&&personnelCompletionLocked(document)?document.values:values)};
  for(const field of document.fields)if(document.personnelCompletion?.fields[field.id]&&effectivePersonnelCompletion(document,field)==='pmLocked')effectiveValues[field.id]=document.values[field.id]??'';
  const merged={...document.mergeValues,...personnelCompletionMergeValues(document,effectiveValues),...effectiveValues};
  const issues=document.personnelCompletion?personnelCompletionIssues({...document,values:effectiveValues},{owner:editableBy,final:true}):[];
  const renderField=(field:Field)=>{
    const entry=document.personnelCompletion?.fields[field.id],owner=effectivePersonnelCompletion(document,field),locked=document.personnelCompletion&&personnelCompletionLocked(document);
    const issue=issues.find(issue=>issue.fieldId===field.id);
    const fallback=issue?.message??'';
    const error=fieldErrors[field.id]??(touched[field.id]&&issue?copy('validation'+issue.code[0].toUpperCase()+issue.code.slice(1),fallback):undefined);
    const hint=entry?entry.conflict?copy('conflictHelp','Personnel Management now has a value. Your earlier answer is saved for HR review.'):owner==='employee'?copy('missingPersonalNote','Not in Personnel Management – please fill in'):undefined:undefined;
    return <DocumentField field={field} value={effectiveValues[field.id]??''} disabled={disabled||Boolean(locked)||editableBy!==owner} sourceLabel={entry?(owner==='pmLocked'?copy('fromPM','From Personnel Management'):null):undefined} hint={hint} error={error} onBlur={()=>setTouched(previous=>({...previous,[field.id]:true}))} change={value=>change?.(field.id,value)}/>;
  };
  return <article className="v9-document v9-document-grid">{document.blocks.map(block => {
    const text = merge(document.edits[block.id] ?? block.text, merged, undefined, true).text;
    let content: ReactNode;
    if (block.type === 'letterhead') { const letterhead = v9Letterhead(document); content = <header className="v9-letterhead" style={{ borderTopColor: letterhead.color }}><div className="v9-letterhead-name"><span aria-hidden className="v9-letterhead-mark" style={{ background: letterhead.color }}/><strong>{letterhead.name}</strong></div><p>{letterhead.registration}</p><p className="v9-prewrap">{letterhead.address}</p></header>; }
    else if (block.type === 'heading') content = <h2>{text}</h2>;
    else if (block.type === 'subheading') content = <h3>{text}</h3>;
    else if (block.type === 'text') content = <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>;
    else if (block.type === 'fields') {
      content = <div className="v9-document-grid">{document.fields.filter(f => f.section === block.section && (!f.when || effectiveValues[f.when.field] === f.when.value)).map(field => <div key={field.id} className={field.width === 'half' ? 'v9-form-half' : 'v9-form-full'}>{renderField(field)}</div>)}</div>;
    } else if (block.type === 'field') {
      const field = document.fields.find(f => f.id === block.fieldId);
      if (!field || field.when && effectiveValues[field.when.field] !== field.when.value) return null;
      return <div key={block.id} className={field.width === 'half' ? 'v9-form-half' : 'v9-form-full'}>{renderField(field)}</div>;
    } else if (block.type === 'table') {
      const columns = (block.columns ?? '').split(/[,|]/).map(s => s.trim());
      const rows = (block.rows ?? '').split('\n').filter(Boolean).map(row => row.split('|').map(s => s.trim()));
      content = <div className="v9-table-scroll"><table className="v9-table"><thead><tr>{columns.map((column, i) => <th key={i}>{column}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{merge(cell, merged).text}</td>)}</tr>)}</tbody></table></div>;
    } else if (block.type === 'signature') {
      const presentation=v9SignaturePresentation(document,v9SignatureBlockRole(block.role)),signature=presentation.signature;
      content = <div className="v9-signature"><p>{merge(block.label??'',merged).text}</p>{signature?.method === 'drawn' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature.value) ? <img src={signature.value} width={300} height={100} alt={`Signature of ${signature.by.name}`}/> : signature ? <div className="v9-signature-mark">{signature.value}</div> : <div className="v9-signature-line" aria-hidden="true"/>}<strong>{presentation.name}</strong><p>{presentation.detail}</p><p className="v9-muted">{presentation.status}</p></div>;
    } else content = null;
    return <div className="v9-form-full" key={block.id}>{content}</div>;
  })}</article>;
}
export function DocumentField({field,value,disabled,change,hint,error,onBlur,sourceLabel}:{field:Field;value:string;disabled:boolean;change:(value:string)=>void;hint?:string;error?:string;onBlur?:()=>void;sourceLabel?:string|null}){
 const id=useId(),described=[hint?id+'-hint':null,error?id+'-error':null].filter(Boolean).join(' ')||undefined;
 const props={disabled,required:field.required,value,onBlur,'aria-labelledby':id+'-label','aria-invalid':error?true:undefined,'aria-describedby':described,onChange:(event:{target:{value:string}})=>change(event.target.value)};
 const annotation=sourceLabel===undefined?(field.owner==='pmLocked'?'From Personnel Management':null):sourceLabel;
 const notes=<>{hint&&<small id={id+'-hint'} className="v9-muted">{hint}</small>}{error&&<p id={id+'-error'} role="alert" className="v9-error">{error}</p>}</>;
 if(field.type==='table')return <div className="v9-field"><span>{field.label}{field.required?' *':''}</span><EditableTable columns={field.columns??[]} value={value} disabled={disabled} change={change}/>{notes}</div>;
 return <label className="v9-field"><span id={id+'-label'}>{field.label}{field.required?' *':''}{annotation?' · '+annotation:''}</span>{field.type==='textarea'?<textarea {...props} className="v9-input" rows={3}/>:field.type==='select'?<select {...props}><option value="">Choose…</option>{disabled&&value&&!field.options.includes(value)&&<option value={value}>{value}</option>}{field.options.map(option=><option key={option}>{option}</option>)}</select>:field.type==='checkbox'?<input type="checkbox" checked={value==='true'} disabled={disabled} required={field.required} aria-labelledby={id+'-label'} aria-invalid={error?true:undefined} aria-describedby={described} onBlur={onBlur} onChange={event=>change(String(event.target.checked))}/>:<input className="v9-input" {...props} type={field.type==='phone'?'tel':field.type==='number'?'number':field.type==='date'?'date':field.type==='email'?'email':'text'}/>} {notes}</label>;
}

function EditableTable({ columns, value, disabled, change }: { columns: string[]; value: string; disabled: boolean; change: (value: string) => void }) {
  let rows: string[][] = [];
  try { const parsed: unknown = value ? JSON.parse(value) : []; if (Array.isArray(parsed) && parsed.every(row => Array.isArray(row) && row.every(cell => typeof cell === 'string'))) rows = parsed; } catch { /* Old textual values remain visible below until explicitly replaced. */ }
  const update = (row: number, column: number, cell: string) => { const next = rows.map(r => r.slice()); next[row][column] = cell; change(JSON.stringify(next)); };
  return <div className="v9-stack">{value && !rows.length && value !== '[]' && <p>{value}</p>}<div className="v9-table-scroll"><table className="v9-table"><thead><tr>{columns.map((column, i) => <th key={i}>{column}</th>)}{!disabled && <th>Actions</th>}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{columns.map((column, j) => <td key={j}><input className="v9-input" aria-label={`${column}, row ${i + 1}`} disabled={disabled} value={row[j] ?? ''} onChange={e => update(i, j, e.target.value)}/></td>)}{!disabled && <td><button type="button" className="v9-button" onClick={() => change(JSON.stringify(rows.filter((_, index) => index !== i)))}>Remove row {i + 1}</button></td>}</tr>)}</tbody></table></div>{!disabled && <button type="button" className="v9-button" disabled={rows.length >= 50} onClick={() => change(JSON.stringify([...rows, columns.map(() => '')]))}>Add row</button>}</div>;
}
