import {scopedAdmin} from '@/lib/scope';
import {rosterEmployeePage,rosterPopulationIds} from '@/core/roster-presentation';
import {EmployeeChoiceInputError} from '@/core/employee-choice';
import {AiGatewayError} from '@/lib/ai/types';
import {rosterPopulationScope} from '../population-scope';
import {myTeamErrorResponse} from '@/app/manage/my-team/server';
import {ROSTER_SELECTION_MAX} from '@/lib/roster-selection';

export async function GET(req:Request){
 const {s}=await scopedAdmin(),url=new URL(req.url);
 const raw=url.searchParams.get('offset')??'0';
 if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))return new Response('Invalid roster page',{status:400});
 let population:Awaited<ReturnType<typeof rosterPopulationScope>>;
 try{population=await rosterPopulationScope(s,url.searchParams);}catch(error){return myTeamErrorResponse(error);}
 try{
  if(url.searchParams.get('complete')==='1'){
   const ids=await rosterPopulationIds(s,population,req.signal);
   if(ids.length>ROSTER_SELECTION_MAX)return new Response('Select at most 100,000 employees per operation',{status:422});
   return Response.json({ids},{headers:{'Cache-Control':'private, no-store'}});
  }
  const page=await rosterEmployeePage(s,{...population,offset:Number(raw),limit:25},req.signal);
  return Response.json(page,{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  if(error instanceof EmployeeChoiceInputError)return new Response('Invalid roster filters',{status:400});
  if(error instanceof AiGatewayError)return new Response('Forbidden',{status:403});
  throw error;
 }
}
