'use client';

import { useEffect, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';

/** The journey's narrow rail becomes a modal left drawer on phones. */
export function WorkspaceRail({children,label}:{children:ReactNode;label:string}) {
 const [open,setOpen]=useState(false);
 const t=useTranslations('components.drawer');
 useEffect(()=>{
  const desktop=window.matchMedia('(min-width: 1024px)');
  const closeOnDesktop=()=>{if(desktop.matches)setOpen(false);};
  desktop.addEventListener('change',closeOnDesktop);
  return ()=>desktop.removeEventListener('change',closeOnDesktop);
 },[]);
 return <>
  <aside className="sticky top-4 hidden max-h-[75vh] min-w-0 overflow-y-auto rounded-lg border border-border bg-card lg:block">{children}</aside>
  <Dialog.Root open={open} onOpenChange={setOpen}>
   <Dialog.Trigger className="flex min-h-11 items-center justify-between rounded-lg border border-border bg-card px-4 text-sm font-medium lg:hidden">{label}<span aria-hidden="true">☰</span></Dialog.Trigger>
   <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40"/>
    <Dialog.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-50 w-[min(20rem,85vw)] overflow-y-auto border-r border-border bg-card shadow-xl outline-none">
     <header className="flex min-h-14 items-center justify-between border-b border-border px-4"><Dialog.Title className="text-sm font-semibold">{label}</Dialog.Title><Dialog.Close className="flex size-11 items-center justify-center rounded-md hover:bg-muted" aria-label={t('close')}><span aria-hidden="true">×</span></Dialog.Close></header>
     <div onClick={event=>{if(event.target instanceof Element&&event.target.closest('a'))setOpen(false);}}>{children}</div>
    </Dialog.Content>
   </Dialog.Portal>
  </Dialog.Root>
 </>;
}
