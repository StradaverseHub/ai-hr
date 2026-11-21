import { scopedAdmin } from '@/lib/scope';
import { allowedCompanies } from '@/core/read';
import { rosterWindowView } from '@/core/roster';
import { buildRosterTemplate, resolveRosterWindow, shiftCodeOf } from '@/lib/roster-month';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { rosterTeamContext, rosterTeamWindow } from '../my-team-scope';
import {myTeamErrorResponse} from '@/app/manage/my-team/server';

/** Explicit whole-population artifact read. No template rows travel with ordinary RSC navigation. */
export async function GET(req: Request) {
  const {s,scopeIds}=await scopedAdmin();
  const url=new URL(req.url);
  let team:Awaited<ReturnType<typeof rosterTeamContext>>;try{team=await rosterTeamContext(s,scopeIds,Object.fromEntries(url.searchParams));}catch(error){return myTeamErrorResponse(error);}
  const companies=(await allowedCompanies(s)).filter(c=>(!scopeIds.length||scopeIds.includes(c.id))&&(!team||team.scope.companyIds.includes(c.id)));
  const asked=url.searchParams.get('companyId');
  if(!companies.length||asked&&!companies.some(c=>c.id===asked))return new Response('Forbidden',{status:403,headers:{'Cache-Control':'private, no-store'}});
  const resolved=resolveRosterWindow({view:url.searchParams.get('view'),month:url.searchParams.get('month'),from:url.searchParams.get('from'),to:url.searchParams.get('to'),today:todayInKualaLumpur()});
  if(!resolved.ok)return new Response('Invalid roster date range',{status:400,headers:{'Cache-Control':'private, no-store'}});
  const win=team?rosterTeamWindow(team,todayInKualaLumpur()):resolved.window;
  const view=await rosterWindowView(s,{
    companyIds:asked?[asked]:companies.map(c=>c.id),from:win.from,to:win.to,
    businessUnitId:url.searchParams.get('bu')??undefined,departmentId:url.searchParams.get('dept')??undefined,q:url.searchParams.get('q')??undefined,
    ...(team?{employmentIds:team.scope.employmentIds}:{}),
  });
  const codeById=new Map(view.shifts.map(sh=>[sh.id,shiftCodeOf(sh)]));
  const template=buildRosterTemplate({dates:view.dates,employees:view.employees,cells:view.cells,shiftCode:id=>codeById.get(id)??''});
  return Response.json({dates:view.dates,rows:template.rows,codes:view.shifts.map(shiftCodeOf)}, {headers:{'Cache-Control':'private, no-store'}});
}
