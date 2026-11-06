'use server';
import {revalidatePath} from 'next/cache';
import {unstable_rethrow} from 'next/navigation';
import {requireAdmin} from '@/lib/authz';
import {publicErrorMessage} from '@/lib/public-error';
import {InformationCorrectionError,readInformationCorrection,previewInformationCorrection,correctInformation,informationCorrectionOptions,informationCorrectionHistory} from '@/core/information-correction';
import {previewInformationUpload,confirmInformationUpload} from '@/core/information-correction-import';
import type {InformationChanges} from '@/lib/information-correction';
/** A thrown server-action error reaches a production browser only as "Minified React error #441", so every refusal
 *  returns its sentence; database detail stays behind publicErrorMessage and redirects still propagate. */
async function withCorrectionFeedback<T>(run: () => Promise<T>): Promise<T | { correctionError: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InformationCorrectionError) return { correctionError: error.message };
    unstable_rethrow(error);
    return { correctionError: publicErrorMessage(error) };
  }
}

export async function informationContextAction(employmentId: string) {
  const ctx = await requireAdmin();
  return withCorrectionFeedback(async () => {
    const preview = await readInformationCorrection(ctx, employmentId);
    return { preview, options: await informationCorrectionOptions(ctx), history: await informationCorrectionHistory(ctx, employmentId) };
  });
}

export async function previewInformationAction(input: { employmentId: string; changes: InformationChanges; reason: string }) {
  const ctx = await requireAdmin();
  return withCorrectionFeedback(() => previewInformationCorrection(ctx, input));
}

export async function saveInformationAction(input: { employmentId: string; changes: InformationChanges; reason: string; fingerprint: string }) {
  const ctx = await requireAdmin();
  return withCorrectionFeedback(async () => {
    const result = await correctInformation(ctx, {
      employmentId: input.employmentId,
      changes: input.changes,
      reason: input.reason,
      fingerprint: input.fingerprint,
      method: 'manual',
    });
    revalidatePath('/admin/personnel');
    revalidatePath('/admin/personnel/' + input.employmentId);
    revalidatePath('/admin/personnel/[employmentId]/movement/[mode]', 'page');
    revalidatePath('/admin/personnel/[employmentId]/movement/[mode]/[movementId]', 'page');
    return result;
  });
}
export async function previewInformationUploadAction(data:FormData){
 const ctx=await requireAdmin(),file=data.get('file');
 return withCorrectionFeedback(async()=>{
  if(!(file instanceof File)||file.size>10485760)throw new InformationCorrectionError('Choose an Excel file no larger than 10 MB.');
  return previewInformationUpload(ctx,{name:file.name,content:Buffer.from(await file.arrayBuffer()),operationKey:String(data.get('operationKey')??'')});
 });
}
export async function confirmInformationUploadAction(input:{attemptId:string;previewHash:string}){
 const ctx=await requireAdmin();
 return withCorrectionFeedback(async()=>{
 const result=await confirmInformationUpload(ctx,{attemptId:input.attemptId,previewHash:input.previewHash});
 revalidatePath('/admin/personnel');revalidatePath('/admin/personnel/[employmentId]','page');revalidatePath('/admin/personnel/[employmentId]/movement/[mode]','page');revalidatePath('/admin/personnel/[employmentId]/movement/[mode]/[movementId]','page');revalidatePath('/admin/personnel/import');revalidatePath('/admin/personnel/import/history');return result;
 });
}
