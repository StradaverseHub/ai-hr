/** Actual mail readers stay complete; new default-object/data access must fail before projection. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {expect,it} from 'vitest';
import {reviewCatalogueReader} from '../deploy/security/mail-catalogue-scope';
const files=['deploy/identity-email/notification-message.ts','lib/assessment-reminder-message.ts'];
it.each(files)('accepts the actual complete six-language mail reader %s',file=>{expect(()=>reviewCatalogueReader(readFileSync(file,'utf8'),resolve(file))).not.toThrow();});
it.each(['en.common','en["workflowEmail"]','Object.keys(en)','en'])('refuses an unreviewed or opaque locale access: %s',access=>{
 const file=files[0],original=readFileSync(file,'utf8'),changed=original.replace('en:en.workflowEmail','en:'+access);expect(changed).not.toBe(original);expect(()=>reviewCatalogueReader(changed,resolve(file))).toThrow();
});
