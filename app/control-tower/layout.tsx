import type { ReactNode } from 'react';
import { requireAdminOrAuditReader } from '@/lib/authz';

/** Control Tower pages share the admin guard. Navigation between them is the AI Control Tower menu in the
 * sidebar (28 Oct 2026, owner); the in-page tab row was retired so there is one menu, not two.
 * AI v2 Phase 2 hardening: the layout also admits a login with a current read-only auditor grant, for the one page an
 * auditor may open (the Audit loop's, /control-tower/loops/loop_payroll_audit, which shows them their granted companies
 * only). Every other page under this layout calls requireAdmin itself and still sends an auditor home
 * (test/ai-centre-operations-guards.test.ts pins both). */
export default async function ControlTowerLayout({ children }: { children: ReactNode }) {
  await requireAdminOrAuditReader();
  return <>{children}</>;
}
