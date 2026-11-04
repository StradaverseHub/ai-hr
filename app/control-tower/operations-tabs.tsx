import type { SessionContext } from '@/db/client';
import { isModuleEnabled } from '@/core/entitlements';
import { AiCentreGroupTabs } from '@/components/ai-centre/centre-tabs';
import type { OperationsSection } from '@/lib/ai-centre/centre-nav';

/** AI Centre › Operations (issue 17, owner: "Merge both entirely"): the former Control Tower pages keep their
 * addresses and their requireAdmin guards, and render inside the AI Centre's two tab rows, so the person never
 * leaves AI Centre. Chrome only: rendered after the page's own guard has admitted the session. The payroll
 * queues are offered only while the tenant holds payroll, as their former sidebar rows were. */
export function OperationsTabs({ session, active }: { session: SessionContext; active: OperationsSection }) {
  return <AiCentreGroupTabs group="operations" active={active} payroll={isModuleEnabled(session, 'payroll')} />;
}
