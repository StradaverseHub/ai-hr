/** Read-only effective systemd timer configuration inventory. */
import {dispatchSha256} from '../../lib/employee-master-dispatch';
export function reportTimerInventory(command:(program:string,args:string[])=>string,inspect:(source:string,scope:string)=>void){
 const entries:[string,string][]=[];
 const timerNames=command('systemctl',['list-unit-files','--type=timer','--no-legend','--no-pager']).split('\n').filter(Boolean).map(line=>line.trim().split(/\s+/)[0]).sort();if(timerNames.length>1000)throw new Error('Timer inventory exceeds reviewed bound.');
 for(const timer of timerNames){if(!/^[-a-zA-Z0-9_.@\\]+\.timer$/.test(timer))throw new Error('Unknown timer unit.');const body=command('systemctl',['cat',timer]);inspect(body,timer);entries.push(['timer:'+timer,dispatchSha256(body)]);const target=command('systemctl',['show',timer,'--property=Triggers','--value']).trim().split(/\s+/).filter(Boolean);for(const service of target){if(!/^[-a-zA-Z0-9_.@\\]+\.service$/.test(service))throw new Error('Unknown timer target.');const contents=command('systemctl',['cat',service]);inspect(contents,service);entries.push(['timer-service:'+service,dispatchSha256(contents)]);}}
 return entries;
}
