import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';

/** AI v2 Phase 2, P2-6 — the linkable address of AI Centre › Insights › AI quality.
 *
 * AI quality is a section of the Insights view of /assistant, and /assistant is never a link target
 * (lib/product-context/destinations.ts), so the semantic model's ai_quality_summary read, the AI quality guide and an
 * Ask reply link here instead. HR and group administrators only, as the section is: anyone else is turned away by
 * requireAdmin before anything is read. It reads no data and forwards to the section, which applies its own check and
 * the 0972 row-level security again. */
export default async function AiQualityPage() {
  await requireAdmin();
  redirect('/assistant?view=insights#ai-quality');
}
