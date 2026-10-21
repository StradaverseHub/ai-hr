import type { AttendanceWorkflowStage } from '@/lib/attendance-workflow';
import type { AttendanceV3Level } from '@/lib/attendance-workflow-v3';
import { approversOf } from '@/lib/leave-approval-kinds';
export function AttendanceWorkflowStageDescription({ stage, manager, hr, or, sequential, anyOne, depth, selectedName }: {
    stage: AttendanceWorkflowStage | AttendanceV3Level; manager: string; hr: string; or: string; sequential: string; anyOne: string;
    depth: (number: number) => string; selectedName: (id: string) => string;
}) {
    if ('level' in stage) return <>{approversOf(stage.level).map(actor => actor.kind === 'direct_manager' ? manager : hr).join(` ${or} `)}</>;
    return <div className="space-y-1"><span className="block">{stage.mode === 'sequential' ? sequential : anyOne}</span>{stage.source.kind === 'direct_manager'
        ? <span className="block">{depth(stage.source.depth)}{stage.hrAlternative ? ` ${or} ${hr}` : ''}</span>
        : <ol className="list-inside list-decimal">{stage.source.employmentIds.map(id => <li key={id}>{selectedName(id)}</li>)}</ol>}</div>;
}
