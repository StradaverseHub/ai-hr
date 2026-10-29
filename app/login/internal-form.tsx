'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { activationLoginHref } from '@/lib/internal-auth/login-navigation';
import { Eye, EyeOff } from 'lucide-react';
import { LoginShell } from './login-shell';
import type { LoginPresentation } from '@/lib/login-presentation';
import { useTranslations,useLocale } from 'next-intl';

type Reply = { step: string; organization?: string; challenge?: string; secret?: string; qr?: string; account?: string; recoveryCodes?: string[]; error?: string };
export function InternalAuthForm({ organization = '', returnTo = '/', mode = 'login', invitation = '', presentation }: {
  presentation?: LoginPresentation; organization?: string; returnTo?: string; mode?: 'login' | 'recovery' | 'invite' | 'accept'; invitation?: string;
}) {
  const t = useTranslations('internalAuth'),locale=useLocale();
  const router = useRouter();
  const copy = useTranslations('loginPresentation');
  const passwordId = useId();
  const [showPassword, setShowPassword] = useState(false);
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
          ...Object.fromEntries(data.entries()),...(operation==='recovery'?{locale}:{}), ...(state.challenge ? { challenge: state.challenge } : {}),
          ...(resetToken ? { token: resetToken } : {}), ...(invitation ? { token: invitation } : {}),
        }) });
      const reply: Reply = await response.json();
      if (!response.ok) { setError(reply.error || 'unavailable'); return; }
      form.reset(); setShowPassword(false);
      // 8e830f17 — a finished sign-in or activation has nothing left to submit. Rendering the reply itself fell
      // through to the generic form ("Sign in" + Continue → /login/api/complete, which does not exist) while the
      // next page loaded, so the terminal steps show a status with no form instead.
      const terminal = (reply.step === 'complete' || reply.step === 'activated') && !reply.recoveryCodes?.length;
      setState(terminal ? { step: 'signing-in' } : reply);
      if (reply.step === 'activated' && !reply.recoveryCodes?.length) router.replace(activationLoginHref(reply.organization));
      if (reply.step === 'complete' && !reply.recoveryCodes?.length) window.location.assign(returnTo);
    } catch { setError('unavailable'); } finally { setBusy(false); }
  }
  const field = 'h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const button = 'login-submit';
  const errors = ['invalidLogin', 'invalidChallenge', 'invalidCode', 'passwordPolicy', 'passwordMismatch', 'rateLimited', 'unavailable', 'conflict', 'forbidden'];
  const title = state.step === 'signing-in' ? 'signingInTitle' : ['complete', 'activated'].includes(state.step) && state.recoveryCodes ? 'codesTitle' : `${['login','recovery','invite','accept','password','enroll','mfa','sent','reset','resetDone'].includes(state.step) ? state.step : 'login'}Title`;
  return <LoginShell presentation={presentation}>
    <section aria-labelledby="internal-auth-title" className="space-y-8">
      <header className="space-y-3">
        <h1 id="internal-auth-title">{state.step === 'login' ? copy('welcome') : t(title)}</h1>
        {state.step === 'login' && <p>{copy('signInSubtitle')}</p>}
      </header>
      {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{t(`errors.${errors.includes(error) ? error : 'unavailable'}`)}</p>}
      {state.step === 'signing-in' ? <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{t('signingInHelp')}</p>
      : state.step === 'resetDone' ? <div className="space-y-4"><p role="status" className="text-sm">{t('resetDoneHelp')}</p><a href="/login" className="text-sm underline">{t('back')}</a></div> : state.step === 'sent' ? <div className="space-y-4"><p role="status" className="text-sm leading-relaxed">{t('sentHelp')}</p><a className="text-sm underline" href="/login">{t('back')}</a></div>
      : state.step === 'reset' && !resetToken ? <a href="/login" className="text-sm underline">{t('back')}</a>
      : ['complete', 'activated'].includes(state.step) && state.recoveryCodes?.length ? <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted-foreground">{t('codesHelp')}</p>
        <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs leading-7" aria-label={t('codesTitle')}>{state.recoveryCodes.join('\n')}</pre>
        <button type="button" className="text-sm underline" onClick={() => {
          const file = new Blob([`AI HR recovery codes\n${state.recoveryCodes!.join('\n')}\n`], { type: 'text/plain' });
          const url = URL.createObjectURL(file), link = document.createElement('a'); link.href = url; link.download = 'aihr-recovery-codes.txt'; link.click(); URL.revokeObjectURL(url);
        }}>{t('download')}</button>
        <form method="post" onSubmit={event => { event.preventDefault();
          if (state.step === 'activated') router.replace(activationLoginHref(state.organization));
          else window.location.assign(returnTo); }} className="space-y-4">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" required className="mt-1"/>{t('codesSaved')}</label>
          <button className={button}>{t(state.step === 'activated' ? 'signIn' : 'continue')}</button>
        </form>
      </div> : <form method="post" onSubmit={submit} className="space-y-4">
        {['login','recovery'].includes(state.step) && <>
          <label className="block space-y-1.5"><span className="text-sm font-medium">{t('organization')}</span><input className={field} name="organization" required defaultValue={organization} maxLength={64} autoCapitalize="none" spellCheck={false} autoComplete="organization"/></label>
          <label className="block space-y-1.5"><span className="text-sm font-medium">{t('username')}</span><input className={field} name="username" required maxLength={64} autoCapitalize="none" spellCheck={false} autoComplete="username"/></label>
        </>}
        {state.step === 'invite' && <label className="block space-y-1.5"><span className="text-sm font-medium">{t('username')}</span><input name="username" required minLength={3} maxLength={64} autoComplete="username" autoCapitalize="none" spellCheck={false} className={field}/></label>}
        {['login','password','reset','invite'].includes(state.step) && <div className="space-y-1.5"><label htmlFor={passwordId} className="block text-sm font-medium">{t(state.step === 'login' ? 'password' : 'newPassword')}</label><div className="login-password"><input id={passwordId} className={field} name="password" type={showPassword ? 'text' : 'password'} required minLength={state.step === 'login' ? 1 : 14} maxLength={128} autoComplete={state.step === 'login' ? 'current-password' : 'new-password'}/><button type="button" className="login-password-toggle" aria-label={copy(showPassword ? 'hidePassword' : 'showPassword')} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={20}/> : <Eye size={20}/>}</button></div></div>}
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
        {state.step === 'login' && <a href="/reset-password" className="block text-sm font-medium underline">{t('forgot')}</a>}
        {state.step === 'invite' && <a href={`/login?returnTo=${encodeURIComponent(`/invite/${invitation}/activate`)}`} className="block text-center text-sm underline">{t('existingLogin')}</a>}
        {!['login','invite','accept'].includes(state.step) && <a href="/login" className="block text-center text-sm underline">{t('back')}</a>}
      </form>}
      {state.step === 'login' && <div className="login-help">
        <details><summary>{copy('firstTime')}</summary><p className="mt-2">{copy('firstTimeHelp')}</p></details>
        <details><summary>{copy('getHelp')}</summary><p className="mt-2">{copy('getHelpBody')}</p></details>
      </div>}
    </section>
  </LoginShell>;
}
