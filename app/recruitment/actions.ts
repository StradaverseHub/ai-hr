'use server';
/**
 * Recruitment server actions. Each one only translates a form into a service call: the service checks the
 * module, the caller's recruitment administration of the company and every rule, and row security refuses
 * again. A refusal comes back to the page as a stable error code (?error=<code>), never as SQL.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import {
  addApplication, addJobMember, changeJobStatus, createJob, deleteArchiveReason, moveApplication, rejectApplication, removeJobMember,
  saveArchiveReason, updateJob, updateProcess, updateStage, RecruitmentError,
} from '@/packs/recruitment/service';

const str = (f: FormData, key: string) => String(f.get(key) ?? '').trim();
/** Only same-site recruitment paths may be returned to. */
const back = (f: FormData, fallback: string) => {
  const to = str(f, 'returnTo');
  return to.startsWith('/recruitment') && !to.startsWith('//') ? to : fallback;
};
const withParam = (url: string, key: string, value: string) => `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
const errorCode = (e: unknown) => (e instanceof RecruitmentError ? e.code : 'unexpected');

async function run(url: string, work: (s: Awaited<ReturnType<typeof getSession>>) => Promise<unknown>, done?: string): Promise<never> {
  const s = await getSession();
  try {
    await work(s);
  } catch (e) {
    if (!(e instanceof RecruitmentError)) console.error('recruitment action failed', e);
    redirect(withParam(url, 'error', errorCode(e)));
  }
  revalidatePath('/recruitment', 'layout');
  redirect(done ?? withParam(url, 'notice', 'saved'));
}

const jobFields = (f: FormData) => ({
  title: str(f, 'title'), description: String(f.get('description') ?? ''), jobGradeIds: f.getAll('jobGradeIds').map(String),
  workLocation: str(f, 'workLocation'), recruitmentType: str(f, 'recruitmentType'), employmentType: str(f, 'employmentType'),
  businessUnitId: str(f, 'businessUnitId'), departmentId: str(f, 'departmentId'), processId: str(f, 'processId'),
  autoArchiveAfterReject: f.get('autoArchiveAfterReject') === 'on',
});

export async function createJobAction(f: FormData) {
  const companyId = str(f, 'companyId');
  const s = await getSession();
  let id: string;
  try {
    ({ id } = await createJob(s, { ...jobFields(f), companyId, positionAttribute: str(f, 'positionAttribute'), recruiterUserId: str(f, 'recruiterUserId') }));
  } catch (e) {
    const missing = e instanceof RecruitmentError && e.detail?.length ? `&fields=${encodeURIComponent(e.detail.join(','))}` : '';
    redirect(`/recruitment/positions/new?company=${encodeURIComponent(companyId)}&error=${errorCode(e)}${missing}`);
  }
  revalidatePath('/recruitment', 'layout');
  redirect(`/recruitment/positions/${id}?notice=created`);
}

export async function updateJobAction(f: FormData) {
  const jobId = str(f, 'jobId');
  return run(back(f, `/recruitment/positions/${encodeURIComponent(jobId)}`), (s) => updateJob(s, jobId, jobFields(f)));
}

export async function changeJobStatusAction(f: FormData) {
  const jobId = str(f, 'jobId');
  return run(back(f, `/recruitment/positions/${encodeURIComponent(jobId)}`), (s) => changeJobStatus(s, jobId, str(f, 'status')));
}

export async function addJobMemberAction(f: FormData) {
  const jobId = str(f, 'jobId');
  return run(back(f, `/recruitment/positions/${encodeURIComponent(jobId)}?tab=team`), (s) => addJobMember(s, jobId, str(f, 'role'), str(f, 'userId')));
}

export async function removeJobMemberAction(f: FormData) {
  const jobId = str(f, 'jobId');
  return run(back(f, `/recruitment/positions/${encodeURIComponent(jobId)}?tab=team`), (s) => removeJobMember(s, jobId, str(f, 'memberId')));
}

export async function addApplicationAction(f: FormData) {
  return run(back(f, '/recruitment/candidates'), (s) => addApplication(s, {
    jobId: str(f, 'jobId'), fullName: str(f, 'fullName'), email: str(f, 'email'), phone: str(f, 'phone'), source: str(f, 'source'),
  }));
}

export async function moveApplicationAction(f: FormData) {
  return run(back(f, '/recruitment/candidates'), (s) => moveApplication(s, str(f, 'applicationId'), str(f, 'targetStageId') || undefined));
}

export async function rejectApplicationAction(f: FormData) {
  return run(back(f, '/recruitment/candidates'), (s) => rejectApplication(s, str(f, 'applicationId'), str(f, 'archiveReasonId')));
}

export async function updateStageAction(f: FormData) {
  return run(back(f, '/recruitment/settings'), (s) => updateStage(s, str(f, 'stageId'), { name: str(f, 'name'), type: str(f, 'type'), enabled: f.get('enabled') === 'on' }));
}

export async function updateProcessAction(f: FormData) {
  return run(back(f, '/recruitment/settings'), (s) => updateProcess(s, str(f, 'processId'), { name: str(f, 'name'), enabled: f.get('enabled') === 'on' }));
}

export async function saveArchiveReasonAction(f: FormData) {
  return run(back(f, '/recruitment/settings'), (s) => saveArchiveReason(s, {
    id: str(f, 'reasonId'), companyId: str(f, 'companyId'), internal: str(f, 'internal'), external: str(f, 'external'), displayed: f.get('displayed') === 'on',
  }));
}

export async function deleteArchiveReasonAction(f: FormData) {
  return run(back(f, '/recruitment/settings'), (s) => deleteArchiveReason(s, str(f, 'reasonId')));
}
