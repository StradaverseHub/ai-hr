/** Qualification assessment, not a release witness or a production SLO. */
export type UnicodeCostEvidence={visible:number;returned:number;identityFetched:number;sqlPaged:boolean;exact:boolean;
 nativeRole:string;bypassRls:boolean;readOnly:string;isolation:string;jit:string;exclusive:boolean;
 planRows:number;tempWrittenBlocks:number;bodyMaxMs:number;bodyBudgetMs:number};
export function assessUnicodeCost(e:UnicodeCostEvidence){
 const counts=[e.visible,e.returned,e.identityFetched,e.planRows,e.tempWrittenBlocks];
 if(counts.some(n=>!Number.isSafeInteger(n)||n<0)||!Number.isFinite(e.bodyMaxMs)||e.bodyMaxMs<0||!Number.isFinite(e.bodyBudgetMs)||e.bodyBudgetMs<=0
  ||typeof e.sqlPaged!=='boolean'||typeof e.exact!=='boolean'||typeof e.bypassRls!=='boolean'||typeof e.exclusive!=='boolean')throw Error('Incomplete native Unicode cost evidence');
 const gaps:string[]=[];
 if(!e.exact)gaps.push('semantic-equivalence');
 if(e.nativeRole!=='ai_hr_app'||e.bypassRls)gaps.push('native-role');
 if(e.readOnly!=='on'||e.isolation!=='repeatable read'||e.jit!=='off'||e.exclusive)gaps.push('read-carrier');
 if(e.returned>25)gaps.push('label-bound');
 if(!e.sqlPaged)gaps.push('sql-count-page');
 if(e.identityFetched>25)gaps.push('ordinary-search-identity-transfer');
 if(e.tempWrittenBlocks>0)gaps.push('temporary-spill');
 if(e.bodyMaxMs>e.bodyBudgetMs)gaps.push('diagnostic-body-budget');
 return {qualified:gaps.length===0,gaps,policy:'SQL paging/counting and representative native cost; no latency-only waiver'};
}
