'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {X} from 'lucide-react';

export function WorkflowField({label,children}:{label:string;children:ReactNode}){
 return <label className="v9-field"><span>{label}</span>{children}</label>;
}
export function WorkflowButton({children,onClick,disabled=false,primary=false}:{children:ReactNode;onClick:()=>void;disabled?:boolean;primary?:boolean}){
 return <button type="button" className={'v9-button'+(primary?' v9-button-primary':'')} disabled={disabled} onClick={onClick}>{children}</button>;
}
export function WorkflowSection({title,children,className=''}:{title:string;children:ReactNode;className?:string}){
 return <section className={'v9-workflow-section'+(className?' '+className:'')} aria-label={title}><h3>{title}</h3>{children}</section>;
}
type Props={title:string;moduleLabel:string;stateLabel:string;required?:boolean;description:ReactNode;when:ReactNode;onlyIf:ReactNode;then:ReactNode;dryRun:ReactNode;actions:ReactNode;history?:ReactNode;onClose?:()=>void};
/** Presentation only: each module owns schema, permissions, saves and execution. */
export function WorkflowEditorShell({title,moduleLabel,stateLabel,required=false,description,when,onlyIf,then,dryRun,actions,history,onClose}:Props){
 const t=useTranslations('workflowEditor');
 const [tab,setTab]=useState<'steps'|'history'>('steps');
 const dialog=useRef<HTMLDialogElement>(null),modal=Boolean(onClose);
 useEffect(()=>{const element=dialog.current;if(modal)element?.showModal();return()=>element?.close();},[modal]);
 const body=<><header className="v9-heading"><div><h2>{title}</h2><p className="v9-muted">{moduleLabel} · {stateLabel}{required?' · '+t('required'):''}</p></div>{onClose&&<button type="button" className="v9-button" onClick={onClose} aria-label={t('close')}><X size={18}/></button>}</header>
  {history!==undefined&&<div className="v9-tabs" aria-label={t('view')}><button type="button" className={tab==='steps'?'v9-button v9-button-primary':'v9-button'} aria-pressed={tab==='steps'} onClick={()=>setTab('steps')}>{t('steps')}</button><button type="button" className={tab==='history'?'v9-button v9-button-primary':'v9-button'} aria-pressed={tab==='history'} onClick={()=>setTab('history')}>{t('history')}</button></div>}
  {tab==='history'&&history!==undefined?history:<div className="v9-stack">{description}<WorkflowSection title={t('when')}>{when}</WorkflowSection><WorkflowSection title={t('onlyIf')}>{onlyIf}</WorkflowSection><WorkflowSection title={t('then')}>{then}</WorkflowSection>{dryRun}<div className="v9-actions">{actions}</div></div>}</>;
 return onClose?<dialog ref={dialog} className="v9-dialog v9-drawer" aria-label={title} onCancel={onClose}>{body}</dialog>:<section className="v9-panel v9-stack" aria-label={title}>{body}</section>;
}
