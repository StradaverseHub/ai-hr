import {requireAdmin} from '@/lib/authz';
import {listSectionImportJobs} from '@/core/section-import-job';
import {bankImportHttpError} from '@/lib/bank-import-http';
export const runtime='nodejs';
export async function GET(){const ctx=await requireAdmin();try{return Response.json({jobs:await listSectionImportJobs(ctx)},{headers:{'Cache-Control':'private, no-store'}});}catch(error){return bankImportHttpError(error);}}
