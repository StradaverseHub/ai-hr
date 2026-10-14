'use client';
import { useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Button } from './ui';
/** Same collapsible left column as Individual Attendance, with a drawer on small screens. */
export function AttendanceHistoryFilters({panel,children,defaultOpen}:{panel:ReactNode;children:ReactNode;defaultOpen:boolean}){
  const t=useTranslations('attendanceHistory'),[open,setOpen]=useState(false),[expanded,setExpanded]=useState(defaultOpen);
  function toggle(){setExpanded(!expanded);document.cookie=`attendance-history-panel=${expanded?'0':'1'}; path=/; max-age=31536000; samesite=lax`;}
  return <div className="space-y-4"><div className="hidden justify-end lg:flex"><Button type="button" variant="outline" aria-expanded={expanded} onClick={toggle}>{t(expanded?'hideFilters':'showFilters')}</Button></div>
    <div className="lg:hidden"><Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger asChild><Button type="button" variant="outline">{t('showFilters')}</Button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/><Dialog.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-50 w-[min(90vw,24rem)] overflow-y-auto border-r border-border bg-popover p-4 text-popover-foreground shadow-xl"><div className="mb-4 flex items-center justify-between gap-3"><Dialog.Title className="font-semibold">{t('showFilters')}</Dialog.Title><Dialog.Close asChild><Button type="button" variant="outline">{t('close')}</Button></Dialog.Close></div>{panel}</Dialog.Content></Dialog.Portal></Dialog.Root></div>
    <div className={expanded?'grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]':'min-w-0'}>{expanded&&<aside className="hidden lg:block">{panel}</aside>}<div className="min-w-0">{children}</div></div></div>;
}
