import type { AttendanceResolvedStage } from '@/lib/attendance-workflow';

/** Shared saved/detail and draft preview. Accepts only the authorized server resolver's projection. */
export function AttendanceResolvedRoutePreview({ stages, routingVersion, levelName, hrLabel, alternativeLabel }: {
    stages: AttendanceResolvedStage[];
    routingVersion: 1 | 2;
    levelName: (number: number) => string;
    hrLabel: string;
    alternativeLabel: string;
}) {
    if (!stages.length) return null;
    return <ol className="mt-2 space-y-2 border-l-2 border-border pl-3 text-sm">
        {stages.map((stage, index) => <li key={index} className="break-words">
            <span className="font-medium">{routingVersion === 2 ? levelName(index + 1) : stage.name}</span>
            <span className="block text-muted-foreground">{stage.approvers.map(approver => approver.kind === 'hr_admin' ? hrLabel : approver.name).join(` ${alternativeLabel} `)}</span>
        </li>)}
    </ol>;
}
