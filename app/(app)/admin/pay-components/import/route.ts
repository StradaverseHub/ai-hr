import { createHash } from 'node:crypto';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz-model';
import { isSameOriginBrowserRequest } from '@/lib/request-origin';
import { publicErrorMessage } from '@/lib/public-error';
import { payItemVocabulary, previewPayItemImport, commitPayItemImport } from '@/core/pay-component-import';
import { PayComponentCodeExistsError, PayComponentInputError } from '@/core/pay-components';
import { PAY_ITEM_MAX_BYTES } from '@/lib/pay-component-import';
import { PayItemWorkbookError, payItemErrorWorkbook } from '@/lib/pay-component-workbook';
import { payItemIssueMessage } from '@/lib/pay-item-import-messages';

/** Bounded multipart upload avoids increasing every server action's payload limit. */
export async function POST(request: Request) {
  if (!isSameOriginBrowserRequest(request)) return Response.json({ ok: false }, { status: 403 });
  const ctx = await getSession();
  if (!isAdmin(ctx)) return Response.json({ ok: false }, { status: 403 });
  const [t, english, rule] = await Promise.all([getTranslations('payComponents'), getTranslations({ locale: 'en', namespace: 'payComponents' }), getTranslations('payRule')]);
  const failure = (error: string, status = 400) => Response.json({ ok: false, error }, { status, headers: { 'Cache-Control': 'private, no-store' } });
  const reader = request.body?.getReader(), contentType = request.headers.get('content-type');
  if (!reader || !contentType?.startsWith('multipart/form-data')) return failure(t('importFile_invalidWorkbook'));
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > PAY_ITEM_MAX_BYTES + 65536) { await reader.cancel(); return failure(t('importFile_tooLarge'), 413); }
    chunks.push(chunk.value);
  }
  let data: FormData;
  try { data = await new Response(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), { headers: { 'Content-Type': contentType } }).formData(); }
  catch { return failure(t('importFile_invalidWorkbook')); }
  const file = data.get('file'), operation = data.get('operation');
  if (!(file instanceof File) || !/\.xlsx$/i.test(file.name) || file.size > PAY_ITEM_MAX_BYTES || !['preview', 'confirm', 'errors'].includes(String(operation))) return failure(t(file instanceof File && file.size > PAY_ITEM_MAX_BYTES ? 'importFile_tooLarge' : 'importFile_invalidWorkbook'));
  const bytes = Buffer.from(await file.arrayBuffer()), vocabulary = payItemVocabulary(t, english);
  try {
    if (operation === 'confirm') {
      const expected = String(data.get('fileSha256') ?? '');
      if (!/^[a-f0-9]{64}$/.test(expected) || createHash('sha256').update(bytes).digest('hex') !== expected) return failure(t('importChanged'));
      const result = await commitPayItemImport(ctx, bytes, file.name, expected, vocabulary);
      revalidatePath('/admin/pay-components');
      return Response.json({ ok: true, created: result.created }, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const preview = await previewPayItemImport(ctx, bytes, vocabulary);
    if (operation === 'errors') {
      const report = await payItemErrorWorkbook(bytes, preview.rows, code => payItemIssueMessage(code, t, rule));
      return new Response(new Uint8Array(report), { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="PayItems_Import_Result.xlsx"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    return Response.json({ ok: true, preview, vocabulary }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof PayItemWorkbookError) return failure(t(`importFile_${error.code}`, { field: error.field ?? '' }));
    if (error instanceof PayComponentCodeExistsError) return failure(t('errorCodeDuplicate', { code: error.code }));
    if (error instanceof PayComponentInputError) return failure(error.issues.map(issue => payItemIssueMessage(issue.code, t, rule)).join(' '));
    publicErrorMessage(error); // Existing DB logger redacts the public response; never return SQL/parameters.
    return failure(t('importFailed'));
  }
}
