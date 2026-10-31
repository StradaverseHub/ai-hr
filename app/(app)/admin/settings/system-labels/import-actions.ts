'use server';

import { scopedAdmin } from '@/lib/scope';
import { revalidatePath } from 'next/cache';
import { previewSystemLabelImport, applySystemLabelImport } from '@/core/system-label-import';
import { LABEL_WORKBOOK_MAX_BYTES } from '@/lib/system-label-workbook';
import { publicErrorMessage } from '@/lib/public-error';

async function upload(data:FormData) {
  const file=data.get('file');
  if(!(file instanceof File)||!/\.xlsx?$/i.test(file.name)||!file.size||file.size>LABEL_WORKBOOK_MAX_BYTES)
    throw new Error('Choose an XLSX or XLS file no larger than 5 MB.');
  return Buffer.from(await file.arrayBuffer());
}

function selection(data:FormData):string[]|undefined {
 const raw=data.get('selectedKeys');
 if(raw==null)return undefined;
 if(typeof raw!=='string'||raw.length>150000)throw new Error('Invalid row selection.');
 const rows=JSON.parse(raw);
 if(!Array.isArray(rows)||rows.length>7000||rows.some(r=>typeof r!=='string'))throw new Error('Invalid row selection.');
 return rows;
}

export async function previewLabelsAction(data:FormData) {
  const {s}=await scopedAdmin();
  try {return {ok:true as const,preview:await previewSystemLabelImport(s,await upload(data),'add',selection(data))};}
  catch(e){return {ok:false as const,message:publicErrorMessage(e)};}
}

export async function importLabelsAction(data:FormData) {
  const {s}=await scopedAdmin();
  try {
    const summary=await applySystemLabelImport(s,{bytes:await upload(data),mode:'add',
      token:String(data.get('token')??''),confirmUpdates:false,selectedKeys:selection(data)});
    revalidatePath('/admin/settings/system-labels');
    revalidatePath('/admin/personnel');
    revalidatePath('/admin/settings/system-labels/profile-options');
    return {ok:true as const,summary};
  }catch(e){return {ok:false as const,message:publicErrorMessage(e)};}
}
