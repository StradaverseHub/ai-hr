import {requireAdmin} from '@/lib/authz';
import {GET as errorLog} from '../error-log/route';
export const runtime='nodejs';
/** d3ba1e9f — the old error-report address keeps working: it now serves the localized Error Log (.xlsx), the same
 *  file as ../error-log (same admin guard and job visibility), instead of the English-only CSV. */
export async function GET(request:Request,context:{params:Promise<{jobId:string}>}){
 await requireAdmin();
 return errorLog(request,context);
}
