/** Exact bounded cent allocation for one immutable period result over proved dated OT minutes.
 * All source minutes remain one physical claim; these allocations are monetary evidence only. */
export function allocateAttendanceFormulaCents(amount:string,weights:readonly number[]){
 if(!/^\d{1,12}$/.test(amount)||!weights.length||weights.length>186||weights.some(n=>!Number.isSafeInteger(n)||n<0||n>4320))throw Error('Invalid bounded overtime allocation.');
 const total=weights.reduce((n,w)=>n+BigInt(w),BigInt(0));if(total===BigInt(0))throw Error('Positive approved positioned overtime coverage is required.');
 const cents=BigInt(amount),rows=weights.map((w,i)=>({i,value:cents*BigInt(w)/total,remainder:cents*BigInt(w)%total}));
 let rest=cents-rows.reduce((n,row)=>n+row.value,BigInt(0));
 for(const row of [...rows].sort((a,b)=>a.remainder===b.remainder?a.i-b.i:a.remainder>b.remainder?-1:1)){if(!rest)break;row.value++;rest--;}
 return rows.map(row=>row.value.toString());
}
