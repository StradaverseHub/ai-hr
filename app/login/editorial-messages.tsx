'use client';

import type { ReactNode } from 'react';
import { NextIntlClientProvider, useLocale, useMessages } from 'next-intl';
import en from '@/messages/login-editorial/en.json';
import ms from '@/messages/login-editorial/ms.json';
import zh from '@/messages/login-editorial/zh.json';
import ta from '@/messages/login-editorial/ta.json';
import th from '@/messages/login-editorial/th.json';
import vi from '@/messages/login-editorial/vi.json';

const copy = { en, ms, zh, ta, th, vi };

// Presentation-only vocabulary belongs to this entrance, outside shared AI data catalogs.
export function LoginEditorialMessages({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const messages = useMessages();
  if (messages.loginEditorial) return children;
  const loginEditorial = copy[locale as keyof typeof copy] ?? en;
  return <NextIntlClientProvider locale={locale} messages={{ ...messages, loginEditorial }}>{children}</NextIntlClientProvider>;
}
