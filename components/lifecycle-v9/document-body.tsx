'use client';
import { v9SignaturePresentation } from '@/lib/lifecycle-v9-signature-presentation';
import { v9Letterhead } from '@/lib/lifecycle-v9-letterhead';
import type { ReactNode } from 'react';
import { merge, type Document, type Field } from '@/lib/lifecycle-v9-model';

export function DocumentBody({ document, values = document.values, editableBy, disabled = false, change }: {
  document: Document; values?: Record<string, string>; editableBy?: 'employee' | 'hr'; disabled?: boolean;
  change?: (id: string, value: string) => void;
}) {
  return <article className="v9-document v9-document-grid">{document.blocks.map(block => {
    const text = merge(document.edits[block.id] ?? block.text, { ...document.mergeValues, ...values }).text;
    let content: ReactNode;
    if (block.type === 'letterhead') { const letterhead = v9Letterhead(document); content = <header className="v9-letterhead" style={{ borderTopColor: letterhead.color }}><div className="v9-letterhead-name"><span aria-hidden className="v9-letterhead-mark" style={{ background: letterhead.color }}/><strong>{letterhead.name}</strong></div><p>{letterhead.registration}</p><p className="v9-prewrap">{letterhead.address}</p></header>; }
    else if (block.type === 'heading') content = <h2>{text}</h2>;
    else if (block.type === 'subheading') content = <h3>{text}</h3>;
    else if (block.type === 'text') content = <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>;
    else if (block.type === 'fields') {
      content = <div className="v9-document-grid">{document.fields.filter(f => f.section === block.section && (!f.when || values[f.when.field] === f.when.value)).map(field => <div key={field.id} className={field.width === 'half' ? 'v9-form-half' : 'v9-form-full'}><DocumentField field={field} value={values[field.id] ?? ''} disabled={disabled || editableBy !== field.owner} change={value => change?.(field.id, value)}/></div>)}</div>;
    } else if (block.type === 'field') {
      const field = document.fields.find(f => f.id === block.fieldId);
      if (!field || field.when && values[field.when.field] !== field.when.value) return null;
      return <div key={block.id} className={field.width === 'half' ? 'v9-form-half' : 'v9-form-full'}><DocumentField field={field} value={values[field.id] ?? ''} disabled={disabled || editableBy !== field.owner} change={value => change?.(field.id, value)}/></div>;
    } else if (block.type === 'table') {
      const columns = (block.columns ?? '').split(/[,|]/).map(s => s.trim());
      const rows = (block.rows ?? '').split('\n').filter(Boolean).map(row => row.split('|').map(s => s.trim()));
      content = <div className="v9-table-scroll"><table className="v9-table"><thead><tr>{columns.map((column, i) => <th key={i}>{column}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{merge(cell, { ...document.mergeValues, ...values }).text}</td>)}</tr>)}</tbody></table></div>;
    } else if (block.type === 'signature') {
      const presentation=v9SignaturePresentation(document,block.role==='hr'?'hr':'employee'),signature=presentation.signature;
      content = <div className="v9-signature"><p>{merge(block.label??'',{...document.mergeValues,...values}).text}</p>{signature?.method === 'drawn' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature.value) ? <img src={signature.value} width={300} height={100} alt={`Signature of ${signature.by.name}`}/> : signature ? <div className="v9-signature-mark">{signature.value}</div> : <div className="v9-signature-line" aria-hidden="true"/>}<strong>{presentation.name}</strong><p>{presentation.detail}</p><p className="v9-muted">{presentation.status}</p></div>;
    } else content = null;
    return <div className="v9-form-full" key={block.id}>{content}</div>;
  })}</article>;
}
export function DocumentField({ field, value, disabled, change }: { field: Field; value: string; disabled: boolean; change: (value: string) => void }) {
  const props = { disabled, required: field.required, value, onChange: (e: { target: { value: string } }) => change(e.target.value) };
  if (field.type === 'table') return <div className="v9-field"><span>{field.label}{field.required ? ' *' : ''}</span><EditableTable columns={field.columns ?? []} value={value} disabled={disabled} change={change}/></div>;
  return <label className="v9-field"><span>{field.label}{field.required ? ' *' : ''}{field.owner === 'pmLocked' ? ' · From Personnel Management' : ''}</span>{field.type === 'textarea' ? <textarea {...props} rows={3}/> : field.type === 'select' ? <select {...props}><option value="">Choose…</option>{field.options.map(option => <option key={option}>{option}</option>)}</select> : field.type === 'checkbox' ? <input type="checkbox" checked={value === 'true'} disabled={disabled} required={field.required} onChange={e => change(String(e.target.checked))}/> : <input className="v9-input" {...props} type={field.type === 'phone' ? 'tel' : field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'email' ? 'email' : 'text'}/>}</label>;
}
function EditableTable({ columns, value, disabled, change }: { columns: string[]; value: string; disabled: boolean; change: (value: string) => void }) {
  let rows: string[][] = [];
  try { const parsed: unknown = value ? JSON.parse(value) : []; if (Array.isArray(parsed) && parsed.every(row => Array.isArray(row) && row.every(cell => typeof cell === 'string'))) rows = parsed; } catch { /* Old textual values remain visible below until explicitly replaced. */ }
  const update = (row: number, column: number, cell: string) => { const next = rows.map(r => r.slice()); next[row][column] = cell; change(JSON.stringify(next)); };
  return <div className="v9-stack">{value && !rows.length && value !== '[]' && <p>{value}</p>}<div className="v9-table-scroll"><table className="v9-table"><thead><tr>{columns.map((column, i) => <th key={i}>{column}</th>)}{!disabled && <th>Actions</th>}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{columns.map((column, j) => <td key={j}><input className="v9-input" aria-label={`${column}, row ${i + 1}`} disabled={disabled} value={row[j] ?? ''} onChange={e => update(i, j, e.target.value)}/></td>)}{!disabled && <td><button type="button" className="v9-button" onClick={() => change(JSON.stringify(rows.filter((_, index) => index !== i)))}>Remove row {i + 1}</button></td>}</tr>)}</tbody></table></div>{!disabled && <button type="button" className="v9-button" disabled={rows.length >= 50} onClick={() => change(JSON.stringify([...rows, columns.map(() => '')]))}>Add row</button>}</div>;
}
