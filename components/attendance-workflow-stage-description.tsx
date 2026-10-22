import type { AttendanceWorkflowStage } from '@/lib/attendance-workflow';
import type { AttendanceV3Level } from '@/lib/attendance-workflow-v3';
import type {AttendanceV4Level} from '@/lib/attendance-workflow-v4';
import { approversOf } from '@/lib/leave-approval-kinds';
export function AttendanceWorkflowStageDescription({ stage, manager, hr, or, sequential, anyOne, allRequired, depth, selectedName }: {
    stage: AttendanceWorkflowStage | AttendanceV3Level | AttendanceV4Level; manager: string; hr: string; or: string; sequential: string; anyOne: string; allRequired?:string;
    depth: (number: number) => string; selectedName: (id: string) => string;
}) {
    if ('level' in stage) return <>{approversOf(stage.level).map(actor => actor.kind === 'direct_manager' ? manager : hr).join(` ${or} `)}</>;
    const sources='sources' in stage?stage.sources:[stage.source];
    return <div className="space-y-1"><span className="block">{stage.mode==='all_required'?allRequired:stage.mode==='sequential'?sequential:anyOne}</span><ol className="space-y-1">{sources.map((source,index)=><li key={index}>{source.kind==='direct_manager'?depth(source.depth):<ol className="list-inside list-decimal">{source.employmentIds.map(id=><li key={id}>{selectedName(id)}</li>)}</ol>}</li>)}</ol>{stage.hrAlternative&&<span className="block">{or} {hr}</span>}</div>;
}
