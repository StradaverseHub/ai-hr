'use client';

import {use,type ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import {usePathname} from 'next/navigation';
import {defaultLocale,isLocale} from './config';
import {messagesForClient} from '@/i18n/client-catalogue';

/** Public build-static copy travels in cached assets, rather than every personalized RSC response.
 * Only catalogues are cached: the request's locale and all HR data remain independently resolved. */
export function CatalogClientProvider({locale,children}:{locale:string;children:ReactNode}){
 const selected=isLocale(locale)?locale:defaultLocale;
 const scope=usePathname()==='/me/tp3'?'tp3':'full';
 const messages=use(messagesForClient(selected,scope));
 return <NextIntlClientProvider locale={selected} messages={messages}>{children}</NextIntlClientProvider>;
}
