'use client';
import { useEffect, useState, type FormEvent } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';

type Reply = { step: string; challenge?: string; secret?: string; qr?: string; account?: string; recoveryCodes?: string[]; error?: string };
export function InternalAuthForm({ organization = '', returnTo = '/', mode = 'login', invitation = '' }: {
  organization?: string; returnTo?: string; mode?: 'login' | 'recovery' | 'invite' | 'accept'; invitation?: string;
}) {
  const t = useTranslations('internalAuth');
  const [state, setState] = useState<Reply>({ step: mode });
  const [resetToken, setResetToken] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (mode !== 'recovery') return;
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (token) {
      window.history.replaceState(null, '', '/reset-password');
      if (/^[A-Za-z0-9_-]{43}$/.test(token)) { setResetToken(token); setState({ step: 'reset' }); }
      else setError('invalidChallenge');
    }
  }, [mode]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget, data = new FormData(form);
    if (state.step === 'password' || state.step === 'reset' || state.step === 'invite') {
      if (data.get('password') !== data.get('confirmation')) { setError('passwordMismatch'); return; }
    }
    setBusy(true); setError('');
    try {
      const operation = state.step === 'enroll' || state.step === 'mfa' ? 'mfa' : state.step === 'accept' ? 'accept-invite' : state.step;
      const response = await fetch(`/login/api/${operation}`, { method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          ...Object.fromEntries(data.entries()), ...(state.challenge ? { challenge: state.challenge } : {}),
          ...(resetToken ? { token: resetToken } : {}), ...(invitation ? { token: invitation } : {}),
        }) });
      const reply: Reply = await response.json();
      if (!response.ok) { setError(reply.error || 'unavailable'); return; }
      form.reset(); setState(reply);
      if (reply.step === 'complete' && !reply.recoveryCodes?.length) window.location.assign(returnTo);
    } catch { setError('unavailable'); } finally { setBusy(false); }
  }
  const field = 'h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const button = 'min-h-11 w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50';
  const errors = ['invalidLogin', 'invalidChallenge', 'invalidCode', 'passwordPolicy', 'passwordMismatch', 'rateLimited', 'unavailable', 'conflict', 'forbidden'];
  const title = state.step === 'complete' && state.recoveryCodes ? 'codesTitle' : `${['login','recovery','invite','accept','password','enroll','mfa','sent','reset','resetDone'].includes(state.step) ? state.step : 'login'}Title`;
  return <main className="flex min-h-dvh items-center justify-center bg-muted/30 px-5 py-10">
    <section aria-labelledby="internal-auth-title" className="w-full max-w-md space-y-6 rounded-2xl border border-border bg-background p-6 shadow-sm sm:p-8">
      <header className="space-y-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">AI HR</p>
        <h1 id="internal-auth-title" className="text-2xl font-semibold tracking-tight">{t(title)}</h1>
        {state.step === 'login' && <p className="text-sm leading-relaxed text-muted-foreground">{t('loginHelp')}</p>}
      </header>
      {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{t(`errors.${errors.includes(error) ? error : 'unavailable'}`)}</p>}
      {state.step === 'resetDone' ? <div className="space-y-4"><p role="status" className="text-sm">{t('resetDoneHelp')}</p><a href="/login" className="text-sm underline">{t('back')}</a></div> : state.step === 'sent' ? <div className="space-y-4"><p role="status" className="text-sm leading-relaxed">{t('sentHelp')}</p><a className="text-sm underline" href="/login">{t('back')}</a></div>
      : state.step === 'reset' && !resetToken ? <a href="/login" className="text-sm underline">{t('back')}</a>
      : state.step === 'complete' && state.recoveryCodes?.length ? <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted-foreground">{t('codesHelp')}</p>
        <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs leading-7" aria-label={t('codesTitle')}>{state.recoveryCodes.join('\n')}</pre>
        <button type="button" className="text-sm underline" onClick={() => {
          const file = new Blob([`AI HR recovery codes\n${state.recoveryCodes!.join('\n')}\n`], { type: 'text/plain' });
          const url = URL.createObjectURL(file), link = document.createElement('a'); link.href = url; link.download = 'aihr-recovery-codes.txt'; link.click(); URL.revokeObjectURL(url);
        }}>{t('download')}</button>
        <form onSubmit={event => { event.preventDefault(); window.location.assign(returnTo); }} className="space-y-4">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" required className="mt-1"/>{t('codesSaved')}</label>
          <button className={button}>{t('continue')}</button>
        </form>
      </div> : <form onSubmit={submit} className="space-y-4">
        {['login','recovery'].includes(state.step) && <>
          <label className="block space-y-1.5"><span className="text-sm font-medium">{t('organization')}</span><input className={field} name="organization" required defaultValue={organization} maxLength={64} autoCapitalize="none" spellCheck={false} autoComplete="organization"/></label>
          <label className="block space-y-1.5"><span className="text-sm font-medium">{t('username')}</span><input className={field} name="username" required maxLength={64} autoCapitalize="none" spellCheck={false} autoComplete="username"/></label>
        </>}
        {state.step === 'invite' && <label className="block space-y-1.5"><span className="text-sm font-medium">{t('username')}</span><input name="username" required minLength={3} maxLength={64} autoComplete="username" autoCapitalize="none" spellCheck={false} className={field}/></label>}
        {['login','password','reset','invite'].includes(state.step) && <label className="block space-y-1.5"><span className="text-sm font-medium">{t(state.step === 'login' ? 'password' : 'newPassword')}</span><input className={field} name="password" type="password" required minLength={state.step === 'login' ? 1 : 14} maxLength={128} autoComplete={state.step === 'login' ? 'current-password' : 'new-password'}/></label>}
        {['password','reset','invite'].includes(state.step) && <>
          <p className="text-xs leading-relaxed text-muted-foreground">{t('passwordHelp')}</p>
          <label className="block space-y-1.5"><span className="text-sm font-medium">{t('confirmation')}</span><input className={field} name="confirmation" type="password" required minLength={14} maxLength={128} autoComplete="new-password"/></label>
        </>}
        {state.step === 'enroll' && <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">{t('enrollHelp')}</p>
          {state.qr && <Image src={state.qr} alt={t('qrAlt')} width={224} height={224} unoptimized className="mx-auto rounded-lg bg-white"/>}
          <p className="text-xs font-medium text-muted-foreground">{t('manualKey')}</p><code className="block break-all rounded-lg bg-muted p-3 text-sm">{state.secret}</code>
        </div>}
        {['enroll','mfa','reset'].includes(state.step) && <label className="block space-y-1.5"><span className="text-sm font-medium">{t(state.step === 'enroll' ? 'code' : 'codeOrRecovery')}</span><input className={field} name="code" required={state.step !== 'reset'} maxLength={64} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false}/>{state.step === 'reset' && <span className="block text-xs text-muted-foreground">{t('resetMfaHelp')}</span>}</label>}
        {state.step === 'accept' && <p className="text-sm leading-relaxed">{t('acceptHelp')}</p>}
        <button type="submit" disabled={busy} className={button}>{busy ? t('working') : t(state.step === 'login' ? 'signIn' : state.step === 'recovery' ? 'sendLink' : state.step === 'reset' ? 'resetSubmit' : 'continue')}</button>
        {state.step === 'login' && <a href="/reset-password" className="block text-center text-sm underline">{t('forgot')}</a>}
        {state.step === 'invite' && <a href={`/login?returnTo=${encodeURIComponent(`/invite/${invitation}/activate`)}`} className="block text-center text-sm underline">{t('existingLogin')}</a>}
        {!['login','invite','accept'].includes(state.step) && <a href="/login" className="block text-center text-sm underline">{t('back')}</a>}
      </form>}
    </section>
  </main>;
}
