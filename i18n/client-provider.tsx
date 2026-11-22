'use client';

import {use,type ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import {usePathname} from 'next/navigation';
import {defaultLocale,isLocale} from './config';
import {messagesForClient,type ClientCatalogueScope} from '@/i18n/client-catalogue';

/** Public build-static copy travels in cached assets, rather than every personalized RSC response.
 * Only catalogues are cached: the request's locale and all HR data remain independently resolved. */
export function CatalogClientProvider({locale,children,signedIn=false}:{locale:string;children:ReactNode;signedIn?:boolean}){
 const selected=isLocale(locale)?locale:defaultLocale;
 const pathname=usePathname();
 let scope:ClientCatalogueScope='full';
 if(pathname==='/me/tp3')scope='tp3';
 if(signedIn&&pathname==='/')scope='home';
 if(signedIn&&pathname==='/approvals')scope='approvals';
 const messages=use(messagesForClient(selected,scope));
 return <NextIntlClientProvider locale={selected} messages={messages}>{children}</NextIntlClientProvider>;
}
