import type {ReactNode} from 'react';

/**
 * Prototype ConfigHead (lane M3): breadcrumb, page title, sub-line and the page actions on the right. Plain markup, so
 * server and client pages share it; callers pass translated text.
 */
export function ConfigHead({crumb,title,sub,actions}:{crumb:string;title:string;sub?:ReactNode;actions?:ReactNode}){
 return <>
  <p className="pcg-crumb">{crumb}</p>
  <header className="pcg-ph"><div><h1>{title}</h1>{sub?<p>{sub}</p>:null}</div>{actions?<div className="pcg-ph-actions">{actions}</div>:null}</header>
 </>;
}

/** Prototype info banner (icon + bold lead + text + optional small line). */
export function ConfigBanner({tone='plain',lead,children,small,role}:{tone?:'plain'|'ok'|'warn'|'accent';lead?:ReactNode;children?:ReactNode;small?:ReactNode;role?:'note'|'status'|'alert'}){
 return <div className={'pcg-banner'+(tone==='accent'?'':' pcg-banner-'+tone)} role={role}>
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{tone==='warn'?<><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5"/><path d="M12 18h.01"/></>:<><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></>}</svg>
  <div>{lead?<b>{lead}</b>:null}{lead&&children?' ':null}{children}{small?<small>{small}</small>:null}</div>
 </div>;
}
