'use client';

import {use,type ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import {defaultLocale,isLocale} from './config';
import {messagesForLocale} from './catalogs';

/** Public build-static copy travels in cached assets, rather than every personalized RSC response.
 * Only catalogues are cached: the request's locale and all HR data remain independently resolved. */
export function CatalogClientProvider({locale,children}:{locale:string;children:ReactNode}){
 const selected=isLocale(locale)?locale:defaultLocale;
 const messages=use(messagesForLocale(selected));
 return <NextIntlClientProvider locale={selected} messages={messages}>{children}</NextIntlClientProvider>;
}
