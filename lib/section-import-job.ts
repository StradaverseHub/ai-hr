/** Section and register imports as background jobs on the shared bulk-job kernel: browser-safe kinds, progress shape
 * and states. Profile and Family files run one employee row per step (rows succeed or fail on their own, as before);
 * Qualification and Emergency Contact files stay all-or-nothing (docs/adr/2026-11-10-register-section-import-jobs.md). */
import {bulkJobActive,type BulkJobState} from './bulk-job';
import type {ImportSection,SectionImportResult} from './import-sections';

export const SECTION_IMPORT_KIND='section_import';
export const REGISTER_IMPORT_KIND='register_import';
export const SECTION_IMPORT_KINDS=[SECTION_IMPORT_KIND,REGISTER_IMPORT_KIND] as const;
/** Stable code, translated on the screen, for an import refused because the same person's import is still running. */
export const SECTION_IMPORT_ALREADY_RUNNING='section-import-already-running';
/** `worker`: whether the import service is reporting in. A queued job with no worker stays visibly queued. */
export type SectionImportJobProgress={
 id:string;kind:string;section:ImportSection;sourceName:string;state:BulkJobState;stepsTotal:number;stepsDone:number;
 /** The same result the synchronous import returned; set once the job has finished, whatever its outcome. */
 result:SectionImportResult|null;
 updatedAt:string;createdAt:string;worker:'running'|'unavailable';
};
export const sectionImportActive=(state:BulkJobState)=>bulkJobActive(state);
export function sectionImportPercent(job:Pick<SectionImportJobProgress,'state'|'stepsDone'|'stepsTotal'>){
 if(job.state==='completed')return 100;
 return job.stepsTotal>0?Math.min(99,Math.floor(job.stepsDone/job.stepsTotal*100)):0;
}
