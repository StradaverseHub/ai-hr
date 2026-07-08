'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { allowedCompanies } from '@/core/read';
import { getScopeIds } from '@/lib/scope';
import {
  deleteCustomReport,
  duplicateCustomReport,
  runCustomReport,
  saveCustomReport,
  saveReportAsTemplate,
  setShared,
  toggleFavourite,
  updateCustomReport,
} from '@/core/custom-reports';
import { draftReportSpec, ReportDraftError, type ReportRecommendations } from '@/core/report-ai';
import { validateReportSpec } from '@/core/report-registry';
import type { CustomReportSpec } from '@/db/schema';
import type { ReportData } from '@/lib/report-export';

const BASE = '/reports';

async function scope() {
  const s = await getSession();
  const allowed = await allowedCompanies(s);
  const scopeIds = await getScopeIds(allowed.map((c) => c.id));
  return { s, scopeIds };
}

/** Create or update a report from the builder. `id` present ⇒ update; absent ⇒ create. Redirects to the
 *  saved report's builder page on success. */
export async function saveReportAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const shared = formData.get('shared') === 'on' || formData.get('shared') === 'true';
  let spec: CustomReportSpec;
  try {
    spec = JSON.parse(String(formData.get('spec') ?? '{}')) as CustomReportSpec;
  } catch {
    redirect(`${BASE}?error=${encodeURIComponent('Invalid report definition')}`);
  }
  const category = spec!.datasetId; // used only for redirect grouping fallback
  try {
    if (id) {
      await updateCustomReport(s, { id, name, spec: spec!, shared });
      revalidatePath(`${BASE}/builder/${id}`);
      revalidatePath(BASE);
      redirect(`${BASE}/builder/${id}?toast=${encodeURIComponent('Report saved')}`);
    } else {
      const { id: newId } = await saveCustomReport(s, { name, datasetId: spec!.datasetId, spec: spec!, shared });
      revalidatePath(BASE);
      redirect(`${BASE}/builder/${newId}?toast=${encodeURIComponent('Report created')}`);
    }
  } catch (e) {
    // redirect() throws internally — re-throw those; only real errors land here.
    if (e && typeof e === 'object' && 'digest' in e) throw e;
    redirect(`${BASE}/builder/${id || 'new'}?dataset=${encodeURIComponent(category)}&error=${encodeURIComponent((e as Error).message)}`);
  }
}

export async function deleteReportAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id') ?? '');
  try {
    await deleteCustomReport(s, id);
  } catch (e) {
    redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Report deleted')}`);
}

export async function duplicateReportAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id') ?? '');
  let newId: string | null = null;
  try {
    const r = await duplicateCustomReport(s, id);
    newId = r?.id ?? null;
  } catch (e) {
    redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(BASE);
  redirect(newId ? `${BASE}/builder/${newId}?toast=${encodeURIComponent('Report duplicated')}` : BASE);
}

export async function toggleFavouriteAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id') ?? '');
  const next = String(formData.get('next') ?? 'true') === 'true';
  try {
    await toggleFavourite(s, { id, isFavourite: next });
  } catch (e) {
    redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(BASE);
  redirect(BASE);
}

export async function setSharedAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id') ?? '');
  const next = String(formData.get('next') ?? 'true') === 'true';
  try {
    await setShared(s, { id, shared: next });
  } catch (e) {
    redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(BASE);
  redirect(BASE);
}

/** Live preview — runs an ad-hoc spec and returns the first N rows for the builder canvas. Read-only. */
export async function previewReport(spec: CustomReportSpec, limit = 25): Promise<{ ok: boolean; data?: ReportData; error?: string }> {
  const { s, scopeIds } = await scope();
  if (!isAdmin(s)) return { ok: false, error: 'forbidden' };
  const v = validateReportSpec(spec);
  if (!v.ok) return { ok: false, error: v.reason };
  try {
    const data = await runCustomReport(s, scopeIds, { spec });
    return { ok: true, data: { ...data, rows: data.rows.slice(0, limit) } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** AI Report Designer — natural language → a validated spec + explanation (draft only). */
export async function draftReport(
  datasetId: string,
  description: string,
): Promise<{
  ok: boolean;
  spec?: CustomReportSpec;
  explanation?: string;
  recommendations?: ReportRecommendations;
  error?: 'not_configured' | 'invalid_output' | 'forbidden';
}> {
  const s = await getSession();
  if (!isAdmin(s)) return { ok: false, error: 'forbidden' };
  try {
    const { spec, explanation, recommendations } = await draftReportSpec(s, { datasetId, description });
    return { ok: true, spec, explanation, recommendations };
  } catch (e) {
    if (e instanceof ReportDraftError) return { ok: false, error: e.reason };
    return { ok: false, error: 'invalid_output' };
  }
}

/** Save-as-Template (c440b365 gap-9): duplicate the given saved report as a fresh, shared template copy.
 *  Gated in the service by the 'manageTemplates' verb of the source report's permission grid. */
export async function saveAsTemplateAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id') ?? '');
  let newId: string | null = null;
  try {
    const r = await saveReportAsTemplate(s, id);
    newId = r?.id ?? null;
  } catch (e) {
    redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(BASE);
  redirect(newId ? `${BASE}/builder/${newId}?toast=${encodeURIComponent('Saved as template')}` : BASE);
}
