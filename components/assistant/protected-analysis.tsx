import {getTranslations} from 'next-intl/server';
import {ProtectedAnalysisPanel,type ProtectedAnalysisLabels} from './protected-analysis-panel';
/** Native company scope is supplied by the server; the action re-derives and reauthorizes it. */
export async function ProtectedAnalysis({scopeIds}:{scopeIds:readonly string[]}){
 const t=await getTranslations('assistant.privateAnalysis');
 const domains=['workforce','attendance','leave','payroll','claims','performance','rewards','organisation'] as const;
 const notices=['invalid_request','privacy_unavailable','unavailable','temporarily_unavailable','failed'] as const;
 const labels={...Object.fromEntries(['title','description','companyScope','domain','month','compareWindow','snapshotWindow','run','thinking','result'].map(key=>[key,t(key)])),domains:Object.fromEntries(domains.map(key=>[key,t(`domains.${key}`)])),notices:Object.fromEntries(notices.map(key=>[key,t(`notices.${key}`)]))} as ProtectedAnalysisLabels;
 return <ProtectedAnalysisPanel labels={labels} scopeKey={JSON.stringify([...scopeIds].sort())}/>;
}
