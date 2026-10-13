'use server';

import { scopedAdmin } from '@/lib/scope';
import { revalidatePath } from 'next/cache';
import { previewSystemLabelImport, applySystemLabelImport } from '@/core/system-label-import';
import { LABEL_WORKBOOK_MAX_BYTES } from '@/lib/system-label-workbook';
import { publicErrorMessage } from '@/lib/public-error';
import type { LabelImportMode } from '@/lib/system-label-definition';

async function upload(data:FormData) {
  const file=data.get('file');
  if(!(file instanceof File)||!file.name.toLowerCase().endsWith('.xlsx')||!file.size||file.size>LABEL_WORKBOOK_MAX_BYTES)
    throw new Error('Choose an .xlsx file no larger than 750 KB.');
  return Buffer.from(await file.arrayBuffer());
}

export async function previewLabelsAction(data:FormData) {
  const {s}=await scopedAdmin();
  try {return {ok:true as const,preview:await previewSystemLabelImport(s,await upload(data),String(data.get('mode')) as LabelImportMode)};}
  catch(e){return {ok:false as const,message:publicErrorMessage(e)};}
}

export async function importLabelsAction(data:FormData) {
  const {s}=await scopedAdmin();
  try {
    const summary=await applySystemLabelImport(s,{bytes:await upload(data),mode:String(data.get('mode')) as LabelImportMode,
      token:String(data.get('token')??''),confirmUpdates:data.get('confirmUpdates')==='true'});
    revalidatePath('/admin/settings/system-labels');
    revalidatePath('/admin/personnel');
    return {ok:true as const,summary};
  }catch(e){return {ok:false as const,message:publicErrorMessage(e)};}
}
