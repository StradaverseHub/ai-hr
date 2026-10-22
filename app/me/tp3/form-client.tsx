'use client';
import {useActionState,useEffect,useRef,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {Button,ErrorBanner} from '@/components/ui';
import {myTp3FormAction} from './actions';
export function MyTp3EditableForm({children}:{children:ReactNode}) {
  const t=useTranslations('myTp3');
  const [state,action,pending]=useActionState(myTp3FormAction,{error:null});
  const banner=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(state.error){banner.current?.focus();banner.current?.scrollIntoView({block:'center'});}},[state.error]);
  return <form action={action} className="space-y-5"><div ref={banner} tabIndex={-1}>{state.error&&<ErrorBanner message={state.error}/>}</div><fieldset disabled={pending} className="min-w-0 space-y-5">{children}<div className="flex flex-wrap items-center gap-3"><Button type="submit" name="intent" value="draft" variant="secondary" className="min-h-11">{t('saveDraft')}</Button><Button type="submit" name="intent" value="submit" className="min-h-11">{pending?t('saving'):t('submit')}</Button></div><p className="text-xs text-muted-foreground">{t('draftHelp')}</p></fieldset></form>;
}
