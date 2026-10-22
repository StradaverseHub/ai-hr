import type { AttendanceResolvedStage } from '@/lib/attendance-workflow';

/** Shared saved/detail and draft preview. Accepts only the authorized server resolver's projection. */
export function AttendanceResolvedRoutePreview({ stages, routingVersion, levelName, hrLabel, alternativeLabel, sequentialLabel, anyOneLabel, allRequiredLabel, depthLabel }: {
    stages: AttendanceResolvedStage[];
    routingVersion: 1 | 2 | 3 | 4;
    levelName: (number: number) => string;
    hrLabel: string;
    alternativeLabel: string;
    sequentialLabel?: string;
    anyOneLabel?: string;
    allRequiredLabel?:string;
    depthLabel?: (depth: number) => string;
}) {
    if (!stages.length) return null;
    return <ol className="mt-2 space-y-2 border-l-2 border-border pl-3 text-sm">
        {stages.map((stage, index) => <li key={index} className="break-words">
            <span className="font-medium">{routingVersion !== 1 ? levelName(index + 1) : stage.name}</span>
            {(routingVersion === 3 || routingVersion === 4) ? <div className="space-y-1 text-muted-foreground"><p>{stage.mode === 'all_required' ? allRequiredLabel : stage.mode === 'sequential' ? sequentialLabel : anyOneLabel}{stage.source?.kind === 'direct_manager' && depthLabel ? ` · ${depthLabel(stage.source.depth)}` : ''}</p><ol className="list-inside list-decimal">{stage.approvers.map((actor, actorIndex) => <li key={actor.slot ?? actorIndex}>{actor.kind === 'hr_admin' ? hrLabel : actor.name}</li>)}</ol>{stage.hrAlternative && <p>{alternativeLabel} {hrLabel}</p>}</div>
                : <span className="block text-muted-foreground">{stage.approvers.map(approver => approver.kind === 'hr_admin' ? hrLabel : approver.name).join(` ${alternativeLabel} `)}</span>}
        </li>)}
    </ol>;
}
