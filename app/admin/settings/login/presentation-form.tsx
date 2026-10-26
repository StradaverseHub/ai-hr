'use client';
import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls, btnPrimary } from '@/components/ui';
import type { LoginPresentation } from '@/lib/login-presentation';
import { saveLoginPresentationAction, type LoginPresentationResult } from './actions';

export function LoginPresentationForm({ presentation, revision }: { presentation: LoginPresentation; revision: number }) {
  const t = useTranslations('loginPresentation');
  const [state, action, pending] = useActionState(saveLoginPresentationAction, { status: 'idle' } as LoginPresentationResult);
  const [type, setType] = useState(presentation.mediaType);
  const [mediaUrl, setMediaUrl] = useState(presentation.mediaUrl);
  const [alt, setAlt] = useState(presentation.alt);
  return <form action={action} className="space-y-6">
    <input type="hidden" name="revision" value={state.revision ?? revision}/>
    <label className="block space-y-2"><span className="text-sm font-medium">{t('mediaType')}</span>
      <select name="mediaType" className={inputCls} value={type} onChange={event => setType(event.target.value as LoginPresentation['mediaType'])}>
        {(['none','image','gif','video'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}
      </select>
    </label>
    <label className="block space-y-2"><span className="text-sm font-medium">{t('mediaUrl')}</span>
      <input name="mediaUrl" type="url" className={`${inputCls} w-full`} value={mediaUrl} onChange={event => setMediaUrl(event.target.value)} required={type !== 'none'} disabled={type === 'none'} maxLength={2048} placeholder="https://…" aria-describedby="login-media-help"/>
    </label>
    <p id="login-media-help" className="text-sm leading-relaxed text-muted-foreground">{t('urlHelp')}</p>
    <label className="block space-y-2"><span className="text-sm font-medium">{t('altLabel')}</span>
      <input name="alt" className={`${inputCls} w-full`} value={alt} onChange={event => setAlt(event.target.value)} required={type !== 'none'} disabled={type === 'none'} maxLength={240}/>
    </label>
    {type === 'none' && <><input type="hidden" name="mediaUrl" value=""/><input type="hidden" name="alt" value=""/></>}
    <div className="space-y-3 border-t border-border pt-6">
      <label className="block space-y-2"><span className="text-sm font-medium">{t('iconUrl')}</span>
        <input name="iconUrl" type="url" defaultValue={presentation.iconUrl} maxLength={2048} placeholder="https://…" aria-describedby="login-icon-help" className={`${inputCls} w-full`}/>
      </label>
      <p id="login-icon-help" className="text-sm leading-relaxed text-muted-foreground">{t('iconHelp')}</p>
    </div>
    <div className="flex flex-wrap items-center gap-4">
      <button type="submit" disabled={pending} className={btnPrimary}>{t(pending ? 'saving' : 'save')}</button>
      {state.status !== 'idle' && <p role={state.status === 'saved' ? 'status' : 'alert'} className={`text-sm ${state.status === 'saved' ? 'text-foreground' : 'text-destructive'}`}>{t(`result.${state.status}`)}</p>}
    </div>
  </form>;
}
