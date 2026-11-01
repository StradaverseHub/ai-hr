import 'server-only';
import {getMessages} from 'next-intl/server';
import type {ReactNode} from 'react';
import {RouteMessageProvider} from './route-message-provider';
import {routeClientMessages} from '@/i18n/client-messages';
/** A fixed route segment owns these public strings, including its complete subtree. Unlike a
 * root template reading headers, its server props arrive when entering that route's layout. */
export async function RouteMessages({segment,children}:{segment:string;children:ReactNode}){
 return <RouteMessageProvider messages={routeClientMessages(await getMessages(),'/'+segment)}>{children}</RouteMessageProvider>;
}
export function routeMessageLayout(segment:string,Layout?:(props:{children:ReactNode})=>ReactNode|Promise<ReactNode>){
 return async function MessageLayout({children}:{children:ReactNode}){
  const content=Layout?await Layout({children}):children;
  return RouteMessages({segment,children:content});
 };
}
