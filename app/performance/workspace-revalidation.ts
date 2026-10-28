import { revalidatePath } from 'next/cache';
import { WORKSPACE_TAB_PATHS } from '@/packs/performance/onehr/tab-route-model';
import { TALENT_BOX_PATH } from '@/packs/performance/onehr/tab-model';

/**
 * D-P1-32 PT-X2: refresh every route that renders the review workspace after an assessment save: the
 * workspace itself, each Performance & Talent tab route over it (tab-route-model.ts), Team PM's per-review
 * route and the standalone Talent Box, which embeds the same calibration view (PT-TB). Narrower than the whole /performance layout (cycle admin, reports, records are untouched) and correct
 * for the actions a client widget calls without a return path. A form action that redirects also refreshes
 * its validated return path (assessmentReturnPath) itself.
 */
export function revalidateAssessmentWorkspace() {
  revalidatePath('/performance/workspace');
  for (const path of WORKSPACE_TAB_PATHS) revalidatePath(path);
  revalidatePath('/performance/team/[reviewId]', 'page');
  revalidatePath(TALENT_BOX_PATH);
}
