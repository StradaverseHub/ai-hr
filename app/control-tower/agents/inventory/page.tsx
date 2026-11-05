import { permanentRedirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';

/** AI Centre restructure (owner decision 29, 4 November 2026): Workers is the one list of AI pieces, so the inventory and
 * its audit columns are a section of the Workers page. This address stays for old links and for lib/permissions.ts
 * (test/function-access.test.ts needs every registered route on disk as a guarded route): requireAdmin() is the unchanged
 * guard, core/ai-inventory.ts still narrows a company HR administrator to the read-only registry view on the Workers page,
 * and this page reads nothing. */
export default async function AiManagementInventoryPage() {
  await requireAdmin();
  permanentRedirect('/control-tower/agents/features#ai-inventory');
}
