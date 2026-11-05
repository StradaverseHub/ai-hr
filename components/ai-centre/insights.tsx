import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {PageHeader} from '@/components/ui';
import {CapacityLedgerSection,type CapacityQuery} from '@/components/ai-centre/capacity-ledger';
import {AiQualitySection,type QualityQuery} from '@/components/ai-centre/ai-quality';
import {CheckAccuracySection} from '@/components/ai-centre/check-accuracy';

/** AI v2 Phase 2 — AI Centre › Insights, a view of /assistant, for HR and group administrators only (owner decision 27,
 * 4 November 2026). Its two sections:
 *
 * HR capacity (P2-4): the capacity ledger, and since the AI Centre restructure the measured part of the former
 * Opportunities page, with the stored baseline as its only minutes input (#hr-capacity). core/capacity/ledger.ts checks
 * the administrator again under the viewer's own row-level security.
 *
 * AI quality (P2-6): core/learning/quality.ts checks again under the viewer's row-level security; its query parameters are
 * its own (qperiod, qcompany and the result codes), so its filter and the ledger's do not move each other. The former
 * Operations overview's agreement table and payroll-check figures are part of it (./check-accuracy.tsx), and its threshold
 * proposals are read-only, linking to payroll-cycle Settings, the one place to decide them.
 *
 * A person's own "My payroll readiness" is no longer here: it is its own page, /me/payroll-readiness (decision 27), and a
 * non-administrator who opens this view is forwarded there (app/assistant/page.tsx). This view grants nothing, and renders
 * nothing for anyone who is not an administrator, so none of its reads run for them. */
export async function AiCentreInsights({session,isAdmin,payroll,capacityQuery,qualityQuery}:{session:SessionContext;isAdmin:boolean;payroll:boolean;capacityQuery?:CapacityQuery;qualityQuery?:QualityQuery}){
 if(!isAdmin)return null;
 const t=await getTranslations('aiCentre.insights');
 return <div data-ai-centre-insights className="space-y-6">
  <PageHeader title={t('title')} description={t('description')}/>
  <CapacityLedgerSection session={session} query={capacityQuery??{}}/>
  <AiQualitySection session={session} query={qualityQuery??{}} accuracy={<CheckAccuracySection session={session} payroll={payroll}/>}/>
 </div>;
}
