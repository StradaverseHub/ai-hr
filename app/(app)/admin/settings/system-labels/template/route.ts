import { todayInKualaLumpur } from '@/lib/hr-date';
import { scopedAdmin } from '@/lib/scope';
import { downloadSystemLabelTemplate } from '@/core/system-label-import';

export async function GET() {
  const {s,scopeIds}=await scopedAdmin();
  const bytes=await downloadSystemLabelTemplate(s,scopeIds);
  return new Response(new Uint8Array(bytes),{headers:{
    'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition':`attachment; filename="System_Labels_Upload_Template_${todayInKualaLumpur().replace(/-/g,'')}.xlsx"`,
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
  }});
}
