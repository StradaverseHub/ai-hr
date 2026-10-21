import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { getScopeIds } from '@/lib/scope';
import { allowedCompanies } from '@/core/read';
import { isAdmin } from '@/lib/authz-model';
import { isSameOriginBrowserRequest } from '@/lib/request-origin';
import { publicErrorMessage } from '@/lib/public-error';
import { previewCardImport, commitCardImport } from '@/packs/attendance/service';
import { CARD_IMPORT_MAX_BYTES, CardImportError } from '@/lib/card-import';
import { SpreadsheetArchiveError } from '@/lib/spreadsheet-archive';

const headers = { 'Cache-Control': 'private, no-store' };
export async function POST(request: Request) {
  if (!isSameOriginBrowserRequest(request)) return Response.json({ ok: false }, { status: 403, headers });
  const ctx = await getSession(), t = await getTranslations('cardImport');
  const failure = (code: string, status = 400) => Response.json({ ok: false, error: t(code) }, { status, headers });
  if (!isAdmin(ctx)) return failure('scope', 403);
  const reader = request.body?.getReader(), contentType = request.headers.get('content-type');
  if (!reader || !contentType?.startsWith('multipart/form-data')) return failure('invalidWorkbook');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > CARD_IMPORT_MAX_BYTES + 200_000) { await reader.cancel(); return failure('tooLarge', 413); }
    chunks.push(chunk.value);
  }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks.map(c => Buffer.from(c))), { headers: { 'Content-Type': contentType } }).formData(); }
  catch { return failure('invalidWorkbook'); }
  const file = form.get('file'), operation = form.get('operation');
  if (!(file instanceof File) || !/\.xlsx$/i.test(file.name)) return failure('invalidWorkbook');
  if (file.size > CARD_IMPORT_MAX_BYTES) return failure('tooLarge', 413);
  if (!['preview', 'confirm'].includes(String(operation))) return failure('invalidReview');
  let scope = await getScopeIds((await allowedCompanies(ctx)).map(c => c.id));
  const company = String(form.get('company') ?? '');
  if (company) { if (!scope.includes(company)) return failure('scope', 403); scope = [company]; }
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    if (operation === 'preview') return Response.json({ ok: true, preview: await previewCardImport(ctx, scope, bytes, file.name) }, { headers });
    let selection: number[];
    try { selection = JSON.parse(String(form.get('selection') ?? '')); } catch { return failure('invalidReview'); }
    const result = await commitCardImport(ctx, scope, bytes, file.name, String(form.get('receipt') ?? ''), selection, form.get('confirmReplacements') === 'true');
    revalidatePath('/admin/card-assignment');
    revalidatePath('/admin/personnel');
    return Response.json({ ok: true, result }, { headers });
  } catch (error) {
    if (error instanceof CardImportError) return failure(error.code, error.code === 'scope' ? 403 : 400);
    if (error instanceof SpreadsheetArchiveError) return failure(error.code === 'tooLarge' ? 'tooLarge' : 'invalidWorkbook');
    publicErrorMessage(error);
    return failure('saveFailed');
  }
}
