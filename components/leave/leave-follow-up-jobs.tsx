import type {SessionContext} from '@/db/client';
import {activeLeaveCohortJob} from '@/core/leave-cohort-job';
import {LEAVE_A2C_JOB_KIND, LEAVE_RECALC_JOB_KIND} from '@/lib/leave-cohort-job';
import {LeaveCohortJobPanel} from './leave-cohort-job-panel';

/** The signed-in administrator's running follow-up recalculations (after a leave-type, table or rule save, and after
 * a Leave Year Type save), in the leave processing progress-panel pattern, on the pages those saves return to. */
export async function LeaveFollowUpJobs({session}: {session: SessionContext}) {
  const [recalc, a2c] = await Promise.all([activeLeaveCohortJob(session, LEAVE_RECALC_JOB_KIND), activeLeaveCohortJob(session, LEAVE_A2C_JOB_KIND)]);
  if (!recalc && !a2c) return null;
  return (
    <>
      {a2c && <LeaveCohortJobPanel job={a2c} />}
      {recalc && <LeaveCohortJobPanel job={recalc} />}
    </>
  );
}
