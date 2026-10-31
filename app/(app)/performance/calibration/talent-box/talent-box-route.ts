import type { PerformanceWorkspaceItem } from '@/packs/performance/service';
import { TALENT_BOX_PATH } from '@/packs/performance/onehr/tab-model';

/**
 * D-P1-27 — which Talent Box the standalone route opens, and where its Calibration tabs lead. Pure: the page passes
 * the viewer's own workspace items (getPerformanceAreaFactsAndItems), so the route can only open a session the workspace
 * already offers this viewer as a Talent Box part.
 *
 * A Talent Box part exists only at the BU, BG and Group tiers (leaderWorkspaceParts: never HOD, never final), so an
 * HOD, an employee or a crafted ?session= the viewer does not hold gets null and the page answers notFound.
 * `?axis=performance|potential` is the BG CEO's read-only per-axis list (DQ-8); at any other tier it is refused.
 *
 * The Calibration strip above the board is the area's one strip (PerformanceTabStrip, PT-X1): its gates, labels
 * and lit tab come from the registry. `targets` only re-points links this route knows better: Talent box stays on
 * this session's board, and a BG session's Performance / Potential open its own read-only lists. BU and Group
 * keep the registry's per-axis lists.
 */
export type TalentBoxTargets=Partial<Record<'calibration.performance'|'calibration.potential'|'calibration.talentBox',string>>;
type Item=Pick<PerformanceWorkspaceItem,'id'|'kind'|'cycleId'|'view'|'module'|'stage'>;
export type TalentBoxRoute<T extends Item=PerformanceWorkspaceItem>={box:T;boxes:T[];axis:'performance'|'potential'|null;targets:TalentBoxTargets;returnTo:string};

export const talentBoxPath=TALENT_BOX_PATH;
const boxTiers=new Set(['bu','bg','group']);
const isBox=(item:Item)=>item.kind==='calibration'&&item.module==='cal'&&item.stage==='talent_box'&&boxTiers.has(item.view);

export function talentBoxHref(sessionId:string,axis?:'performance'|'potential'){
 return `${talentBoxPath}?${new URLSearchParams({session:sessionId,...(axis?{axis}:{})})}`;
}

/** The Talent Box sessions the viewer holds (open boards this route would open), for links into it. */
export function talentBoxSessionIds(items:readonly Item[]):Set<string>{
 return new Set(items.filter(isBox).map(item=>item.id));
}

export function talentBoxRoute<T extends Item>(items:readonly T[],query:{session?:string;axis?:string}):TalentBoxRoute<T>|null{
 const boxes=items.filter(isBox);
 const box=query.session===undefined?boxes[0]:boxes.find(item=>item.id===query.session);
 if(!box)return null;
 const axis=query.axis==='performance'||query.axis==='potential'?query.axis:null;
 if(query.axis!==undefined&&!axis||axis&&box.view!=='bg')return null;
 const targets:TalentBoxTargets=box.view==='bg'
  ?{'calibration.performance':talentBoxHref(box.id,'performance'),'calibration.potential':talentBoxHref(box.id,'potential'),'calibration.talentBox':talentBoxHref(box.id)}
  :{'calibration.talentBox':talentBoxHref(box.id)};
 // Locks and person-panel saves come back to this board (assessmentReturnPath accepts the route).
 return {box,boxes,axis,targets,returnTo:talentBoxHref(box.id)};
}
