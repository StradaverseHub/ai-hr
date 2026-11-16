'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {Button,inputCls} from '@/components/ui';
import type {ResignationCaseView,ResignationJourneyCommand} from '@/lib/resignation-journey';
/** An owner can override this case's email; template publication remains in shared Configuration. */
export function ResignationEmailEditor({email,busy,command}:{email:ResignationCaseView['emails'][number];busy:boolean;command:(command:ResignationJourneyCommand)=>Promise<boolean>}){
 const t=useTranslations('resignationJourney'),[open,setOpen]=useState(false),[subject,setSubject]=useState(email.subject),[body,setBody]=useState(email.body);
 return <section className="space-y-3 rounded-lg border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h4 className="font-medium">{email.name}</h4><Button variant="outline" disabled={busy} onClick={()=>setOpen(value=>!value)}>{t('editEmail')}</Button></div>{open&&<form className="space-y-3" onSubmit={async event=>{event.preventDefault();if(await command({type:'updateEmail',emailTemplateId:email.id,subject,body}))setOpen(false);}}><p className="text-sm text-muted-foreground">{t('emailForCase')}</p><label className="block space-y-1 text-sm"><span>{t('emailSubject')}</span><input className={inputCls} required maxLength={500} value={subject} disabled={busy} onChange={event=>setSubject(event.target.value)}/></label><label className="block space-y-1 text-sm"><span>{t('emailBody')}</span><textarea className={inputCls} rows={7} required maxLength={20000} value={body} disabled={busy} onChange={event=>setBody(event.target.value)}/></label><section className="space-y-2 rounded-lg border bg-muted/20 p-3 text-sm" aria-label={t('preview')}><h5 className="font-medium">{subject}</h5><p className="whitespace-pre-wrap break-words">{body}</p></section><Button type="submit" disabled={busy}>{t('saveEmail')}</Button></form>}</section>;
}
