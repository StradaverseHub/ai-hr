/** AI v2 P2-2a — calendar helpers the payroll-cycle loops share (a leaf: no imports, so the Today cards can use them). */
export const PAYROLL_INPUTS_LEAD_DAYS=7;
const DAY_MS=86_400_000;
/** Whole days from one HR date (yyyy-mm-dd) to another. */
export const daysBetween=(from:string,to:string)=>Math.round((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/DAY_MS);
export const nextPeriod=(period:string)=>{const y=Number(period.slice(0,4)),m=Number(period.slice(5,7));return m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,'0')}`;};
export const previousPeriod=(period:string)=>{const y=Number(period.slice(0,4)),m=Number(period.slice(5,7));return m===1?`${y-1}-12`:`${y}-${String(m-1).padStart(2,'0')}`;};
