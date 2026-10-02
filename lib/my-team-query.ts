/** URL state only: authorization and calendar/status/balance facts belong to the My Team model. */
import type {MyTeamQuery,MyTeamTile} from './my-team-types';
import {addDaysIso,addMonths} from './roster-month';
export type MyTeamActionError = 'stale_context'|'not_authorized'|'request_changed'|'review_changed'|'invalid_query'|'failed';
export type MyTeamActionResult = {ok:true}|{ok:false;error:MyTeamActionError};
export class MyTeamQueryError extends Error {constructor(){super('MY_TEAM_QUERY_INVALID');this.name='MyTeamQueryError';}}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tiles:readonly MyTeamTile[]=['members','checked_in','late','absent','on_leave','pending_approvals'];
const date=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
export function parseMyTeamQuery(params:URLSearchParams):MyTeamQuery {
 const view=params.get('view')??'week',scope=params.get('scope')??'direct';
 if(!['week','month'].includes(view)||!['direct','all','department'].includes(scope))throw new MyTeamQueryError();
 const anchorDate=params.get('anchorDate')||undefined,departmentId=params.get('departmentId')||undefined,employmentId=params.get('employmentId')||undefined;
 const companyIds=params.getAll('companyIds');const search=params.get('search')?.trim()||undefined,tile=params.get('tile')||undefined;
 if(anchorDate&&!date(anchorDate)||departmentId&&!uuid.test(departmentId)||employmentId&&!uuid.test(employmentId)||companyIds.length>50||companyIds.some(id=>!uuid.test(id))||(search?.length??0)>100||tile&&!tiles.includes(tile as MyTeamTile))throw new MyTeamQueryError();
 const layerText=params.get('layers');let layers:MyTeamQuery['layers'];
 if(layerText!==null){const names=layerText?layerText.split(','):[];if(names.some(name=>!['roster','attendance','leave'].includes(name))||new Set(names).size!==names.length)throw new MyTeamQueryError();layers={roster:names.includes('roster'),attendance:names.includes('attendance'),leave:names.includes('leave')};}
 return {view:view as MyTeamQuery['view'],scope:scope as MyTeamQuery['scope'],...(anchorDate?{anchorDate}:{}),...(companyIds.length?{companyIds:[...new Set(companyIds)]}:{}),...(departmentId?{departmentId}:{}),...(employmentId?{employmentId}:{}),...(search?{search}:{}),...(tile?{tile:tile as MyTeamTile}:{}),...(layers?{layers}:{})};
}
export function serializeMyTeamQuery(query:MyTeamQuery):URLSearchParams {
 const params=new URLSearchParams({view:query.view,scope:query.scope});
 for(const key of ['anchorDate','departmentId','employmentId','search','tile'] as const)if(query[key])params.set(key,query[key]!);
 for(const id of query.companyIds??[])params.append('companyIds',id);
 if(query.layers)params.set('layers',(['roster','attendance','leave'] as const).filter(key=>query.layers![key]).join(','));
 return params;
}
export function stepMyTeamAnchor(query:MyTeamQuery,delta:-1|1):string {
 if(!query.anchorDate||!date(query.anchorDate))throw new MyTeamQueryError();
 return query.view==='week'?addDaysIso(query.anchorDate,delta*7):addMonths(query.anchorDate.slice(0,7),delta)+'-01';
}
