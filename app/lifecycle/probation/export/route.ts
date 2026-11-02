import {getTranslations} from 'next-intl/server';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationSummaryRows} from '@/packs/probation/service';
import {toCsv} from '@/lib/csv';
import {trackerFilters} from '../tracker-filters';
export const runtime='nodejs';
export async function GET(request:Request){
 const session=await requireScopedLifecycleModule(),url=new URL(request.url),filters=trackerFilters(Object.fromEntries(url.searchParams)),t=await getTranslations('probation');
 const rows:(string|number|null)[][]=[['employee','employeeCode','businessGroup','businessUnit','department','grade','startOn','endOn'].map(key=>t('facts.'+key)).concat([t('columns.state'),t('columns.extensions'),t('columns.waiting'),t('columns.due')])];
 for(let offset=0;offset<=10000;offset+=100){const page=await probationSummaryRows(session,{...filters,offset,limit:offset===10000?1:100});if(offset===10000&&page.rows.length)return new Response(null,{status:413,headers:{'cache-control':'private, no-store'}});for(const row of page.rows){const pending=row.parts.find(part=>!['locked','recorded','completed_offline','cancelled','not_issued'].includes(part.state));rows.push([row.employeeName,row.employeeCode,row.businessGroup,row.businessUnit,row.department,row.grade,row.startOn,row.endOn,t.has('caseStates.'+row.state)?t('caseStates.'+row.state):row.state,row.extensionCount,pending?.waitingName??null,pending?.dueOn??null]);}if(!page.hasMore)break;}
 return new Response('\uFEFF'+toCsv(rows),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="probation-tracker.csv"','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
}
