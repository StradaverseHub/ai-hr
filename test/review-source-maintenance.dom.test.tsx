/** Personnel cleanup retires this maintenance surface while preserving the canonical records. */
import {readFileSync,existsSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {resolve} from 'node:path';
describe('retired Personnel review maintenance surface',()=>{
 it('offers no profile control or hidden profile action while retaining the review owner and protected documents',()=>{
  const page=readFileSync(resolve('test','../app/(app)/admin/personnel/[employmentId]/page.tsx'),'utf8');
  const actions=readFileSync(resolve('test','../app/(app)/admin/personnel/[employmentId]/actions.ts'),'utf8');
  expect(page).not.toContain('ReviewSection');
  for(const name of ['setReviewEndDateAction','startReviewAction','uploadReviewDocumentAction','saveReviewLetterAction'])expect(actions).not.toContain(name);
  expect(existsSync(resolve('test','../app/(app)/admin/personnel/[employmentId]/review-section.tsx'))).toBe(false);
  const owner=readFileSync(resolve('test','../core/employment-review.ts'),'utf8');
  for(const name of ['reviewDocumentsFor','startReview','uploadReviewDocument'])expect(owner).toContain(name);
  const route=readFileSync(resolve('test','../app/(app)/admin/personnel/[employmentId]/review/[reviewId]/document/[docId]/route.ts'),'utf8');
  expect(route).toContain('getReviewDocument(s, docId)');expect(route).toContain('doc.reviewId !== reviewId');
 });
});
