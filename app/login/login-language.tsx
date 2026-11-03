'use client';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { setLocale } from '@/app/i18n-actions';
import { locales, localeNames } from '@/i18n/config';

export function LoginLanguage() {
  const locale = useLocale(), t = useTranslations('loginEditorial');
  return <form action={setLocale} className="login-language">
    <select aria-label={t('language')} name="locale" value={locale} onChange={event => event.currentTarget.form?.requestSubmit()}>
      {locales.map(value => <option key={value} value={value}>{localeNames[value]}</option>)}
    </select><ChevronDown aria-hidden size={12}/>
  </form>;
}
