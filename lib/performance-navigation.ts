import { TEAM_REVIEW_PATH, WORKSPACE_TAB_PATHS } from '../packs/performance/onehr/tab-route-model';

/**
 * Where a save may return: the assessment workspace, a Performance & Talent tab route that renders it
 * (D-P1-32 PT-X2), or Team PM's per-review route. Only a small set of scalar selectors is kept; never an
 * arbitrary redirect. The pathname must be one of these exactly, followed by a query.
 */
const RETURN_PATHS = new Set(['/performance/workspace', ...WORKSPACE_TAB_PATHS]);
export function assessmentReturnPath(raw:unknown,fallback:string):string {
 if(typeof raw!=='string'||!raw.startsWith('/')||raw.startsWith('//'))return fallback;
 const input=new URL(raw,'https://local.invalid'),params=new URLSearchParams();
 const path=input.pathname;
 if(input.origin!=='https://local.invalid'||!(RETURN_PATHS.has(path)||TEAM_REVIEW_PATH.test(path))||!raw.startsWith(`${path}?`))return fallback;
 for(const key of ['cycle','view','module','review','feedback','calibration','stage']){
  const value=input.searchParams.get(key);if(value&&value.length<=100)params.set(key,value);
 }
 return `${path}?${params}`;
}
