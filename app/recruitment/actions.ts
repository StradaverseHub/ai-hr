'use server';
/**
 * Recruitment server actions. Each one only translates a form into a service call: the service checks the
 * module, the caller's recruitment administration of the company and every rule, and row security refuses
 * again. A refusal comes back to the page as a stable error code (?error=<code>), never as SQL.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { pgSqlState } from '@/lib/db-error';
import {
  addApplication, addJobMember, addPoolCandidateToJob, associateJob, cancelInterview, changeJobStatus, changeRequisitionStatus, createJob,
  createRequisition, decideOffer, decideRequisition, deleteArchiveReason, dissociateJob, markOfferSent, moveApplication, recordOfferDecision,
  rejectApplication, removeJobMember, saveApprovalFlow, saveArchiveReason, saveEvaluationForm, saveOffer, saveOfferField, scheduleInterview,
  setCandidateResponse, submitOffer, submitRequisition, submitScorecard, updateInterviewSettings, updateJob, updateOfferSettings, updateProcess,
  updateRequisition, updateStage, withdrawOffer, withdrawRequisition, RecruitmentError,
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
    // Only the error's kind and SQLSTATE: a database error's message carries its bound values (candidate details,
    // private offer values, notes), which must never reach the server log.
    if (!(e instanceof RecruitmentError)) console.error('recruitment action failed', e instanceof Error ? e.name : typeof e, pgSqlState(e) ?? '');
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
    ({ id } = await createJob(s, {
      ...jobFields(f), companyId, positionAttribute: str(f, 'positionAttribute'), recruiterUserId: str(f, 'recruiterUserId'), requisitionId: str(f, 'requisitionId'),
    }));
  } catch (e) {
    const missing = e instanceof RecruitmentError && e.detail?.length ? `&fields=${encodeURIComponent(e.detail.join(','))}` : '';
    const requisition = str(f, 'requisitionId') ? `&requisition=${encodeURIComponent(str(f, 'requisitionId'))}` : '';
    redirect(`/recruitment/positions/new?company=${encodeURIComponent(companyId)}&error=${errorCode(e)}${missing}${requisition}`);
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

// ── Slice 2: interviews and feedback ────────────────────────────────────────────────────────────────────

const appPage = (f: FormData, tab: string) => back(f, `/recruitment/applications/${encodeURIComponent(str(f, 'applicationId'))}?tab=${tab}`);

export async function scheduleInterviewAction(f: FormData) {
  return run(appPage(f, 'interviews'), (s) => scheduleInterview(s, {
    applicationId: str(f, 'applicationId'), roundNo: str(f, 'roundNo'), type: str(f, 'type'), startsAt: str(f, 'startsAt'),
    durationMinutes: str(f, 'durationMinutes'), site: str(f, 'site'), meetingRoom: str(f, 'meetingRoom'),
    interviewerIds: f.getAll('interviewerIds').map(String), formId: str(f, 'formId'),
  }));
}

export async function cancelInterviewAction(f: FormData) {
  return run(appPage(f, 'interviews'), (s) => cancelInterview(s, str(f, 'interviewId')));
}

export async function setCandidateResponseAction(f: FormData) {
  return run(appPage(f, 'interviews'), (s) => setCandidateResponse(s, str(f, 'interviewId'), str(f, 'response')));
}

/** Feedback fields arrive as rating:<criterion key> and notes:<criterion key>; the service validates them against the form. */
export async function submitScorecardAction(f: FormData) {
  const ratings: Record<string, { rating?: unknown; notes?: unknown }> = {};
  for (const [key, value] of f.entries()) {
    const m = /^(rating|notes):([a-z0-9]{1,20})$/.exec(key);
    if (!m) continue;
    ratings[m[2]] = { ...ratings[m[2]], [m[1] === 'rating' ? 'rating' : 'notes']: String(value) };
  }
  const interviewId = str(f, 'interviewId');
  return run(back(f, `/recruitment/interviews/${encodeURIComponent(interviewId)}/feedback`),
    (s) => submitScorecard(s, interviewId, { ratings, result: str(f, 'result'), overview: String(f.get('overview') ?? '') }),
    withParam(appPage(f, 'interviews'), 'notice', 'saved'));
}

export async function updateInterviewSettingsAction(f: FormData) {
  return run(back(f, '/recruitment/settings?section=interviews'), (s) => updateInterviewSettings(s, str(f, 'companyId'), {
    scorecardsPrivate: f.get('scorecardsPrivate') === 'on', feedbackEditLock: str(f, 'feedbackEditLock'), resultRequired: f.get('resultRequired') === 'on',
  }));
}

export async function saveEvaluationFormAction(f: FormData) {
  return run(back(f, '/recruitment/settings?section=interviews'), (s) => saveEvaluationForm(s, {
    id: str(f, 'formId'), companyId: str(f, 'companyId'), name: str(f, 'name'), source: String(f.get('source') ?? ''),
    isDefault: f.get('isDefault') === 'on', enabled: f.get('enabled') === 'on',
  }));
}

// ── Slice 3: offers ─────────────────────────────────────────────────────────────────────────────────────

/** Offer values arrive as text:<field id>, amount:<field id> and currency:<field id>. */
export async function saveOfferAction(f: FormData) {
  const values: Record<string, { text?: unknown; amount?: unknown; currency?: unknown }> = {};
  for (const [key, value] of f.entries()) {
    const m = /^(text|amount|currency):([0-9a-f-]{36})$/i.exec(key);
    if (!m) continue;
    values[m[2]] = { ...values[m[2]], [m[1]]: String(value) };
  }
  return run(appPage(f, 'offer'), (s) => saveOffer(s, str(f, 'applicationId'), values));
}
export async function submitOfferAction(f: FormData) {
  return run(appPage(f, 'offer'), (s) => submitOffer(s, str(f, 'offerId')));
}
export async function withdrawOfferAction(f: FormData) {
  return run(appPage(f, 'offer'), (s) => withdrawOffer(s, str(f, 'offerId')));
}
export async function decideOfferAction(f: FormData) {
  return run(back(f, '/recruitment/approvals'), (s) => decideOffer(s, str(f, 'offerId'), str(f, 'decision'), str(f, 'comment')));
}
export async function markOfferSentAction(f: FormData) {
  return run(appPage(f, 'offer'), (s) => markOfferSent(s, str(f, 'offerId'), str(f, 'channel')));
}
export async function recordOfferDecisionAction(f: FormData) {
  return run(appPage(f, 'offer'), (s) => recordOfferDecision(s, str(f, 'offerId'), str(f, 'decision')));
}
export async function updateOfferSettingsAction(f: FormData) {
  return run(back(f, '/recruitment/settings?section=offers'), (s) => updateOfferSettings(s, str(f, 'companyId'), {
    validDays: str(f, 'validDays'), acceptMovesForward: f.get('acceptMovesForward') === 'on', declineArchives: f.get('declineArchives') === 'on',
  }));
}
export async function saveOfferFieldAction(f: FormData) {
  return run(back(f, '/recruitment/settings?section=offers'), (s) => saveOfferField(s, {
    id: str(f, 'fieldId'), companyId: str(f, 'companyId'), label: str(f, 'label'), type: str(f, 'type'), choices: String(f.get('choices') ?? ''),
    required: f.get('required') === 'on', needsApproval: f.get('needsApproval') === 'on', private: f.get('private') === 'on', enabled: f.get('enabled') === 'on',
  }));
}
export async function saveApprovalFlowAction(f: FormData) {
  return run(back(f, '/recruitment/settings?section=offers'), (s) => saveApprovalFlow(s, str(f, 'companyId'), str(f, 'kind'), f.getAll('approverIds').map(String)));
}

// ── Slice 4: requisitions and the talent pool ───────────────────────────────────────────────────────────

const requisitionFields = (f: FormData) => ({
  companyId: str(f, 'companyId'), title: str(f, 'title'), description: String(f.get('description') ?? ''), vacancies: str(f, 'vacancies'),
  jobGradeIds: f.getAll('jobGradeIds').map(String), hiringManagerUserId: str(f, 'hiringManagerUserId'), partnerUserId: str(f, 'partnerUserId'),
  recruiterUserId: str(f, 'recruiterUserId'), workLocation: str(f, 'workLocation'), employmentType: str(f, 'employmentType'),
  recruitmentType: str(f, 'recruitmentType'), departmentId: str(f, 'departmentId'), dateOpened: str(f, 'dateOpened'),
  targetOnboardDate: str(f, 'targetOnboardDate'), yearsExperience: str(f, 'yearsExperience'), education: str(f, 'education'),
  salaryMin: str(f, 'salaryMin'), salaryMax: str(f, 'salaryMax'), salaryCurrency: str(f, 'salaryCurrency'), workingDays: str(f, 'workingDays'),
  workingHours: str(f, 'workingHours'), mandatorySkills: String(f.get('mandatorySkills') ?? ''), preferredSkills: String(f.get('preferredSkills') ?? ''),
  benefits: String(f.get('benefits') ?? ''),
});

export async function createRequisitionAction(f: FormData) {
  const s = await getSession();
  let id: string;
  try {
    ({ id } = await createRequisition(s, requisitionFields(f)));
  } catch (e) {
    const fields = e instanceof RecruitmentError && e.detail?.length ? `&fields=${encodeURIComponent(e.detail.join(','))}` : '';
    redirect(`/recruitment/requisitions/new?company=${encodeURIComponent(str(f, 'companyId'))}&error=${errorCode(e)}${fields}`);
  }
  revalidatePath('/recruitment', 'layout');
  redirect(`/recruitment/requisitions/${id}?notice=created`);
}
const reqPage = (f: FormData) => back(f, `/recruitment/requisitions/${encodeURIComponent(str(f, 'requisitionId'))}`);
export async function updateRequisitionAction(f: FormData) {
  return run(reqPage(f), (s) => updateRequisition(s, str(f, 'requisitionId'), requisitionFields(f)));
}
export async function submitRequisitionAction(f: FormData) {
  return run(reqPage(f), (s) => submitRequisition(s, str(f, 'requisitionId')));
}
export async function withdrawRequisitionAction(f: FormData) {
  return run(reqPage(f), (s) => withdrawRequisition(s, str(f, 'requisitionId')));
}
export async function decideRequisitionAction(f: FormData) {
  return run(back(f, '/recruitment/approvals'), (s) => decideRequisition(s, str(f, 'requisitionId'), str(f, 'decision'), str(f, 'comment')));
}
export async function changeRequisitionStatusAction(f: FormData) {
  return run(reqPage(f), (s) => changeRequisitionStatus(s, str(f, 'requisitionId'), str(f, 'status')));
}
export async function associateJobAction(f: FormData) {
  return run(reqPage(f), (s) => associateJob(s, str(f, 'requisitionId'), str(f, 'jobId')));
}
export async function dissociateJobAction(f: FormData) {
  return run(reqPage(f), (s) => dissociateJob(s, str(f, 'requisitionId'), str(f, 'jobId')));
}
export async function addPoolCandidateToJobAction(f: FormData) {
  return run(back(f, '/recruitment/talent-pool'), (s) => addPoolCandidateToJob(s, str(f, 'applicationId'), str(f, 'jobId')));
}
