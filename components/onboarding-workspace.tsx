'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useOnboardingCopy } from '@/lib/onboarding-copy';

export function OnboardingBreadcrumb({ root, items = [] }: { root: string; items?: { label: string; href?: string }[] }) {
  const copy = useOnboardingCopy();
  return <nav aria-label={copy('Breadcrumb')} className="onb-breadcrumb"><span>{copy(root)}</span>{items.map((item,i) => <span key={i}><span aria-hidden="true"> / </span>{item.href ? <Link href={item.href}>{copy(item.label)}</Link> : copy(item.label)}</span>)}</nav>;
}

export function OnboardingBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'primary' | 'new' }) {
  return <span className={'onb-badge onb-badge-' + tone}>{children}</span>;
}

export function OnboardingSummary({ children }: { children: ReactNode }) {
  return <div className="onb-summary">{children}</div>;
}

export function OnboardingStat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return <div className="onb-stat"><span className="onb-muted">{label}</span><strong>{value}</strong>{detail && <span className="onb-muted">{detail}</span>}</div>;
}

/** Native popover escapes the scrolling table and supports keyboard, click and dismissal. */
export function OnboardingProgress({ name, percent, next, due, checklist, ticket, breakdown, pending = false }: { name: string; percent: number; next: string; due: string; checklist: string; ticket: string; breakdown: string; pending?:boolean }) {
  const id = useId(), copy = useOnboardingCopy(), hideTimer=useRef<number|undefined>(undefined);
  const keepOpen=()=>{window.clearTimeout(hideTimer.current);};
  useEffect(()=>()=>{window.clearTimeout(hideTimer.current);},[]);
  const show=(button:HTMLButtonElement)=>{
    keepOpen();const pop=document.getElementById(id);if(!pop)return;
    pop.style.margin='0';pop.style.left='16px';pop.style.top='16px';
    if(!pop.matches(':popover-open'))pop.showPopover();
    const box=button.getBoundingClientRect(),size=pop.getBoundingClientRect();
    pop.style.left=Math.max(16,Math.min(box.right-size.width,window.innerWidth-size.width-16))+'px';
    const top=box.bottom+8+size.height<=window.innerHeight-16?box.bottom+8:box.top-size.height-8;
    pop.style.top=Math.max(16,Math.min(top,window.innerHeight-size.height-16))+'px';
  };
  const hide=()=>{keepOpen();const pop=document.getElementById(id);if(pop?.matches(':popover-open'))pop.hidePopover();};
  const scheduleHide=()=>{keepOpen();hideTimer.current=window.setTimeout(hide,150);};
  return <><button type="button" className="onb-progress-trigger" aria-controls={id} aria-describedby={id} aria-label={copy('Progress')+' '+percent+'%. '+copy('Show the current pending step for')+' '+name} onClick={e=>show(e.currentTarget)} onMouseEnter={e=>show(e.currentTarget)} onMouseLeave={scheduleHide} onFocus={e=>show(e.currentTarget)} onBlur={hide}>{pending?<OnboardingBadge tone="warning">{copy('Pending submission')}</OnboardingBadge>:<><span className="onb-progress-track" data-complete={percent===100||undefined}><span style={{width:percent+'%'}}/></span><span>{percent}%{percent===100?' ✓':''}</span></>}</button><div popover="auto" role="tooltip" id={id} className="onb-progress-popover" onMouseEnter={keepOpen} onMouseLeave={scheduleHide}><h3>{name}: {copy('current progress')}</h3><p>{checklist}</p><strong>{copy(next)}</strong>{due&&<p>{copy('Due')} {due}</p>}<p>{ticket}</p><p>{breakdown}</p></div></>;
}
