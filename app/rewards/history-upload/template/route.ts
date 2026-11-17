import {getSession} from '@/lib/session';
import {rewardHistoryUploadCompanies} from '@/packs/rewards/person-history-upload';
import {rewardHistoryUploadHeaders} from '@/packs/rewards/person-history-model';
import {toCsv} from '@/lib/csv';
export async function GET(){
 const companies=await rewardHistoryUploadCompanies(await getSession()).catch(()=>[]);
 if(!companies.length)return new Response('Reward history upload is unavailable.',{status:403});
 return new Response('\uFEFF'+toCsv([rewardHistoryUploadHeaders]),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="reward-history-template.csv"','Cache-Control':'no-store'}});
}
