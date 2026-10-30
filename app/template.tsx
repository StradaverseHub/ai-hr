import {headers} from 'next/headers';
import {getMessages} from 'next-intl/server';
import type {ReactNode} from 'react';
import {RouteMessageProvider} from '@/components/route-message-provider';
import {routeClientMessages} from '@/i18n/client-messages';
/** The first route segment owns this template's navigation key. Include its complete subtree's
 * client requirements so deeper navigation and query changes retain every required message. */
export default async function Template({children}:{children:ReactNode}){
 const [messages,requestHeaders]=await Promise.all([getMessages(),headers()]);
 return <RouteMessageProvider messages={routeClientMessages(messages,requestHeaders.get('x-pathname')??'')}>{children}</RouteMessageProvider>;
}
