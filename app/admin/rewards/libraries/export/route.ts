import {getSession} from '@/lib/session';
import {getTranslations} from 'next-intl/server';
import {rewardLibraryForExport,rewardLibraryGradeChoices} from '@/packs/rewards/libraries';
import {libraryWorkbookRows,makeWorkbook} from '@/packs/rewards/setup-workbook';
import {renderRewardSetupPdf} from '@/packs/rewards/setup-pdf';
export async function GET(request:Request){const s=await getSession(),q=new URL(request.url).searchParams,t=await getTranslations('rewardSetup');try{const version=q.get('version'),kind=q.get('kind')==='bonus'?'bonus':'salary';let title=t(kind==='salary'?'salaryStructures':'bonusMatrices'),rows:Record<string,unknown>[];
 if(version){const v=await rewardLibraryForExport(s,version);title=`${v.name} · ${v.year} · v${v.version}`;rows=libraryWorkbookRows(v.data);}else{const grades=await rewardLibraryGradeChoices(s);rows=grades.map(g=>kind==='salary'?{Grade:g.grade,Minimum:'',Midpoint:'',Maximum:''}:{Grade:g.grade,UA:'0.00',BE:'',ME:'',AE:'',OU:''});}
 const pdf=q.get('format')==='pdf',bytes=pdf?await renderRewardSetupPdf(title,[Object.keys(rows[0]??{}).join(' / '),...rows.map(r=>Object.values(r).join(' / '))]):makeWorkbook(rows);return new Response(new Uint8Array(bytes),{headers:{'Content-Type':pdf?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="rewards-library.${pdf?'pdf':'xlsx'}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
 }catch{return new Response(t('noAccess'),{status:403,headers:{'Cache-Control':'private, no-store'}});}}
