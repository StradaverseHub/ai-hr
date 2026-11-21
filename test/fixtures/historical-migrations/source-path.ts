/** Paths only. Both callers independently admit their whole historical739 journal.
 * Exactly two superseded payloads are archived; no IO or existence fallback. */
export function historicalMigrationSourcePath(tag:unknown):string{
 if(typeof tag!=='string'||tag.length===0||tag.length>180)throw new TypeError('Invalid historical migration tag');
 const match=/^[0-9]{4}_[a-z0-9_]+$/.exec(tag);
 if(!match||match[0]!==tag)throw new TypeError('Invalid historical migration tag');
 switch(tag){
  case '2301_attendance_workflow_submission_shared_lock':return 'test/fixtures/historical-migrations/2301_attendance_workflow_submission_shared_lock.sql';
  case '3103_access_editor_presentation':return 'test/fixtures/historical-migrations/3103_access_editor_presentation.sql';
  default:return 'db/migrations/'+tag+'.sql';
 }
}
