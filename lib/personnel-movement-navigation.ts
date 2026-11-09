export type MovementPageMode='history'|'new'|'correct-hire'|'edit'|'view';
export type MovementPageContext={showCorrected?:string;from?:string};
export function movementHistoryHref(employmentId:string,context:MovementPageContext={}){
 const query=new URLSearchParams({tab:'careerMovement'});
 if(context.showCorrected==='1')query.set('showCorrected','1');
 if(context.from==='org')query.set('from','org');
 return `/admin/personnel/${encodeURIComponent(employmentId)}?${query}#section-assignment-history`;
}
export function movementPageHref(employmentId:string,mode:MovementPageMode,eventId?:string,context:MovementPageContext={}){
 const path=`/admin/personnel/${encodeURIComponent(employmentId)}/movement/${mode}${mode==='edit'||mode==='view'?`/${encodeURIComponent(eventId??'')}`:''}`;
 const query=new URLSearchParams();
 if(context.showCorrected==='1')query.set('showCorrected','1');
 if(context.from==='org')query.set('from','org');
 return path+(query.size?`?${query}`:'');
}
