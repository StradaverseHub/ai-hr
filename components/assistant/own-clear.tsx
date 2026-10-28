import {getTranslations} from 'next-intl/server';
/** The owner's own "erase my…" controls on /assistant. Each is irreversible, so each asks first through the
 * shared confirm dialog (OwnClearForm). The outcome is a separate status rendered OUTSIDE any collapsible,
 * so the post-redirect page shows that it worked (or that nothing was removed). */
export {OWN_CLEAR_KINDS,type OwnClearKind} from './own-clear-kinds';
export {OwnClearForm} from './own-clear-form';
/** `ownClear` query values the four redirect-only actions use. Import history and outcome links keep
 * their existing `importHistory` / `nativeOutcome` statuses. */
const STATUS_KINDS:ReadonlySet<string>=new Set(['proposals','ratings','feedback','conversation']);
export async function OwnClearStatus({status}:{status?:string}){
 if(status===undefined)return null;
 const t=await getTranslations('assistant.workspace.ownClear');
 if(status==='unavailable')return <p role="alert" className="text-xs">{t('unavailable')}</p>;
 return STATUS_KINDS.has(status)?<p role="status" className="text-xs">{t(`${status}.done`)}</p>:null;
}
