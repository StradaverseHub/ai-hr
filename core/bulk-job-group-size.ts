/** ADR 0181 J2 — the size of the next set-based group of a bulk job, from the groups it has measured.
 *
 * One pass of a set-based step has a fixed cost F whatever its size (its group-wide reads and checks) plus a cost m per
 * member. Two passes of different sizes give F and m (a straight line); the next group then fills
 * max(targetMs, fixedMultiple x F), so the fixed cost is spread over a group instead of paid per member while a chunk
 * (and the keys it holds) stays bounded. Until two such passes exist, or when they do not give a rising line, the size
 * doubles. Always 2..max, and at most double the last group. Used by the selective reprocess
 * (core/payroll-reprocess-job.ts) and payroll processing (core/payroll-processing-job.ts). */
export type GroupPass={employees:number;wallMs:number};
export function nextGroupSize(seen:readonly GroupPass[],last:number,limits:{max:number;targetMs:number;fixedMultiple:number}){
 const max=Math.max(2,limits.max),grow=Math.max(2,Math.min(max,last*2));
 const [a,b]=seen.slice(-2);
 if(!a||!b||a.employees===b.employees)return grow;
 const perEmployee=(b.wallMs-a.wallMs)/(b.employees-a.employees);
 if(!(perEmployee>0))return grow;
 const fixed=Math.max(0,b.wallMs-b.employees*perEmployee);
 const target=Math.max(limits.targetMs,limits.fixedMultiple*fixed);
 return Math.max(2,Math.min(grow,Math.floor((target-fixed)/perEmployee)));
}
/** The last two passes of different sizes (a pass of a size already seen replaces it). */
export function rememberGroupPass(seen:readonly GroupPass[],pass:GroupPass):GroupPass[]{
 return [...seen.filter(p=>p.employees!==pass.employees),pass].slice(-2);
}
/** Process CPU since `cpuStarted` (the calculation and the driver) and the rest of the wall time (the database). */
export function splitChunkTime(started:number,cpuStarted:NodeJS.CpuUsage){
 const cpu=process.cpuUsage(cpuStarted),wallMs=performance.now()-started,calcMs=(cpu.user+cpu.system)/1000;
 return {wallMs,calcMs,dbMs:Math.max(0,wallMs-calcMs)};
}
