import type { AllowanceExpression, AllowanceExpressionTrace } from '@/lib/attendance-allowance-expression';

type Labels = { all:string; any:string; unrestricted:string; unknown:string; pass:string; fail:string; unknownMeasurement:string; allLeaveTypes:string; leaveTypes:string; metrics:Record<string,string>; operators:Record<string,string>; units:Record<string,string> };
export type AllowanceExpressionLabels = Labels;
/** Shared, bracketed definition and evaluated tree; no client-only callbacks cross this boundary. */
export function AllowanceExpressionView({node,labels,leaveTypes=[],trace=false}:{node:AllowanceExpression|AllowanceExpressionTrace;labels:Labels;leaveTypes?:{id:string;label:string}[];trace?:boolean}) {
  const result='state' in node?node.state:undefined;
  const verdict=result==='unknown'?labels.unknown:result==='true'?labels.pass:labels.fail;
  return <div className="space-y-2">
    {node.type==='group'?<>
      <p className="text-sm font-medium">{node.logic==='and'?labels.all:labels.any}{trace&&result&&<span className="ml-2 text-xs text-muted-foreground">· {verdict}</span>}</p>
      {node.children.length?<div className="space-y-3 border-l-2 border-border pl-4">{node.children.map(child=><AllowanceExpressionView key={child.id} node={child} labels={labels} leaveTypes={leaveTypes} trace={trace}/>)}</div>:<p className="text-sm text-muted-foreground">{labels.unrestricted}</p>}
    </>:<div className="space-y-1 text-sm">
      <p>{labels.metrics[node.field]} {labels.operators[node.operator]} {node.value}{node.operator==='between'?` – ${node.upper??'—'}`:''} {labels.units[node.unit]}</p>
      {(node.field==='leaveCount'||node.field==='leaveDays')&&<p className="text-xs text-muted-foreground">{labels.leaveTypes}: {node.leaveTypeIds?.length?node.leaveTypeIds.map(id=>leaveTypes.find(type=>type.id===id)?.label??id).join(', '):labels.allLeaveTypes}</p>}
      {trace&&'actual' in node&&<p className={result==='unknown'?'text-amber-700 dark:text-amber-300':'text-muted-foreground'}>{node.actual==null?labels.unknown:`${node.actual} ${labels.units[node.actualUnit]}`} · {verdict}{node.reason?` · ${labels.unknownMeasurement}`:''}</p>}
    </div>}
  </div>;
}
