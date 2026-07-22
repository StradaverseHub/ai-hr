import { requireAdmin } from '@/lib/authz';
import { isAiConfigured } from '@/core/ai-config';
import { ComponentForm } from '../component-form';

/**
 * 911b2886 — Create New Pay Code on a dedicated maintenance screen (attendance rules/new precedent).
 * Route registered in lib/permissions.ts. `error` re-renders the action's rejection through the banner.
 *
 * The `fresh` key is REQUIRED, not cosmetic: Save & New redirects /new → /new, a same-segment navigation
 * where React reconciles in place and PayRuleEditor's controlled state — including the hidden `rule`
 * field — survives, so without the key the next item would silently inherit the previous pay rule. The
 * action mints a Date.now() nonce (ToastFromQuery strips only toast/error, so `fresh` survives) and the
 * keyed remount guarantees a truly blank form.
 */
export default async function NewPayComponentPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; fresh?: string }>;
}) {
  const s = await requireAdmin();
  const { error, fresh } = await searchParams;
  const aiEnabled = await isAiConfigured(s);
  return <ComponentForm key={fresh ?? 'new'} component={null} aiEnabled={aiEnabled} error={error} />;
}
