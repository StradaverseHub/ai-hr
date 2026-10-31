'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

export function RecordDrawer({children,title,closeLabel,returnTo}:{children:ReactNode;title:string;closeLabel:string;returnTo:string}) {
 const dialog=useRef<HTMLDialogElement>(null),router=useRouter();
 useEffect(()=>{const node=dialog.current;if(node&&!node.open)node.showModal();return()=>node?.close();},[]);
 return <dialog ref={dialog} aria-label={title} onCancel={event=>{event.preventDefault();router.push(returnTo);}} className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-2xl border-l border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/30">
  <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-5 py-4"><h1 className="font-semibold">{title}</h1><button type="button" onClick={()=>router.push(returnTo)} className="min-h-11 rounded-md px-3 text-sm hover:bg-muted">{closeLabel}</button></header>{children}
 </dialog>;
}
