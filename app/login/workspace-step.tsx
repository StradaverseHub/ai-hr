'use client';
import { useEffect, useId, useRef, type FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** Choosing an organization is presentation, not authentication or an organization lookup. */
export function LoginWorkspaceStep({ organization, onChange, onContinue, focusOnMount = false }: {
  organization: string; onChange: (value: string) => void; onContinue: () => void; focusOnMount?: boolean;
}) {
  const t = useTranslations('loginEditorial');
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusOnMount) input.current?.focus({ preventScroll: true }); }, [focusOnMount]);
  function next(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organization.trim()) return;
    onChange(organization.trim()); onContinue();
  }
  return <section className="login-workspace-step" aria-labelledby={`${id}-title`}>
    <h1 id={`${id}-title`} className="login-editorial-title"><span>{t('headlineOne')}</span><span>{t('headlineTwo')}</span></h1>
    <p className="login-editorial-intro">{t('intro')}</p>
    <form method="post" onSubmit={next} className="login-workspace-form">
      <label htmlFor={id}>{t('workspaceLabel')}</label>
      <div className="login-workspace-entry">
        <input ref={input} id={id} name="organization" required maxLength={64} value={organization} onChange={event => onChange(event.target.value)}
          autoComplete="organization" autoCapitalize="none" spellCheck={false} placeholder={t('workspacePlaceholder')} aria-describedby={`${id}-help`} />
        <button type="submit" disabled={!organization.trim()} aria-label={t('continueLabel')}><ArrowRight aria-hidden size={23}/></button>
      </div>
      <p id={`${id}-help`} className="login-workspace-note">{t('workspaceNote')}</p>
    </form>
    <p className="login-next-step">{t('nextStep')}</p>
  </section>;
}
