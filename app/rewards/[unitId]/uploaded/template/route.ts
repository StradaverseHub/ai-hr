import {getSession} from '@/lib/session';
import {uploadedRewards} from '@/packs/rewards/uploaded-awards';
import {uploadedAwardHeaders} from '@/packs/rewards/uploaded-awards-model';
import {toCsv} from '@/lib/csv';
export async function GET(_request:Request,{params}:{params:Promise<{unitId:string}>}){const v=await uploadedRewards(await getSession(),(await params).unitId);if(!v?.canUpload)return new Response('Unavailable',{status:403});const csv=toCsv([uploadedAwardHeaders,...v.rows.filter(e=>!e.source.leftOn).map(e=>[e.source.employmentId,e.source.employeeCode,e.source.name,e.source.grade,(e.source.basicCents/100).toFixed(2),[e.source.notice?'notice':'',e.facts.erCase?'ER':'',e.source.lastPayChange??''].filter(Boolean).join('; '),'merit','0','','','0','0',''])]);return new Response('\uFEFF'+csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="uploaded-awards-template.csv"','Cache-Control':'no-store'}});}
