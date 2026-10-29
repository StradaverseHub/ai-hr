'use client';
import { useState } from 'react';
import { DocumentBody } from '@/components/lifecycle-v9/document-body';
import { SignatureInput } from '@/components/lifecycle-v9/signature-input';
import { documentDeliveryReserved, documentFinal, type Actor, type Case, type Document, type Template } from '@/lib/lifecycle-v9-model';
import type { LifecycleV9Command } from '@/packs/lifecycle/service';

export function CaseDocument({ c, document, template, actor, busy, command }: {
  c: Pick<Case, 'state'> & Partial<Pick<Case, 'id' | 'mails'>>; document: Document; template?: Template; actor: Actor; busy: boolean;
  command: (command: LifecycleV9Command) => void;
}) {
  const [values, setValues] = useState({ ...document.values });
  const reserved = documentDeliveryReserved({ mails: c.mails ?? [] }, document.id);
  const editable = !reserved && c.state === 'submitted' && !documentFinal(document) && !['superseded', 'withdrawn'].includes(document.status);
  const fields = document.fields.filter(field => field.owner === 'hr');
  const canEditFields = editable && document.status === 'draft' && !document.hrSignature && !document.employeeSignature;
  const dirty = fields.some(field => (values[field.id] ?? '') !== (document.values[field.id] ?? ''));
  const hrStep = document.hrStep ?? template?.hrStep;
  const needsSignature = editable && (document.templateType ?? template?.type) !== 'Attachment' && (hrStep === 'before' && document.status === 'draft' || hrStep === 'after' && document.status === 'countersign');
  const signatory = document.signatoryUserId === actor.id;
  return <div className="v9-stack">{reserved && <p className="v9-notice">This document is frozen for email delivery.</p>}{c.id && <a className="v9-button" href={`/lifecycle/v9/documents/${encodeURIComponent(c.id)}/${encodeURIComponent(document.id)}`}>Download PDF</a>}<DocumentBody document={document} values={values} editableBy="hr" disabled={busy || !canEditFields} change={(id, value) => setValues(previous => ({ ...previous, [id]: value }))}/>
    {canEditFields && fields.length > 0 && <button type="button" className="v9-button" disabled={busy || !dirty} onClick={() => command({ type: 'documentSave', id: document.id, values: Object.fromEntries(fields.filter(f => values[f.id] !== undefined).map(f => [f.id, values[f.id]])) })}>Save HR fields</button>}
    {editable && document.status === 'draft' && <button type="button" className="v9-button" disabled={busy || dirty} onClick={() => command({ type: 'documentRefresh', id: document.id })}>Refresh Personnel values</button>}
    {needsSignature && (signatory ? <>{dirty && <p className="v9-notice">Save your changes before signing this document.</p>}<SignatureInput name={actor.name} busy={busy || dirty} submit={signature => command({ type: 'documentSign', id: document.id, signature })}/></> : <p className="v9-notice">This document is waiting for the designated company HR signatory.</p>)}
  </div>;
}
