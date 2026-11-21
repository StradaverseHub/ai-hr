import {requireAdmin} from '@/lib/authz';
import {listMovementImportJobs,movementImportJobHttpError} from '@/core/movement-import-job';
export const runtime='nodejs';
/** The signed-in user's recent movement imports, so the screen can rejoin one that is still running. */
export async function GET(){const ctx=await requireAdmin();try{return Response.json({jobs:await listMovementImportJobs(ctx)},{headers:{'Cache-Control':'private, no-store'}});}catch(error){return movementImportJobHttpError(error);}}
