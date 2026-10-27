/** Explicit own-employment selector shared by integrity enrollment and key recovery. */
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {requireOwnIntegrityEmployment} from '../../packs/attendance/mobile-integrity-recovery';
import {MobileBadRequest} from './handler';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export async function integrityEmployment(ctx:SessionContext,req:Request){
  const params=new URL(req.url).searchParams;
  if([...params.keys()].some(key=>key!=='employmentId')||params.getAll('employmentId').length!==1)throw new MobileBadRequest('Select an employment');
  const parsed=uuid.safeParse(params.get('employmentId'));if(!parsed.success)throw new MobileBadRequest('Invalid selector');
  await requireOwnIntegrityEmployment(ctx,parsed.data);return parsed.data;
}
