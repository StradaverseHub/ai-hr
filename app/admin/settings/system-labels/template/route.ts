import { scopedAdmin } from '@/lib/scope';
import { downloadSystemLabelTemplate } from '@/core/system-label-import';

export async function GET() {
  const {s}=await scopedAdmin();
  const bytes=await downloadSystemLabelTemplate(s);
  return new Response(new Uint8Array(bytes),{headers:{
    'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition':'attachment; filename="system-labels-template.xlsx"',
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
  }});
}
