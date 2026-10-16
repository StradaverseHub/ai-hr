'use client';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {useUiTheme} from './ui-theme-context';
/** Ordinary routes stay available. Existing document-click guards preserve dirty forms. */
export function AssistantReturnLink(){
 const theme=useUiTheme(),pathname=usePathname(),t=useTranslations('components.uiTheme');
 if(theme!=='ai-responsive'||pathname==='/assistant')return null;
 return <div className="px-2"><Link href="/assistant" className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2">{t('returnConversation')}</Link></div>;
}
