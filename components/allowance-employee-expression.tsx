import type { AllowanceEmployeeExpression } from '@/lib/allowance-employee-expression';
export function AllowanceEmployeeExpressionView({node,labels,valueLabel}:{
  node:AllowanceEmployeeExpression;
  labels:{fields:Record<string,string>;operators:Record<string,string>;and:string;or:string};
  valueLabel:(field:string,value:string)=>string;
}) {
  if(node.type==='criterion')return <p className="text-sm"><span className="font-medium">{labels.fields[node.field]}</span> {labels.operators[node.operator]} {node.values.map(value=>valueLabel(node.field,value)).join(', ')}</p>;
  return <div className="space-y-2 rounded-lg border border-border p-3"><p className="text-xs font-semibold">{node.logic==='and'?labels.and:labels.or}</p><div className="space-y-2">{node.children.map(child=><AllowanceEmployeeExpressionView key={child.id} node={child} labels={labels} valueLabel={valueLabel}/>)}</div></div>;
}
