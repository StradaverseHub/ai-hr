/** Fixed navigation into the EXISTING Employee Master Import workbench. This is not an import
 * preparation, execution capability, provider packet or claim that the caller may import.
 *
 * The page resolves its actual session/admin gate and RLS-scoped company/catalogue choices.
 * Native validation and commit independently re-read Workforce view/maintain authority and source
 * facts. Local messy-sheet/paste preparation, original evidence, manual ambiguity resolution and
 * separately consented HEADER-ONLY proposals remain in that workflow; the human still previews
 * and explicitly commits through the canonical importer. No source values travel in this handoff.
 */
import {z} from 'zod';
export const EMPLOYEE_IMPORT_HUMAN_HANDOFF_SCHEMA=z.object({
 module:z.literal('employees'),
 action:z.literal('employees.import'),
 route:z.literal('/admin/personnel/import'),
 requiresHumanSelection:z.literal(true),
 effect:z.literal('none'),
 authority:z.literal('rechecked_on_import_page'),
}).strict();
export type EmployeeImportHumanHandoff=Readonly<z.infer<typeof EMPLOYEE_IMPORT_HUMAN_HANDOFF_SCHEMA>>;
const handoff:EmployeeImportHumanHandoff=Object.freeze(EMPLOYEE_IMPORT_HUMAN_HANDOFF_SCHEMA.parse({
 module:'employees',action:'employees.import',route:'/admin/personnel/import',
 requiresHumanSelection:true,effect:'none',authority:'rechecked_on_import_page',
}));
/** No selector, URL, rows, headings, dataset, source, mode, company, grant or model arguments. */
export function employeeImportHumanHandoff():EmployeeImportHumanHandoff{
 if(arguments.length!==0)throw Error('Employee import navigation unavailable.');
 return handoff;
}
/** A model cannot widen this literal destination or turn it into prepare/confirm/commit. Return the
 * canonical frozen tuple rather than retaining a caller-owned object or its prototype. */
export function checkedEmployeeImportHumanHandoff(value:unknown):EmployeeImportHumanHandoff{
 EMPLOYEE_IMPORT_HUMAN_HANDOFF_SCHEMA.parse(value);
 return handoff;
}
