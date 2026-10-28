import {getTranslations} from 'next-intl/server';
import {ConfirmSubmit} from '../ui/confirm-submit';
/** The owner's own "erase my…" controls on /assistant. Each is irreversible, so each asks first through the
 * shared confirm dialog; nothing is posted but the click. The outcome is a separate status rendered OUTSIDE
 * any collapsible, so the post-redirect page shows that it worked (or that nothing was removed). */
export const OWN_CLEAR_KINDS=['proposals','ratings','feedback','conversation','importHistory','outcomes'] as const;
export type OwnClearKind=(typeof OWN_CLEAR_KINDS)[number];
/** `ownClear` query values the four redirect-only actions use. Import history and outcome links keep
 * their existing `importHistory` / `nativeOutcome` statuses. */
const STATUS_KINDS:ReadonlySet<string>=new Set(['proposals','ratings','feedback','conversation']);
export async function OwnClearForm({kind,action,label,className='min-h-11 text-xs underline'}:{kind:OwnClearKind;action:()=>Promise<void>;label:string;className?:string}){
 const t=await getTranslations('assistant.workspace.ownClear');
 return <form action={action}><ConfirmSubmit variant="link" confirmVariant="destructive" title={t(`${kind}.title`)} description={t(`${kind}.body`)} confirmLabel={t(`${kind}.confirm`)} cancelLabel={t('keep')} className={`h-auto px-0 py-2 text-foreground underline ${className}`}>{label}</ConfirmSubmit></form>;
}
export async function OwnClearStatus({status}:{status?:string}){
 if(status===undefined)return null;
 const t=await getTranslations('assistant.workspace.ownClear');
 if(status==='unavailable')return <p role="alert" className="text-xs">{t('unavailable')}</p>;
 return STATUS_KINDS.has(status)?<p role="status" className="text-xs">{t(`${status}.done`)}</p>:null;
}
