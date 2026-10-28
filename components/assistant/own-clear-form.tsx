'use client';
import {useTranslations} from 'next-intl';
import {ConfirmSubmit} from '../ui/confirm-submit';
import type {OwnClearKind} from './own-clear-kinds';
/** A client component so it renders inside any parent, server or client, without an async boundary.
 * Nothing is posted but the click; the confirm dialog names exactly what goes and what stays. */
export function OwnClearForm({kind,action,label,className='min-h-11 text-xs underline'}:{kind:OwnClearKind;action:()=>Promise<void>;label:string;className?:string}){
 const t=useTranslations('assistant.workspace.ownClear');
 return <form action={action}><ConfirmSubmit variant="link" confirmVariant="destructive" title={t(`${kind}.title`)} description={t(`${kind}.body`)} confirmLabel={t(`${kind}.confirm`)} cancelLabel={t('keep')} className={`h-auto px-0 py-2 text-foreground underline ${className}`}>{label}</ConfirmSubmit></form>;
}
