/** Input readiness shared by the creation form and authoritative server create operation. */
export function rewardReviewInputIssues(input:{year:number;snapshotDate:string;today:string;cycleId:string;name:string}){
 const issues:('year'|'snapshotMissing'|'snapshotFuture'|'cycleName')[]=[];
 if(!Number.isInteger(input.year)||input.year<2000||input.year>2200)issues.push('year');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(input.snapshotDate)||Number.isNaN(Date.parse(input.snapshotDate))||new Date(input.snapshotDate).toISOString().slice(0,10)!==input.snapshotDate)issues.push('snapshotMissing');
 else if(input.snapshotDate>input.today)issues.push('snapshotFuture');
 if(!input.cycleId&&(!input.name.trim()||input.name.trim().length>160))issues.push('cycleName');
 return issues;
}
