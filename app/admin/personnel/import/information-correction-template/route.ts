import {requireAdmin} from '@/lib/authz';
import {informationCorrectionOptions} from '@/core/information-correction';
import {informationWorkbook} from '@/lib/information-correction-workbook';
export async function GET(){
 const ctx=await requireAdmin(),content=informationWorkbook(await informationCorrectionOptions(ctx));
 return new Response(new Uint8Array(content),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="information-only-correction.xlsx"','Cache-Control':'private, no-store'}});
}
