'use client';
import {useMemo,type ReactNode} from 'react';
import {NextIntlClientProvider,useMessages,useLocale} from 'next-intl';
import {mergeClientMessages,type ClientMessages} from '@/lib/client-message-tree';
/** Inherit the persistent shell messages without serializing them again on each route. */
export function RouteMessageProvider({messages,children}:{messages:ClientMessages;children:ReactNode}){
 const inherited=useMessages(),locale=useLocale();
 const combined=useMemo(()=>mergeClientMessages(inherited,messages),[inherited,messages]);
 return <NextIntlClientProvider locale={locale} messages={combined}>{children}</NextIntlClientProvider>;
}
