'use client';
import { v9CompanySigners } from '@/lib/lifecycle-v9-signatories';
import type { Config } from '@/lib/lifecycle-v9-model';
import { useEffect, useRef, useState } from 'react';
import { DocumentTextEditor } from './document-text-editor';
import { DocumentBody } from '@/components/lifecycle-v9/document-body';
import { SignatureInput } from '@/components/lifecycle-v9/signature-input';
import { documentDeliveryReserved, documentFinal, type Actor, type Case, type Document, type Template } from '@/lib/lifecycle-v9-model';
import type { LifecycleV9Command } from '@/packs/lifecycle/service';

export function CaseDocument({ c, document, template, actor, busy, command, config, users = [], eligibleSignatoryIds }: {
  c: Pick<Case, 'state'> & Partial<Pick<Case, 'id' | 'mails' | 'facts'>>; document: Document; template?: Template; actor: Actor; busy: boolean;
  eligibleSignatoryIds?:string[]; config?: Config; users?:{id:string;name:string}[];
  command: (command: LifecycleV9Command) => void | Promise<{ ok: boolean; error?: string }>;
}) {
  const [values, setValues] = useState({ ...document.values }), [editingText,setEditingText] = useState(false), [error,setError]=useState('');
  const errorRef=useRef<HTMLParagraphElement>(null);
  useEffect(()=>{if(error)errorRef.current?.focus();},[error]);
  async function execute(value:LifecycleV9Command){setError('');try{const result=await command(value);if(result&&!result.ok)setError(result.error??'The document could not be saved.');return result??{ok:true};}catch{const result={ok:false,error:'The document could not be saved. Your edits are still here.'};setError(result.error);return result;}}
  const reserved = documentDeliveryReserved({ mails: c.mails ?? [] }, document.id);
  const editable = !reserved && c.state === 'submitted' && !documentFinal(document) && !['superseded', 'withdrawn'].includes(document.status);
  const fields = document.fields.filter(field => field.owner === 'hr');
  const canEditFields = editable && document.status === 'draft' && !document.hrSignature && !document.employeeSignature;
  const dirty = fields.some(field => (values[field.id] ?? '') !== (document.values[field.id] ?? ''));
  const hrStep = document.hrStep ?? template?.hrStep;
  const needsSignature = editable && (document.templateType ?? template?.type) !== 'Attachment' && (hrStep === 'before' && document.status === 'draft' || hrStep === 'after' && document.status === 'countersign');
  const allowed=(config&&c.facts?v9CompanySigners(config,c.facts.company):[]).filter(id=>eligibleSignatoryIds===undefined||eligibleSignatoryIds.includes(id));
  const signatory = hrStep === 'after' || document.signatoryUserId === actor.id && (!config||allowed.includes(actor.id));
  return <div className="v9-stack">{reserved && <p className="v9-notice">This document is frozen for email delivery.</p>}{c.id && <a className="v9-button" href={`/lifecycle/v9/documents/${encodeURIComponent(c.id)}/${encodeURIComponent(document.id)}`}>Download PDF</a>}<DocumentBody document={document} values={values} editableBy="hr" disabled={busy || !canEditFields} change={(id, value) => setValues(previous => ({ ...previous, [id]: value }))}/>{error&&<p ref={errorRef} tabIndex={-1} role="alert" className="v9-notice v9-error">{error}</p>}
    {canEditFields && (document.templateType ?? template?.type) !== 'Attachment' && document.blocks.some(block => ['heading','subheading','text'].includes(block.type)) && <button type="button" className="v9-button" disabled={busy || dirty} onClick={() => setEditingText(true)}>Edit for this person</button>}
    {editingText && canEditFields && <DocumentTextEditor document={document} person={c.facts?.name ?? 'this person'} busy={busy} command={execute} close={() => setEditingText(false)}/>}
    {canEditFields && fields.length > 0 && <button type="button" className="v9-button" disabled={busy || !dirty} onClick={() => execute({ type: 'documentSave', id: document.id, values: Object.fromEntries(fields.filter(f => values[f.id] !== undefined).map(f => [f.id, values[f.id]])) })}>Save HR fields</button>}
    {editable && document.status === 'draft' && <button type="button" className="v9-button" disabled={busy || dirty} onClick={() => execute({ type: 'documentRefresh', id: document.id })}>Refresh Personnel values</button>}
    {needsSignature&&hrStep==='before'&&config&&<label className="v9-field"><span>HR signatory for this document</span><select disabled={busy||dirty} value={document.signatoryUserId??''} onChange={e=>void execute({type:'documentSignatory',id:document.id,userId:e.target.value})}><option value="" disabled>Choose a permitted signatory</option>{document.signatoryUserId&&!allowed.includes(document.signatoryUserId)&&<option value={document.signatoryUserId} disabled>Previously designated signer</option>}{allowed.map(id=><option key={id} value={id}>{users.find(user=>user.id===id)?.name??(id===actor.id?actor.name:'Permitted signer')}{id===config.companies?.find(company=>company.companyId===c.facts?.company)?.signatoryUserId?' (company default)':''}</option>)}</select></label>}
    {needsSignature && (signatory ? <>{dirty && <p className="v9-notice">Save your changes before signing this document.</p>}<SignatureInput name={actor.name} busy={busy || dirty} submit={signature => execute({ type: 'documentSign', id: document.id, signature })}/></> : <p className="v9-notice">This document is waiting for the designated company HR signatory.</p>)}
  </div>;
}
