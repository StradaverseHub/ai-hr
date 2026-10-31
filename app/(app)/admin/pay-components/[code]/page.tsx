import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { listPayComponents } from '@/core/pay-components';
import { isAiConfigured } from '@/core/ai-config';
import { ComponentForm } from '../component-form';

/**
 * 911b2886 — Edit Pay Code on a dedicated maintenance screen (attendance rules/[ruleId] precedent),
 * pre-filled from the selected component. Route registered in lib/permissions.ts. Lookup matches the old
 * inline edit's predicate — includeArchived, so a deactivated code stays editable (its Status shows
 * Inactive, read-only) exactly as before the split. Unknown code ⇒ notFound().
 */
export default async function EditPayComponentPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const { code } = await params;
  const { error } = await searchParams;
  const components = await listPayComponents(s, { includeArchived: true });
  const component = components.find((c) => c.code === decodeURIComponent(code)) ?? null;
  if (!component) notFound();
  const aiEnabled = await isAiConfigured(s);
  return <ComponentForm component={component} aiEnabled={aiEnabled} error={error} />;
}
