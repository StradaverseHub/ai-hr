import {getTranslations} from 'next-intl/server';
import {notFound} from 'next/navigation';
import {requireAdmin} from '@/lib/authz';
import {getFormulaEvaluation} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import {FormulaTraceView,type FormulaTraceViewData} from '../trace-view';
export default async function FormulaEvaluationPage({params}:{params:Promise<{id:string}>}){
 const ctx=await requireAdmin(),{id}=await params,evaluation=await getFormulaEvaluation(ctx,id);if(!evaluation)notFound();
 const t=await getTranslations('payFormula');
 // Explicit projection: internal source snapshots, employment identity and context stay on the server.
 const detail:FormulaTraceViewData={formulaId:evaluation.formulaId,revisionId:evaluation.revisionId,ordinal:evaluation.ordinal,contentHash:evaluation.contentHash,period:evaluation.period,componentCode:evaluation.componentCode,amount:evaluation.amount,createdAt:evaluation.createdAt,explanations:evaluation.payload.explanations,reads:evaluation.payload.reads};
 return <div className={pageWideCls+' space-y-6'}><PageHeader title={t('traceTitle')} description={t('traceSubtitle')} back={{href:'/payroll/formula-builder',label:t('title')}}/><FormulaTraceView evaluation={detail}/></div>;
}
