/** Client-safe closed vocabulary for provider-settings failures. A view holds only names from these lists;
 * the browser re-validates it and selects fixed admin.ai.failure copy. No server text crosses this boundary. */
export const PROVIDER_FAILURE_REASONS=Object.freeze(['consent_required','candidate_required','receipt_required','unavailable',
 'not_admin','secret_unavailable','evaluate_first','key_required','config_invalid','activation_unavailable','connection_failed',
 'paused','daily_limit','monthly_limit','concurrent_limit','spend_control','spend_capability','spend_root',
 'privacy_review','privacy_source','configuration_changed','controls','admission','database','unexpected'] as const);
export type ProviderFailureReason=typeof PROVIDER_FAILURE_REASONS[number];
export const PROVIDER_FAILURE_STAGES=Object.freeze(['draft','tool_call','tool_result','summary'] as const);
export type ProviderFailureStage=typeof PROVIDER_FAILURE_STAGES[number];
export const PROVIDER_FAILURE_ORIGINS=Object.freeze(['local','provider','response'] as const);
export type ProviderFailureOrigin=typeof PROVIDER_FAILURE_ORIGINS[number];
/** `probe` is true when one of the three evaluation calls failed (stage/origin then name which and how far). */
export type ProviderFailureView=Readonly<{reason:ProviderFailureReason;probe:boolean;stage:ProviderFailureStage|null;origin:ProviderFailureOrigin|null}>;
export type ProviderFailureFallback='commandFailed'|'testFail'|'evaluationFailed';

const pick=<T extends string>(list:readonly T[],value:unknown):T|null=>typeof value==='string'&&(list as readonly string[]).includes(value)?value as T:null;
/** Accepts only the closed shape; anything else is no view (the caller shows its generic copy). */
export function readProviderFailureView(value:unknown):ProviderFailureView|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const record=value as Record<string,unknown>,reason=pick(PROVIDER_FAILURE_REASONS,record.reason);
 if(!reason||typeof record.probe!=='boolean')return null;
 return Object.freeze({reason,probe:record.probe,stage:pick(PROVIDER_FAILURE_STAGES,record.stage),origin:pick(PROVIDER_FAILURE_ORIGINS,record.origin)});
}

/** Fixed translated copy. `t` is the admin.ai translator; `fallback` is the command's existing generic key,
 * used only when nothing more specific is known. */
export function providerFailureMessage(t:(key:string,values?:Record<string,string>)=>string,view:ProviderFailureView,fallback:ProviderFailureFallback):string{
 const reason=()=>t(view.reason==='unexpected'?fallback:`failure.${view.reason}`);
 if(!view.probe)return reason();
 if(view.stage===null||view.stage==='summary'||view.origin===null)return t('failure.probe_summary');
 const call=t(`failure.call_${view.stage}`);
 if(view.origin==='provider')return t('failure.probe_provider',{call});
 if(view.origin==='response')return t('failure.probe_response',{call});
 return t('failure.probe_local',{call,reason:reason()});
}
