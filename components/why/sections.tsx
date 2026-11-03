import {getLocale,getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {mayUseAssistant} from '@/core/assistant-grant';
import {explainPayslipDeduction,type PayslipDeductionWhy,type PayslipFigureRow} from '@/core/pay-difference';
import type {LeaveBalanceExplanation} from '@/core/leave-balance-explain';
import {claimLimitExplanation} from '@/core/claim-limit-explain';
import type {ClaimBalanceRow} from '@/core/claims';
import {FocusOnMount} from '@/components/ai-centre/focus-on-mount';
import {WhyPanel,type WhyPanelView} from './why-panel';
import {claimLimitView,deductionView,leaveBalanceView,payDifferenceView,type Translate} from './views';

/** AI v2 W5 — the "Why?" panels as the pages draw them, each rendered only once the person asked (`why=…`).
 *
 * Each reads its owner as the viewer, own records only (core/explainers/own-why.ts), or is handed the owner's figures
 * the page already holds (the open payslip, the claim form's balance, the leave dashboard's card), and formats them
 * (./views.ts). "Ask AI Centre about this" is offered only to someone the Assistant can answer, by the same gate AI
 * Centre Ask uses. A read that fails shows one quiet line in place of the panel, never a guessed figure. */

type Common=Readonly<{session:SessionContext;id:string;closeHref:string}>;

async function translators(){
 const [t,tp,locale]=await Promise.all([getTranslations('why'),getTranslations('me.payslip'),getLocale()]);
 return {t:t as unknown as Translate,tp:tp as unknown as Translate,locale};
}
async function askLabels(session:SessionContext,t:Translate){
 const access=await mayUseAssistant(session).catch(()=>({allowed:false as const}));
 return access.allowed?{label:t('ask'),openingLabel:t('opening')}:null;
}
async function draw(p:Common,t:Translate,view:WhyPanelView|null){
 if(!view)return <p id={p.id} tabIndex={-1} role="status" data-why-unavailable className="mt-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">{t('unavailable')}</p>;
 return <><WhyPanel id={p.id} view={view} ask={await askLabels(p.session,t)} closeHref={p.closeHref} closeLabel={t('close')}/><FocusOnMount targetId={p.id}/></>;
}
const settle=async<T,>(read:()=>Promise<T>):Promise<T|null>=>{try{return await read();}catch{return null;}};

/** The open payslip's month against the person's previous released month at the same company. */
export async function PayDifferenceWhy(p:Common&Readonly<{companyId:string;period:string;currency:string|null}>){
 const {t,tp,locale}=await translators();
 // Loaded only when the panel is asked for, so a page that never opens it never loads the payslip readers.
 const result=await settle(async()=>(await import('@/core/explainers/own-why')).ownPayDifference(p.session,{companyId:p.companyId,period:p.period}));
 return draw(p,t,result?payDifferenceView(result,{locale,currency:p.currency},t,tp):null);
}

/** Today's At a glance payslip row (AI v2 slice 3 follow-up): the same pay-difference panel as the payslip screen, for
 * the payslip the row names. The company, month and currency are read from that payslip's own detail as the viewer
 * (the payslip screen's own-only read), only once the panel is asked for; a payslip the person cannot open shows the
 * quiet unavailable line. */
export async function PayslipPayDifferenceWhy(p:Common&Readonly<{payslipId:string}>){
 const detail=await settle(async()=>(await import('@/packs/payroll/service')).myPayslipDetail(p.session,p.payslipId));
 if(!detail){const {t}=await translators();return draw(p,t,null);}
 return PayDifferenceWhy({...p,companyId:detail.companyId,period:detail.payPeriod,currency:detail.currency??null});
}

/** One deduction line of the open payslip, from that payslip's own recorded working. */
export async function DeductionWhy(p:Common&Readonly<{row:PayslipFigureRow&Readonly<{runType:string}>;item:PayslipDeductionWhy;period:string;currency:string|null}>){
 const {t,tp,locale}=await translators();
 const explanation=explainPayslipDeduction(p.row,p.item);
 return draw(p,t,explanation?deductionView(p.item,explanation,p.period,{locale,currency:p.currency},t,tp):null);
}

/** One own leave type: from the card the page already holds, or read as the viewer (Today). */
export async function LeaveBalanceWhy(p:Common&Readonly<{explanation?:LeaveBalanceExplanation|null;leaveTypeId:string;employmentId?:string}>){
 const {t,locale}=await translators();
 const explanation=p.explanation!==undefined?p.explanation
  :await settle(async()=>(await import('@/core/explainers/own-why')).ownLeaveBalanceWhy(p.session,{leaveTypeId:p.leaveTypeId,employmentId:p.employmentId,locale}));
 return draw(p,t,explanation?leaveBalanceView(explanation,{locale,currency:null},t):null);
}

/** One own claim type, from the balance the claims page already read from the claims owner. The amounts are labelled
 * with the employing company's own currency (lib/money.ts: never a defaulted "RM"). */
export async function ClaimLimitWhy(p:Common&Readonly<{balance:ClaimBalanceRow|null;employmentId:string}>){
 const {t,locale}=await translators();
 const currency=await settle(async()=>(await import('@/core/mobile-claims')).currencyOfEmployment(p.session,p.employmentId));
 return draw(p,t,p.balance?claimLimitView(claimLimitExplanation(p.balance),{locale,currency},t):null);
}
