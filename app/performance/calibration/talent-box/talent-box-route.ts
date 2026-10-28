import type { PerformanceWorkspaceItem } from '@/packs/performance/service';

/**
 * D-P1-27 — which Talent Box the standalone route opens, and where its Calibration tabs lead. Pure: the page passes
 * the viewer's own workspace items (performanceWorkspace), so the route can only open a session the workspace
 * already offers this viewer as a Talent Box part.
 *
 * A Talent Box part exists only at the BU, BG and Group tiers (leaderWorkspaceParts: never HOD, never final), so an
 * HOD, an employee or a crafted ?session= the viewer does not hold gets null and the page answers notFound.
 * `?axis=performance|potential` is the BG CEO's read-only per-axis list (DQ-8); at any other tier it is refused.
 */
export type TalentBoxTab={id:'performance'|'potential'|'box';href:string;active:boolean};
type Item=Pick<PerformanceWorkspaceItem,'id'|'kind'|'cycleId'|'view'|'module'|'stage'>;
export type TalentBoxRoute<T extends Item=PerformanceWorkspaceItem>={box:T;boxes:T[];axis:'performance'|'potential'|null;tabs:TalentBoxTab[];returnTo:string};

export const talentBoxPath='/performance/calibration/talent-box';
const boxTiers=new Set(['bu','bg','group']);
const isBox=(item:Item)=>item.kind==='calibration'&&item.module==='cal'&&item.stage==='talent_box'&&boxTiers.has(item.view);

/** The workspace URL of one calibration part: the same shape the workspace builds for its own links. */
export function talentBoxWorkspaceHref(item:Item){
 return `/performance/workspace?${new URLSearchParams({cycle:item.cycleId,view:item.view,module:item.module,stage:item.stage,calibration:item.id})}`;
}
export function talentBoxHref(sessionId:string,axis?:'performance'|'potential'){
 return `${talentBoxPath}?${new URLSearchParams({session:sessionId,...(axis?{axis}:{})})}`;
}

export function talentBoxRoute<T extends Item>(items:readonly T[],query:{session?:string;axis?:string}):TalentBoxRoute<T>|null{
 const boxes=items.filter(isBox);
 const box=query.session===undefined?boxes[0]:boxes.find(item=>item.id===query.session);
 if(!box)return null;
 const axis=query.axis==='performance'||query.axis==='potential'?query.axis:null;
 if(query.axis!==undefined&&!axis||axis&&box.view!=='bg')return null;
 // Per-axis work of the same session stays where it is today: the workspace part (BU, Group) or the BG list.
 const part=(stage:string)=>{const item=items.find(i=>i.kind==='calibration'&&i.id===box.id&&i.stage===stage);return item?talentBoxWorkspaceHref(item):null;};
 const performance=box.view==='bg'?talentBoxHref(box.id,'performance'):part(box.view==='group'?'group_calibration':'calibration');
 // The Group tier has no potential part; the BU potential part is its own workspace stage.
 const potential=box.view==='bg'?talentBoxHref(box.id,'potential'):box.view==='bu'?part('potential_calibration'):null;
 const tabs:TalentBoxTab[]=[
  ...(performance?[{id:'performance' as const,href:performance,active:axis==='performance'}]:[]),
  ...(potential?[{id:'potential' as const,href:potential,active:axis==='potential'}]:[]),
  {id:'box',href:talentBoxHref(box.id),active:axis===null},
 ];
 return {box,boxes,axis,tabs,returnTo:talentBoxWorkspaceHref(box)};
}
