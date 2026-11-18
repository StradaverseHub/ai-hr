/** Actual handler identities and hooks must survive the public pack boundary. No job is admitted. */
import {expect,it} from 'vitest';
import * as facade from '../packs/lifecycle/service';
import {lifecycleManagerRecoveryHandler} from '../core/lifecycle-manager-recovery';
import {lifecyclePersonnelCompletionPreviewHandler,lifecyclePersonnelCompletionRecoveryHandler} from '../core/lifecycle-personnel-completion-recovery';
import {v9PersonnelWritableKeys} from '../lib/lifecycle-v9-personnel-keys';
it('exports the original recovery owners rather than copying or omitting their hooks',()=>{
 expect(facade.lifecycleManagerRecoveryHandler).toBe(lifecycleManagerRecoveryHandler);
 expect(facade.lifecyclePersonnelCompletionPreviewHandler).toBe(lifecyclePersonnelCompletionPreviewHandler);
 expect(facade.lifecyclePersonnelCompletionRecoveryHandler).toBe(lifecyclePersonnelCompletionRecoveryHandler);
 expect(facade.v9PersonnelWritableKeys).toBe(v9PersonnelWritableKeys);
 expect(v9PersonnelWritableKeys).toEqual(['mobile','homePhone','personalEmail','race','religion','nationality','emName','emRel','emPhone','bankName','bankAcc','epfNo','taxNo','gender','marital']);
});
