'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  archiveDocument,
  createArticle,
  restoreDocument,
  updateDocument,
  uploadDocument,
  type KbAudience,
} from '@/core/knowledge-base';

const audienceOf = (v: FormDataEntryValue | null): KbAudience => {
  const s = String(v ?? 'all');
  return (['all', 'employee', 'manager', 'hr_admin'].includes(s) ? s : 'all') as KbAudience;
};

export async function createArticleAction(formData: FormData) {
  const s = await getSession();
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
    redirect(`/knowledge-base?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/knowledge-base');
  redirect(`/knowledge-base/${id}?toast=Article+created`);
}

export async function uploadFileAction(formData: FormData) {
  const s = await getSession();
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
    redirect(`/knowledge-base?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/knowledge-base');
  redirect(`/knowledge-base/${id}?toast=File+uploaded`);
}

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
    redirect(`/knowledge-base/${id}?edit=1&error=${encodeURIComponent((e as Error).message)}`);
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
    redirect(`/knowledge-base/${id}?error=${encodeURIComponent((e as Error).message)}`);
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
    redirect(`/knowledge-base/${id}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/knowledge-base/${id}`);
  revalidatePath('/knowledge-base');
  redirect(`/knowledge-base/${id}?toast=Restored`);
}
