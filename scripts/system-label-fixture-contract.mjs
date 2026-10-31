/** Read-only preparation/resume provenance; never imports an application or database owner.
 * Identity/liveness/grants must still be crossbound against actual canonical rows by the coordinator.
 * Mutable labels are deliberately NOT frozen by this source proof.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const SYSTEM_LABEL_FIXTURE_SOURCE_PATHS=Object.freeze([
 'scripts/system-label-fixture-contract.mjs','scripts/dev-fixture-system-labels.mts',
 'lib/system-label-definition.ts','lib/system-label-workbook.ts','lib/system-label-scope.ts',
 'db/schema.ts','db/migrations/0550_system_label_company_criteria.sql',
 'core/system-labels.ts','core/system-label-import.ts','core/admin.ts','core/profile-options.ts','core/org.ts',
 'app/(app)/admin/settings/system-labels/page.tsx','app/(app)/admin/settings/system-labels/import-actions.ts',
 'components/system-labels-grid.tsx',
 'messages/en.json','messages/ms.json','messages/zh.json','messages/ta.json','messages/th.json','messages/vi.json',
]);
/** @param {string} root */
export async function systemLabelFixtureSourceProof(root){
 if(!path.isAbsolute(root)||await fs.realpath(root)!==path.resolve(root))throw new Error('Exact nonsymlink repository root required.');
 const paths=[];let totalBytes=0;
 for(const relative of SYSTEM_LABEL_FIXTURE_SOURCE_PATHS){
  if(!/^[a-zA-Z0-9_./-]+$/.test(relative)||relative.split('/').includes('..'))throw new Error('Invalid closed source path.');
  const file=path.join(root,relative),stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>4000000||(totalBytes+=stat.size)>12000000)throw new Error('Invalid bounded fixture source file.');
  if(await fs.realpath(file)!==file)throw new Error('Symlink fixture source ancestor refused.');
  paths.push({path:relative,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')});
 }
 return {format:1,paths,sha256:createHash('sha256').update(JSON.stringify(paths)).digest('hex')};
}
