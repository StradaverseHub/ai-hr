/** Metadata only. Answers, signatures and HR-private state never enter My tasks. */
export type LifecycleTaskDocument = {
  caseId: string; module: 'onb' | 'off'; caseNumber: string; revision: number;
  taskId: string | null; taskName: string | null; taskStatus: string | null;
  dueOn: string | null; action: 'completed' | 'signed' | 'sent' | null;
  sourceName: string; sourceKind: 'checklist' | 'workflow' | 'document';
  documentId: string | null; documentName: string; documentStatus: string | null;
  state: 'released' | 'unreleased' | 'review';
};
export type LifecycleTaskDocumentsPage = { items: LifecycleTaskDocument[]; total: number; offset: number; limit: number };
export function lifecycleDocumentHref(item: Pick<LifecycleTaskDocument, 'caseId' | 'documentId' | 'state'>): string | null {
  return item.state === 'released' && item.documentId ? '/me/lifecycle?case=' + encodeURIComponent(item.caseId) + '&document=' + encodeURIComponent(item.documentId) : null;
}
export function documentTaskCompletion(action: LifecycleTaskDocument['action']): string {
  return action === 'signed' ? 'Completes when you sign the document' : action === 'sent' ? 'Completes when HR releases the document' : 'Completes when you submit or sign the document';
}

/** A duplicate live instance is a visible hold, irrespective of input array order. */
export function currentTaskDocument<T extends {id:string;templateId:string;version:number;createdAt:string;status:string}>(documents:readonly T[],template:string|null):{state:'released'|'unreleased'|'review';document:T|null}{
 const candidates=documents.filter(doc=>doc.templateId===template&&!['withdrawn','superseded'].includes(doc.status)).sort((a,b)=>b.version-a.version||b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
 if(candidates.length>1)return {state:'review',document:null};
 const doc=candidates[0];return doc&&['sent','opened','completed','signed','acknowledged','countersign'].includes(doc.status)?{state:'released',document:doc}:{state:'unreleased',document:null};
}
