export type RewardDashboardPreference={period:'monthly'|'annual';scope:string};
export function rewardDashboardPreference(raw:unknown,units:readonly {id:string;roles:readonly string[]}[]):RewardDashboardPreference{
 const value=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
 const allowAll=units.length>0&&units.every(unit=>unit.roles.some(role=>['gr','ctro','ec'].includes(role)));
 const scope=typeof value.scope==='string'&&(units.some(unit=>unit.id===value.scope)||value.scope==='all'&&allowAll)?value.scope:units[0]?.id??'';
 return {period:value.period==='annual'?'annual':'monthly',scope};
}
/** Only salary is a recurring monthly amount. Bonus is a one-off award in both views. */
export function rewardSalaryDisplay(cents:number,period:'monthly'|'annual'){
 const value=cents*(period==='annual'?12:1);if(!Number.isSafeInteger(value))throw Error('Reward display exceeds supported amount.');return value;
}
