/** Exact migration SQL reused with disposable benchmark names; no second parser owner. */
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../db/migrations/0887_attendance_task_candidate_access.sql',import.meta.url),'utf8');
const start=source.indexOf('CREATE FUNCTION app.attendance_frozen_actor_identity_keys(');
const end=source.indexOf('CREATE INDEX',start);
if(start<0||end<start)throw Error('Missing native frozen-actor projection');
export const actorIdentityKeysSql=source.slice(start,end).replaceAll('attendance_frozen_actor_identity_keys','perf_actor_identity_keys');
