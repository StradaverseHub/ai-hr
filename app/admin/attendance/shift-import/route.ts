import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz-model';
import { isSameOriginBrowserRequest } from '@/lib/request-origin';
import { publicErrorMessage } from '@/lib/public-error';
import { confirmShiftImport, previewShiftImport } from '@/core/shift-import';
import { SHIFT_IMPORT_MAX_BYTES, shiftImportErrorWorkbook } from '@/lib/shift-import-workbook';

const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  if (!isSameOriginBrowserRequest(request)) return Response.json({ ok: false }, { status: 403, headers });
  const session = await getSession();
  if (!isAdmin(session)) return Response.json({ ok: false }, { status: 403, headers });
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status, headers });
  const type = request.headers.get('content-type') ?? '';
  const reader = request.body?.getReader();
  if (!reader || !type.startsWith('multipart/form-data')) return fail('Choose an Excel workbook.');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > SHIFT_IMPORT_MAX_BYTES + 65536) {
        await reader.cancel();
        return fail('The workbook exceeds the 2 MB limit.', 413);
      }
      chunks.push(Buffer.from(next.value));
    }
    const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': type } }).formData();
    const file = form.get('file'), operation = form.get('operation');
    if (!(file instanceof File) || !/\.xlsx$/i.test(file.name) || file.size > SHIFT_IMPORT_MAX_BYTES) return fail('Choose an .xlsx workbook up to 2 MB.');
    const bytes = Buffer.from(await file.arrayBuffer());
    if (operation === 'confirm') {
      const fingerprint = form.get('fingerprint');
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) return fail('Preview the workbook before confirming.');
      const summary = await confirmShiftImport(session, bytes, fingerprint);
      revalidatePath('/admin/attendance');
      return Response.json({ ok: true, summary }, { headers });
    }
    if (operation !== 'preview' && operation !== 'errors') return fail('Choose an import action.');
    const { fingerprint, total, issues, operations } = await previewShiftImport(session, bytes);
    if (operation === 'errors') {
      return new Response(new Uint8Array(shiftImportErrorWorkbook(issues)), {
        headers: { ...headers, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="Shift_Import_Errors.xlsx"' },
      });
    }
    return Response.json({ ok: true, preview: { fingerprint, total, issues,
      rows: operations.map(operation => ({ row: operation.row, code: operation.code, update: Boolean(operation.id) })) } }, { headers });
  } catch (error) {
    return fail(publicErrorMessage(error));
  }
}
