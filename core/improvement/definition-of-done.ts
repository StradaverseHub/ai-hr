/** ADR-0170 §3.12 "Context and knowledge" row, step 5c — the definition of done for every product feature.
 *
 * A registry action (lib/ai/agent-action-registry.ts) or a linkable page (lib/product-context/destinations.ts
 * LINKABLE_PAGES) is done for Teras when it has:
 *  - semantic:  an entry in the semantic model (an action declared in it; a page that is an entity's page or a
 *               declared action's review route);
 *  - guide:     a bundled guide (content/guides) that links to it (its route, or for an action its review route
 *               or native screen);
 *  - readiness: where its module has a go-live setup stage (core/setup-copilot), a readiness owner that checks
 *               that stage (the co-pilot reports a stage with none as `no_owner`);
 *  - corpus:    at least one evaluation corpus turn (a turn proposing the action, a turn answered by a read whose
 *               entity lives on the page, or an evaluation case the registry names).
 * test/definition-of-done-registry.test.ts fails on any gap outside the shrink-only allowlist in
 * ./definition-of-done-gaps.ts. This module only computes; inputs are passed in so it reads no file and imports
 * nothing from test/. */

export const DONE_REQUIREMENTS=Object.freeze(['semantic','guide','readiness','corpus'] as const);
/** Private by design: no AI semantic surface. Pages listed here are exempt from the semantic and corpus requirements
 * only, because the AI must never read them; they still need a guide link (and a readiness owner where their module
 * has a setup stage), and stay linkable pages. Not a gap list: test/definition-of-done-registry.test.ts proves each
 * has no semantic entity, no read and no tool that names it, so the exemption is a guard. Each entry gives its reason. */
export const PRIVATE_BY_DESIGN:Readonly<Record<string,string>>=Object.freeze({
 '/me/cases':'ADR-0173: the AI never sees case words.',
 '/me/cases/new':'ADR-0173: the AI never sees case words.',
 '/cases':'ADR-0173: the AI never sees case words.',
 '/admin/privacy/case-handlers':'ADR-0173: the AI never sees case words.',
});
const privateByDesign=(path:string)=>Object.hasOwn(PRIVATE_BY_DESIGN,path);
export type DoneRequirement=(typeof DONE_REQUIREMENTS)[number];
export type DoneInputs=Readonly<{
 actions:readonly Readonly<{id:string;module:string;reviewRoute:string;nativeScreen:string;evaluationCases:readonly string[]}>[];
 pages:readonly Readonly<{path:string;module:string|null}>[];
 /** Declared action ids, and the pages the semantic model names (entity pages and declared review routes). */
 semanticActions:ReadonlySet<string>;semanticPages:ReadonlySet<string>;
 /** Read name → its entity's page, over every declared read. */
 readPages:ReadonlyMap<string,string>;
 guideBodies:readonly string[];
 /** Module → setup stage, and the stages no readiness owner checks. */
 moduleStages:ReadonlyMap<string,string>;stagesWithoutOwner:ReadonlySet<string>;
 corpus:readonly Readonly<{id:string;conversation:string;ideal:Readonly<{mode:string;reads?:readonly string[];action?:string}>}>[];
}>;

/** `app/leave/tracker/page.tsx` → `/leave/tracker`; route groups `(x)` drop out. */
export const routeOfScreen=(file:string):string|null=>{
 const match=/^app\/(.*?)\/?page\.tsx$/.exec(file);if(!match)return null;
 const route='/'+match[1].split('/').filter(part=>part&&!/^\(.*\)$/.test(part)).join('/');
 return route==='/'?'/':route.replace(/\/$/,'');
};
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** Whether a guide links to the route: a markdown link to it (optionally with an anchor or query), or the bare
 * path in text. The root page counts only as a link. */
export function guideReferences(body:string,route:string):boolean{
 if(new RegExp('\\]\\('+escape(route)+'(?:[#?][^)]*)?\\)').test(body))return true;
 return route!=='/'&&new RegExp('(?:^|[\\s(`"\'])'+escape(route)+'(?![A-Za-z0-9/_-])','m').test(body);
}

/** Every gap, keyed `action:<id>` or `page:<path>`, with its missing requirements in DONE_REQUIREMENTS order. */
export function definitionOfDoneGaps(inputs:DoneInputs):Readonly<Record<string,readonly DoneRequirement[]>>{
 const guided=(routes:readonly string[])=>routes.some(route=>inputs.guideBodies.some(body=>guideReferences(body,route)));
 const ready=(module:string|null)=>{const stage=module?inputs.moduleStages.get(module):undefined;return !stage||!inputs.stagesWithoutOwner.has(stage);};
 const caseIds=new Set(inputs.corpus.flatMap(turn=>[turn.id,turn.conversation]));
 const actionRoute=new Map(inputs.actions.map(action=>[action.id,action.reviewRoute]));
 const gaps:Record<string,DoneRequirement[]>={};
 const record=(key:string,met:Readonly<Record<DoneRequirement,boolean>>)=>{const missing=DONE_REQUIREMENTS.filter(requirement=>!met[requirement]);if(missing.length)gaps[key]=missing;};
 for(const action of inputs.actions){
  const screen=routeOfScreen(action.nativeScreen);
  record('action:'+action.id,{semantic:inputs.semanticActions.has(action.id),guide:guided([action.reviewRoute,...(screen?[screen]:[])]),readiness:ready(action.module),
   corpus:inputs.corpus.some(turn=>turn.ideal.mode==='propose'&&turn.ideal.action===action.id)||action.evaluationCases.some(id=>caseIds.has(id))});
 }
 for(const page of inputs.pages){
  const exempt=privateByDesign(page.path);
  record('page:'+page.path,{semantic:exempt||inputs.semanticPages.has(page.path),guide:guided([page.path]),readiness:ready(page.module),
   corpus:exempt||inputs.corpus.some(turn=>(turn.ideal.reads??[]).some(read=>inputs.readPages.get(read)===page.path)
    ||(turn.ideal.mode==='propose'&&!!turn.ideal.action&&actionRoute.get(turn.ideal.action)===page.path))});
 }
 return Object.freeze(Object.fromEntries(Object.entries(gaps).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,Object.freeze(value)])));
}
