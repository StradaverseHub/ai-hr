'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {X} from 'lucide-react';
import type {SaveCopy} from './configuration-save-status';
export function TemplateSurface({ kind, close, children, heading, dirty = false, copy }: { copy?:SaveCopy;dirty?:boolean;heading?: ReactNode; kind: 'document' | 'email'; close: () => void; children: ReactNode }) {
  const [confirming,setConfirming]=useState(false);
  const l=(key:string,fallback:string)=>copy?.(key)??fallback;
  const requestClose=()=>{if(dirty)setConfirming(true);else close();};
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} className={'v9-dialog v9-template-surface ' + (kind === 'email' ? 'v9-email-drawer' : 'v9-template-screen')} aria-label={kind === 'email' ? 'Edit email template' : 'Edit document template'} onCancel={event=>{event.preventDefault();requestClose();}}><div className="v9-template-surface-content"><header className="v9-heading"><>{heading ?? <h2>Edit document template</h2>}</><button type="button" className="v9-button" aria-label={kind === 'email' ? 'Close' : 'Back to templates'} onClick={requestClose}>{kind === 'email' ? <X size={16}/> : 'Back to templates'}</button></header>{confirming && <section role="alertdialog" aria-label={l('ackCloseTitle','Close with unsaved changes?')} className="v9-notice v9-warning v9-stack"><p>{l('ackCloseHelp','Changes have not finished saving. Edits stay on this page, but an unfinished upload may need to be tried again.')}</p><div className="v9-actions"><button type="button" className="v9-button" autoFocus onClick={()=>setConfirming(false)}>{l('keepEditing','Keep editing')}</button><button type="button" className="v9-button" onClick={close}>{l('ackClose','Close editor')}</button></div></section>}{children}</div></dialog>;
}
