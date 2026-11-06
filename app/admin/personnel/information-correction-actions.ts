'use server';
import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {InformationCorrectionError,readInformationCorrection,previewInformationCorrection,correctInformation,informationCorrectionOptions,informationCorrectionHistory} from '@/core/information-correction';
import {previewInformationUpload,confirmInformationUpload} from '@/core/information-correction-import';
import type {InformationChanges} from '@/lib/information-correction';
async function withCorrectionFeedback<T>(run: () => Promise<T>): Promise<T | { correctionError: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InformationCorrectionError) return { correctionError: error.message };
    throw error;
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
 if(!(file instanceof File)||file.size>10485760)throw new Error('Choose an Excel file no larger than 10 MB.');
 const result=await previewInformationUpload(ctx,{name:file.name,content:Buffer.from(await file.arrayBuffer()),operationKey:String(data.get('operationKey')??'')});
 return result;
}
export async function confirmInformationUploadAction(input:{attemptId:string;previewHash:string}){
 const result=await confirmInformationUpload(await requireAdmin(),{attemptId:input.attemptId,previewHash:input.previewHash});
 revalidatePath('/admin/personnel');revalidatePath('/admin/personnel/[employmentId]','page');revalidatePath('/admin/personnel/[employmentId]/movement/[mode]','page');revalidatePath('/admin/personnel/[employmentId]/movement/[mode]/[movementId]','page');revalidatePath('/admin/personnel/import');revalidatePath('/admin/personnel/import/history');return result;
}
