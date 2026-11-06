import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz-model';
import { shiftImportWorkbook } from '@/lib/shift-import-workbook';

export async function GET() {
  if (!isAdmin(await getSession())) return new Response(null, { status: 403 });
  return new Response(new Uint8Array(shiftImportWorkbook()), {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="Shift_Import_Template.xlsx"',
    },
  });
}
