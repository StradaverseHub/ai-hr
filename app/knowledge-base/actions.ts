'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  archiveDocument,
  canAuthor,
  createArticle,
  KbAuthorAdminRequiredError,
  restoreDocument,
  updateDocument,
  uploadDocument,
  type KbAudience,
} from '@/core/knowledge-base';

const audienceOf = (v: FormDataEntryValue | null): KbAudience => {
  const s = String(v ?? 'all');
  return (['all', 'employee', 'manager', 'hr_admin'].includes(s) ? s : 'all') as KbAudience;
};

/**
 * THE TWO WAYS INTO THE LIBRARY ARE ADMINISTRATOR-ONLY, refused here and not merely unoffered.
 *
 * `core/knowledge-base.ts` carries the enforcement (`assertKbAuthor`, at the top of `createArticle` and
 * `uploadDocument`) because that is the boundary every caller crosses. This second refusal is the
 * fail-fast one, for the same reason `app/roster/actions.ts` refuses before calling the generator: a
 * Server Action is a POST endpoint reachable by anyone whose bundle carries its id, and a refusal the
 * user can read ("ask an administrator") beats whatever the write path would have said on the way down.
 *
 * Outside the try on purpose: `redirect()` signals by THROWING, and the catch below would swallow it.
 */
function refuseNonAuthor(s: Parameters<typeof canAuthor>[0]): void {
  if (!canAuthor(s)) {
    redirect(`/knowledge-base?error=${encodeURIComponent(new KbAuthorAdminRequiredError().message)}`);
  }
}

export async function createArticleAction(formData: FormData) {
  const s = await getSession();
  refuseNonAuthor(s);
  let id: string;
  try {
    const res = await createArticle(s, {
      title: String(formData.get('title') ?? ''),
      body: String(formData.get('body') ?? ''),
      category: String(formData.get('category') ?? 'general'),
      audience: audienceOf(formData.get('audience')),
    });
    id = res.id;
  } catch (e) {
    redirect(`/knowledge-base?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath('/knowledge-base');
  redirect(`/knowledge-base/${id}?toast=Article+created`);
}

export async function uploadFileAction(formData: FormData) {
  const s = await getSession();
  refuseNonAuthor(s);
  const file = formData.get('file');
  let id: string;
  try {
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose a file to upload.');
    const content = Buffer.from(await file.arrayBuffer());
    const res = await uploadDocument(s, {
      title: String(formData.get('title') ?? '') || file.name,
      fileName: file.name,
      mimeType: file.type,
      content,
      category: String(formData.get('category') ?? 'general'),
      audience: audienceOf(formData.get('audience')),
    });
    id = res.id;
  } catch (e) {
    redirect(`/knowledge-base?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath('/knowledge-base');
  redirect(`/knowledge-base/${id}?toast=File+uploaded`);
}

/**
 * THE THREE SIBLINGS BELOW — update, archive, restore — KEEP THE BARE SESSION, and that is not an
 * oversight left beside a fixed create. They are the writes RLS already fences:
 * `kb_document_update` / `kb_document_delete` (0039) admit `app.is_admin()` OR the author of a
 * non-system document, so a stranger's edit returns zero rows and each service turns that into
 * "Document not found, or you cannot edit it." — a readable refusal, no SQL, no ids.
 * `test/kb-authoring-gate.test.ts` measures that rather than assuming it.
 *
 * What they gained is the AUDIENCE half: `updateDocument` now refuses an audience above the caller's own
 * clearance, so the member-authored documents that predate the author gate cannot be re-filed onto the
 * HR shelf by an author who could not read that shelf.
 */
export async function updateDocumentAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id') ?? '');
  try {
    await updateDocument(s, {
      id,
      title: String(formData.get('title') ?? ''),
      body: String(formData.get('body') ?? ''),
      category: String(formData.get('category') ?? 'general'),
      audience: audienceOf(formData.get('audience')),
    });
  } catch (e) {
    redirect(`/knowledge-base/${id}?edit=1&error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(`/knowledge-base/${id}`);
  revalidatePath('/knowledge-base');
  redirect(`/knowledge-base/${id}?toast=Saved`);
}

export async function archiveDocumentAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id') ?? '');
  try {
    await archiveDocument(s, id);
  } catch (e) {
    redirect(`/knowledge-base/${id}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath('/knowledge-base');
  redirect('/knowledge-base?toast=Archived');
}

export async function restoreDocumentAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id') ?? '');
  try {
    await restoreDocument(s, id);
  } catch (e) {
    redirect(`/knowledge-base/${id}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(`/knowledge-base/${id}`);
  revalidatePath('/knowledge-base');
  redirect(`/knowledge-base/${id}?toast=Restored`);
}
