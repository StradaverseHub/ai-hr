/** Personnel cleanup retires this maintenance surface while preserving the canonical records. */
import {readFileSync,existsSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
describe('retired Personnel review maintenance surface',()=>{
 it('offers no profile control or hidden profile action while retaining the review owner and protected documents',()=>{
  const page=readFileSync(new URL('../app/admin/personnel/[employmentId]/page.tsx',import.meta.url),'utf8');
  const actions=readFileSync(new URL('../app/admin/personnel/[employmentId]/actions.ts',import.meta.url),'utf8');
  expect(page).not.toContain('ReviewSection');
  for(const name of ['setReviewEndDateAction','startReviewAction','uploadReviewDocumentAction','saveReviewLetterAction'])expect(actions).not.toContain(name);
  expect(existsSync(new URL('../app/admin/personnel/[employmentId]/review-section.tsx',import.meta.url))).toBe(false);
  const owner=readFileSync(new URL('../core/employment-review.ts',import.meta.url),'utf8');
  for(const name of ['reviewDocumentsFor','startReview','uploadReviewDocument'])expect(owner).toContain(name);
  const route=readFileSync(new URL('../app/admin/personnel/[employmentId]/review/[reviewId]/document/[docId]/route.ts',import.meta.url),'utf8');
  expect(route).toContain('getReviewDocument(s, docId)');expect(route).toContain('doc.reviewId !== reviewId');
 });
});
