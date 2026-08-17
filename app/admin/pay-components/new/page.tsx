import { requireAdmin } from '@/lib/authz';
import { isAiConfigured } from '@/core/ai-config';
import { listPayComponents } from '@/core/pay-components';
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
  searchParams: Promise<{ error?: string; fresh?: string; from?: string }>;
}) {
  const s = await requireAdmin();
  const { error, fresh, from } = await searchParams;
  const aiEnabled = await isAiConfigured(s);
  // a6da1387 — Copy Pay Code: ?from=CODE pre-fills a CREATE form from the source item. includeArchived so
  // a deactivated source can still be copied. Not found ⇒ an ordinary blank New form. The `copy` flag (not
  // `editing`) keeps the CREATE action, makes the Pay Code field editable + blank, and titles it "Copy Pay
  // Code" — uniqueness is still enforced by createPayComponent on save.
  const source = from
    ? (await listPayComponents(s, { includeArchived: true })).find((c) => c.code === from) ?? null
    : null;
  // Copy Pay Code branch: a CREATE form pre-filled from the source item (keyed off its code so switching
  // sources remounts). The blank-New branch below is left byte-identical to 911b2886 — the `fresh` nonce
  // key guarantees Save & New remounts a truly blank form.
  if (source) {
    return <ComponentForm key={`copy-${source.code}`} component={source} copy aiEnabled={aiEnabled} error={error} />;
  }
  return (
    <ComponentForm
      key={fresh ?? 'new'}
      component={null}
      aiEnabled={aiEnabled}
      error={error}
    />
  );
}
