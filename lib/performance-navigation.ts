import { TEAM_REVIEW_PATH, WORKSPACE_TAB_PATHS } from '../packs/performance/onehr/tab-route-model';
import { TALENT_BOX_PATH } from '../packs/performance/onehr/tab-model';

/**
 * Where a save may return: the assessment workspace, a Performance & Talent tab route that renders it
 * (D-P1-32 PT-X2), Team PM's per-review route, or the standalone Talent Box (PT-TB), whose board's locks and
 * person-panel saves come back to the same session's board (its `session` selector is kept there only). Only a
 * small set of scalar selectors is kept; never an arbitrary redirect. The pathname must be one of these exactly,
 * followed by a query.
 */
const RETURN_PATHS = new Set(['/performance/workspace', ...WORKSPACE_TAB_PATHS, TALENT_BOX_PATH]);
const SELECTORS = ['cycle', 'view', 'module', 'review', 'feedback', 'calibration', 'stage'];
const TALENT_BOX_SELECTORS = ['session'];
export function assessmentReturnPath(raw:unknown,fallback:string):string {
 if(typeof raw!=='string'||!raw.startsWith('/')||raw.startsWith('//'))return fallback;
 const input=new URL(raw,'https://local.invalid'),params=new URLSearchParams();
 const path=input.pathname;
 if(input.origin!=='https://local.invalid'||!(RETURN_PATHS.has(path)||TEAM_REVIEW_PATH.test(path))||!raw.startsWith(`${path}?`))return fallback;
 for(const key of path===TALENT_BOX_PATH?TALENT_BOX_SELECTORS:SELECTORS){
  const value=input.searchParams.get(key);if(value&&value.length<=100)params.set(key,value);
 }
 return `${path}?${params}`;
}
