'use client';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '@/components/ui';
import { onehrDraftAction } from '../onehr-actions';
export function DraftAssist({reviewId}:{reviewId:string}){
  const t=useTranslations('onehr'),[words,setWords]=useState(''),[draft,setDraft]=useState(''),[error,setError]=useState(''),[pending,start]=useTransition();
  return <div className="space-y-3"><p className="text-sm text-muted-foreground">{t('aiDraftHelp')}</p><Field label={t('evidenceNote')}><textarea maxLength={4000} value={words} onChange={e=>setWords(e.target.value)} className={inputCls}/></Field><Button type="button" variant="secondary" disabled={pending||!words.trim()} onClick={()=>start(async()=>{setError('');setDraft('');const r=await onehrDraftAction(reviewId,words);if(r.error)setError(r.error);else if(r.draft)setDraft(r.draft);})}>{pending?t('aiDrafting'):t('aiDraft')}</Button>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{draft&&<Field label={t('aiDraft')}><textarea rows={8} maxLength={4000} value={draft} onChange={e=>setDraft(e.target.value)} className={inputCls}/></Field>}</div>;
}
