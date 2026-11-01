/** Closed UI/port contract. No host, command, unit name or environment can come from a form. */
import {z} from 'zod';
import catalog from '../deploy/runner-control/catalog.json';
export const RUNNERS=catalog;
export const runnerChangeSchema=z.object({
 id:z.string().refine(id=>RUNNERS.some(row=>row.id===id)),
 revision:z.string().regex(/^[a-f0-9]{64}$/),enabled:z.boolean(),
 schedule:z.union([z.object({minutes:z.number().int().min(1).max(1440)}).strict(),z.object({time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)}).strict()]).nullable(),
}).strict();
export type RunnerChange=z.infer<typeof runnerChangeSchema>;
const runnerStatus=z.object({id:z.string(),managed:z.boolean(),hold:z.boolean(),note:z.string().max(300),installed:z.boolean(),enabled:z.boolean(),health:z.enum(['missing','running','failed','unknown','success','stale','stopped']),running:z.boolean(),lastRun:z.string().nullable(),nextRun:z.string().nullable(),schedule:z.string().nullable(),revision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type RunnerStatus=z.infer<typeof runnerStatus>;
export const runnerSnapshotSchema=z.object({environment:z.enum(['staging','production']),checkedAt:z.string(),runners:z.array(runnerStatus).length(RUNNERS.length)}).strict().refine(value=>new Set(value.runners.map(row=>row.id)).size===RUNNERS.length&&value.runners.every(row=>RUNNERS.some(entry=>entry.id===row.id)));
export type RunnerSnapshot=z.infer<typeof runnerSnapshotSchema>;
export type RunnerActionState={ok:boolean;error:string|null};
