'use client';
import {useRef,useState,useTransition,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {Button,ErrorBanner} from '@/components/ui';
import type {DemoSmtpResult} from '@/lib/demo-smtp-model';
import {testDemoSmtpConnection} from './demo-actions';

export function DemoSmtpForm({children}:{children:ReactNode}){
  const t=useTranslations('identityEmail'),form=useRef<HTMLFormElement>(null),inFlight=useRef(false);
  const [result,setResult]=useState<DemoSmtpResult|null>(null),[pending,startTransition]=useTransition();
  return <form ref={form} method="post" className="space-y-4 p-5" onChange={event=>{
    setResult(null);
    const target=event.target;
    if(target instanceof HTMLSelectElement&&target.name==='security'){
      const port=form.current?.elements.namedItem('port');
      if(port instanceof HTMLInputElement&&['465','587'].includes(port.value))port.value=target.value==='tls'?'465':'587';
    }
  }} onSubmit={event=>{
    event.preventDefault();if(inFlight.current)return;inFlight.current=true;
    const data=new FormData(event.currentTarget);setResult(null);
    startTransition(async()=>{
      try{setResult(await testDemoSmtpConnection(data));}catch{setResult({status:'error',code:'unavailable'});}
      finally{inFlight.current=false;const password=form.current?.elements.namedItem('password');if(password instanceof HTMLInputElement)password.value='';data.delete('password');}
    });
  }}>
    <fieldset disabled={pending} aria-label={t('connectionTitle')} className="grid min-w-0 gap-4 sm:grid-cols-2">{children}</fieldset>
    <p className="max-w-prose text-sm text-muted-foreground">{t('demoTestHelp')}</p>
    <Button type="submit" disabled={pending} aria-busy={pending}>{t(pending?'testingConnection':'testConnection')}</Button>
    {result?.status==='error'&&<ErrorBanner message={t(`demoErrors.${result.code}`)}/>}
    <div role="status" aria-live="polite">{result?.status==='success'&&<p className="rounded-xl border border-border bg-card p-4 text-sm">{t(result.authenticated?'demoAuthenticated':'demoConnected')}</p>}</div>
  </form>;
}
