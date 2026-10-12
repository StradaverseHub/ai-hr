'use client';
import { useState, type ReactNode } from 'react';
export function WorkspaceRail({children,label}:{children:ReactNode;label:string}) {
 const [open,setOpen]=useState(false);
 return <aside className="min-w-0 rounded-lg border border-border bg-card lg:sticky lg:top-4">
  <button type="button" className="flex min-h-11 w-full items-center justify-between px-4 text-sm font-medium lg:hidden" onClick={()=>setOpen(v=>!v)} aria-expanded={open} aria-controls="performance-workspace-navigation">{label}<span aria-hidden="true">{open?'−':'+'}</span></button>
  <div id="performance-workspace-navigation" className={`${open?'block':'hidden'} max-h-[75vh] overflow-y-auto lg:block`}>{children}</div>
 </aside>;
}
