/** Actual-work oracle for the new single-body page, not a layout/performance receipt. */
export function exactAsciiExtraAssignmentWork(plan:unknown){
 let roots=0,probes=0;const seen=new Set<object>();
 function visit(value:unknown){
  if(!value||typeof value!=='object'||Array.isArray(value)||seen.has(value))throw Error('Invalid actual native plan tree');seen.add(value);
  const node=value as Record<string,unknown>;
  if(typeof node['Node Type']!=='string'||node['Node Type']===''||typeof node['Actual Rows']!=='number'||!Number.isFinite(node['Actual Rows'])||node['Actual Rows']<0||typeof node['Actual Loops']!=='number'||!Number.isSafeInteger(node['Actual Loops'])||node['Actual Loops']<0)throw Error('Missing actual native node work');
  if(node['Subplan Name']==='CTE employee_choice_page_assignments'){
   roots++;const rows=node['Actual Rows'],loops=node['Actual Loops'];if(typeof rows!=='number'||!Number.isFinite(rows)||rows!==0||typeof loops!=='number'||!Number.isSafeInteger(loops)||loops<0)throw Error('Extra native page Assignment rows');
  }
  if(node.Alias==='current_assignment'){
   const loops=node['Actual Loops'];if(typeof loops!=='number'||!Number.isSafeInteger(loops)||loops<0)throw Error('Missing actual page Assignment loops');probes+=loops;
  }
  if(node.Plans!==undefined){if(!Array.isArray(node.Plans))throw Error('Invalid native plan children');for(const child of node.Plans)visit(child);}
 }
 visit(plan);if(roots>1||probes!==0)throw Error('Exact native page performed extra Assignment hydration');
 return{kind:'ACTUAL_EXACT_ASCII_NO_EXTRA_PAGE_ASSIGNMENT_HYDRATION',pageAssignmentRoots:roots,extraAssignmentProbes:probes,scope:'Bulk authorized Assignment population for full unfiltered facets remains separately measured.'};
}
