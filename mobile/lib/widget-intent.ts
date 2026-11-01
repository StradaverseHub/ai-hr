/** A widget can suggest a direction only. It cannot supply an employee, time, location, proof or command. */
export type ClockWidgetAction='in'|'out';
export type WidgetScope={namespace:string;employmentId:string|null};
export function clockWidgetAction(url:string):ClockWidgetAction|null{
 try{const u=new URL(url);if(u.protocol!=='aihr:'||u.hostname!=='clock'||u.pathname!==''&&u.pathname!=='/'||u.username||u.password||u.port||u.hash)return null;
  if([...u.searchParams.keys()].some(k=>k!=='action')||u.searchParams.getAll('action').length!==1)return null;
  const action=u.searchParams.get('action');return action==='in'||action==='out'?action:null;
 }catch{return null;}
}
export function createWidgetIntentStore(){
 let pending:{action:ClockWidgetAction;scope:WidgetScope;at:number}|null=null;
 return {
  capture(url:string,scope:WidgetScope,now:number){const action=clockWidgetAction(url);if(!action)return false;pending={action,scope:{...scope},at:now};return true;},
  take(scope:WidgetScope,now:number):ClockWidgetAction|null{const p=pending;pending=null;if(!p||now<p.at||now-p.at>5*60_000||scope.namespace!==p.scope.namespace||p.scope.employmentId!==null&&scope.employmentId!==p.scope.employmentId)return null;return p.action;},
  clear(){pending=null;},
 };
}
export const widgetIntents=createWidgetIntentStore();
