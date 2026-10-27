import {countryPacks} from '../localization/registry';
export type EmailDisplayClock={timeZone:string;label:string};
/** Installation-wide email has no selected company. Use the installed pack's unambiguous clock. */
export function emailDisplayClock(clocks:EmailDisplayClock[]=countryPacks().flatMap(p=>p.displayClock?[p.displayClock]:[])):EmailDisplayClock{
 const zones=[...new Set(clocks.map(c=>c.timeZone))];
 return zones.length===1?clocks.find(c=>c.timeZone===zones[0])!:{timeZone:'UTC',label:'UTC'};
}
export function formatEmailTimestamp(value:string|Date,clock:EmailDisplayClock,locale='en-GB'){
 return new Intl.DateTimeFormat(locale,{timeZone:clock.timeZone,calendar:'gregory',year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value))+' '+clock.label;
}
