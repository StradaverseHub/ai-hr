/** Read-only effective systemd timer configuration inventory. */
import {dispatchSha256} from '../../lib/employee-master-dispatch';
export function reportTimerInventory(command:(program:string,args:string[])=>string,inspect:(source:string,scope:string)=>void){
 const entries:[string,string][]=[];
 const names=(source:string)=>source.split('\n').map(line=>line.trim()).filter(Boolean).map(line=>line.split(/\s+/)[0]);
 const files=names(command('systemctl',['list-unit-files','--type=timer','--no-legend','--no-pager']));
 const loaded=names(command('systemctl',['list-units','--all','--type=timer','--plain','--no-legend','--no-pager']));
 if(files.length>1000||loaded.length>1000)throw new Error('Timer inventory exceeds reviewed bound.');
 const timers=new Set([...files,...loaded]);
 for(const timer of timers)if(!/^[-a-zA-Z0-9_.\\]+(?:@[-a-zA-Z0-9_.\\]*)?\.timer$/.test(timer))throw new Error('Unknown timer unit.');
 // Plan these instances before show can load them, keeping the first and repeated inventory equal.
 for(const timer of [...timers])if(timer.endsWith('@.timer'))timers.add(timer.slice(0,-'.timer'.length)+'aihr-report-inventory.timer');
 if(timers.size>1000)throw new Error('Timer inventory exceeds reviewed bound.');
 const services=new Set<string>();
 for(const timer of [...timers].sort()){
  const body=command('systemctl',['cat',timer]);inspect(body,timer);entries.push(['timer:'+timer,dispatchSha256(body)]);
  if(timer.endsWith('@.timer'))continue; // Its planned concrete instance supplies runtime metadata.
  const targets=command('systemctl',['show',timer,'--property=Triggers','--value']).trim().split(/\s+/).filter(Boolean);
  for(const service of targets){if(!/^[-a-zA-Z0-9_.\\]+(?:@[-a-zA-Z0-9_.\\]+)?\.service$/.test(service))throw new Error('Unknown timer target.');services.add(service);}
 }
 for(const service of [...services].sort()){
  const contents=command('systemctl',['cat',service]);inspect(contents,service);entries.push(['timer-service:'+service,dispatchSha256(contents)]);
 }
 return entries;
}
