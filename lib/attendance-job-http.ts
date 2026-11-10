/** JSON responses of the attendance background-job routes (draft 9940). A refusal carries its code; anything else
 * is a plain sentence, never SQL or a cell value. Server only. */
export function attendanceJobJson(body:unknown){return Response.json(body,{headers:{'Cache-Control':'private, no-store'}});}
export function attendanceJobHttpError(error:unknown){
 const refusal=error as {name?:string;code?:string;status?:number};
 if(refusal?.name==='ClockingImportJobRefused'||refusal?.name==='RecomputeJobRefused')
  return Response.json({error:refusal.code},{status:refusal.status??400,headers:{'Cache-Control':'private, no-store'}});
 return Response.json({error:'The job could not be read. Reopen this page to see its progress.'},{status:500,headers:{'Cache-Control':'private, no-store'}});
}
