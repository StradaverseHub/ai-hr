'use server';
/**
 * Recruitment server actions. Each one only translates a form into a service call: the service checks the
 * module, the caller's recruitment administration of the company and every rule, and row security refuses
 * again. A refusal comes back to the page as a stable error code (?error=<code>), never as SQL.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { pgSqlState } from '@/lib/db-error';
import {
  addApplication, addJobMember, addPoolCandidateToJob, associateJob, cancelInterview, changeJobStatus, changeRequisitionStatus, createJob,
  createRequisition, decideOffer, decideRequisition, deleteArchiveReason, dissociateJob, markOfferSent, moveApplication, recordOfferDecision,
  rejectApplication, removeJobMember, saveApprovalFlow, saveArchiveReason, saveEvaluationForm, saveOffer, saveOfferField, scheduleInterview,
  setCandidateResponse, submitOffer, submitRequisition, submitScorecard, updateInterviewSettings, updateJob, updateOfferSettings, updateProcess,
  updateRequisition, updateStage, withdrawOffer, withdrawRequisition, RecruitmentError,
  addCandidateEntry, addCandidateTag, deleteCandidateFile, destroyCandidates, recordConsent, removeCandidateEntry, removeCandidateTag,
  saveCandidateRestricted, saveTag, saveTagGroup, updateCandidateProfile, updatePrivacySettings, uploadCandidateFile, CANDIDATE_FILE_MAX_BYTES,
  checkDuplicateCandidate, RECRUITMENT_ERROR_CODES, type DuplicateCheck, setJobReferralPortal, updateReferralSettings,
  setCareersPublished, setJobCareersPage, updateCareersSettings, markRecruitmentTasksRead,
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

/** Slice 7: the job's "Show on the referral portal" setting (recruitment administrators; the service and 4407 refuse others). */
export async function setJobReferralPortalAction(f: FormData) {
  const jobId = str(f, 'jobId');
  return run(back(f, `/recruitment/positions/${encodeURIComponent(jobId)}?tab=settings`), (s) => setJobReferralPortal(s, jobId, f.get('showOnReferralPortal') === 'on'));
}

/** Slice 8: the job's "Show on careers page" switch (recruitment administrators; the service and 4408 refuse others). */
export async function setJobCareersPageAction(f: FormData) {
  const jobId = str(f, 'jobId');
  return run(back(f, `/recruitment/positions/${encodeURIComponent(jobId)}?tab=settings`), (s) => setJobCareersPage(s, jobId, f.get('showOnCareersPage') === 'on'));
}

export async function addJobMemberAction(f: FormData) {
  const jobId = str(f, 'jobId');
  return run(back(f, `/recruitment/positions/${encodeURIComponent(jobId)}?tab=team`), (s) => addJobMember(s, jobId, str(f, 'role'), str(f, 'userId')));
}

export async function removeJobMemberAction(f: FormData) {
  const jobId = str(f, 'jobId');
  return run(back(f, `/recruitment/positions/${encodeURIComponent(jobId)}?tab=team`), (s) => removeJobMember(s, jobId, str(f, 'memberId')));
}

/** What the Add application form shows after a save that did not complete (slice 5). */
export type AddApplicationState = {
  status: 'idle' | 'error' | 'duplicate';
  errorText?: string;
  duplicate?: DuplicateCheck;
  /** The typed values, returned to the same viewer who typed them so the form keeps them. Never logged or put in a URL. */
  values?: Record<string, string>;
  nonce?: number;
};
/**
 * Add application with duplicate detection. A possible duplicate returns what the SERVICE lets the viewer know: a count
 * only for a job operator, the matches for an administrator. An administrator resolves it with `existingCandidateId`
 * (add to that candidate) or `confirmSeparate`. Success revalidates and redirects as every other action does.
 */
export async function addApplicationFormAction(prev: AddApplicationState, f: FormData): Promise<AddApplicationState> {
  const s = await getSession();
  const values = Object.fromEntries(['jobId', 'fullName', 'email', 'phone', 'idType', 'idNumber', 'candidateSource'].map((k) => [k, str(f, k)]));
  const input = { ...values, existingCandidateId: str(f, 'existingCandidateId'), confirmSeparate: str(f, 'confirmSeparate') };
  const nonce = (prev.nonce ?? 0) + 1;
  try {
    await addApplication(s, input);
  } catch (e) {
    if (e instanceof RecruitmentError && e.code === 'possible_duplicate') {
      try {
        return { status: 'duplicate', duplicate: await checkDuplicateCandidate(s, input), values, nonce };
      } catch (inner) {
        e = inner;
      }
    }
    if (!(e instanceof RecruitmentError)) console.error('recruitment action failed', e instanceof Error ? e.name : typeof e, pgSqlState(e) ?? '');
    const t = await getTranslations('recruitment.errors');
    const code = errorCode(e);
    const errorText = (RECRUITMENT_ERROR_CODES as readonly string[]).includes(code) ? t(code as (typeof RECRUITMENT_ERROR_CODES)[number]) : t('unexpected');
    return { status: 'error', errorText, values, nonce };
  }
  revalidatePath('/recruitment', 'layout');
  redirect(withParam(back(f, '/recruitment/candidates'), 'notice', 'saved'));
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

// ── Slice 5: candidate records and privacy ───────────────────────────────────────────────────────────────

const candidatePage = (f: FormData) => appPage(f, 'candidate');

export async function updateCandidateProfileAction(f: FormData) {
  return run(candidatePage(f), (s) => updateCandidateProfile(s, str(f, 'candidateId'), {
    fullName: str(f, 'fullName'), email: str(f, 'email'), phone: str(f, 'phone'), location: str(f, 'location'), currentCompany: str(f, 'currentCompany'),
    currentTitle: str(f, 'currentTitle'), highestEducation: str(f, 'highestEducation'), noticePeriod: str(f, 'noticePeriod'), source: str(f, 'source'),
  }));
}
export async function saveCandidateRestrictedAction(f: FormData) {
  return run(candidatePage(f), (s) => saveCandidateRestricted(s, str(f, 'candidateId'), {
    currentSalaryAmount: str(f, 'currentSalaryAmount'), currentSalaryCurrency: str(f, 'currentSalaryCurrency'),
    expectedSalaryAmount: str(f, 'expectedSalaryAmount'), expectedSalaryCurrency: str(f, 'expectedSalaryCurrency'),
    idType: str(f, 'idType'), idNumber: str(f, 'idNumber'),
  }));
}
export async function addCandidateEntryAction(f: FormData) {
  return run(candidatePage(f), (s) => addCandidateEntry(s, str(f, 'candidateId'), {
    kind: str(f, 'kind'), organisation: str(f, 'organisation'), title: str(f, 'title'), fromMonth: str(f, 'fromMonth'), toMonth: str(f, 'toMonth'),
    isCurrent: f.get('isCurrent') === 'on',
  }));
}
export async function removeCandidateEntryAction(f: FormData) {
  return run(candidatePage(f), (s) => removeCandidateEntry(s, str(f, 'entryId')));
}
/** The browser-declared type is never trusted: the service reads the file's own bytes (core/employee-documents). */
export async function uploadCandidateFileAction(f: FormData) {
  const file = f.get('file');
  return run(candidatePage(f), async (s) => {
    if (!(file instanceof File) || file.size === 0) throw new RecruitmentError('missing_fields', ['file']);
    if (file.size > CANDIDATE_FILE_MAX_BYTES) throw new RecruitmentError('file_too_large');
    await uploadCandidateFile(s, str(f, 'candidateId'), {
      kind: str(f, 'kind'), fileName: file.name, content: Buffer.from(await file.arrayBuffer()), permissionConfirmed: f.get('permissionConfirmed') === 'on',
    });
  });
}
export async function deleteCandidateFileAction(f: FormData) {
  return run(candidatePage(f), (s) => deleteCandidateFile(s, str(f, 'fileId')));
}
export async function addCandidateTagAction(f: FormData) {
  return run(candidatePage(f), (s) => addCandidateTag(s, str(f, 'candidateId'), str(f, 'tagId')));
}
export async function removeCandidateTagAction(f: FormData) {
  return run(candidatePage(f), (s) => removeCandidateTag(s, str(f, 'candidateId'), str(f, 'tagId')));
}
export async function recordConsentAction(f: FormData) {
  return run(candidatePage(f), (s) => recordConsent(s, str(f, 'candidateId'), {
    status: str(f, 'status'), effectiveOn: str(f, 'effectiveOn'), method: str(f, 'method'), noticeReference: str(f, 'noticeReference'),
  }));
}
export async function updatePrivacySettingsAction(f: FormData) {
  return run(back(f, '/recruitment/settings?section=privacy'), (s) => updatePrivacySettings(s, str(f, 'companyId'), {
    monthsWithoutConsent: str(f, 'monthsWithoutConsent'), monthsWithConsent: str(f, 'monthsWithConsent'), repeatWindowMonths: str(f, 'repeatWindowMonths'),
  }));
}
/** Slice 7: the company's referral protection period in days (0 switches it off). */
export async function updateReferralSettingsAction(f: FormData) {
  return run(back(f, '/recruitment/settings?section=referrals'), (s) => updateReferralSettings(s, str(f, 'companyId'), { protectionDays: str(f, 'protectionDays') }));
}
/** Slice 8: the careers page fields; a changed privacy notice text becomes a new version (earlier ones are kept). */
export async function updateCareersSettingsAction(f: FormData) {
  return run(back(f, '/recruitment/settings?section=careers'), (s) => updateCareersSettings(s, str(f, 'companyId'), {
    address: str(f, 'address'), displayName: str(f, 'displayName'), headline: str(f, 'headline'), introduction: String(f.get('introduction') ?? ''),
    notice: String(f.get('notice') ?? ''),
  }));
}
/** Slice 8: publish or withdraw the careers page (publishing is refused while anything it needs is missing). */
export async function setCareersPublishedAction(f: FormData) {
  return run(back(f, '/recruitment/settings?section=careers'), (s) => setCareersPublished(s, str(f, 'companyId'), str(f, 'published') === 'on'));
}
/** Destruction: the administrator's selection and explicit confirmation; the service re-checks every candidate is due. */
export async function destroyCandidatesAction(f: FormData) {
  return run(back(f, '/recruitment/settings?section=privacy'), (s) => destroyCandidates(s, str(f, 'companyId'), f.getAll('candidateIds').map(String), f.get('confirm') === 'on'),
    withParam(back(f, '/recruitment/settings?section=privacy'), 'notice', 'removed'));
}
export async function saveTagGroupAction(f: FormData) {
  return run(back(f, '/recruitment/settings?section=tags'), (s) => saveTagGroup(s, {
    id: str(f, 'groupId'), companyId: str(f, 'companyId'), name: str(f, 'name'), enabled: f.get('enabled') === 'on',
  }));
}
export async function saveTagAction(f: FormData) {
  return run(back(f, '/recruitment/settings?section=tags'), (s) => saveTag(s, {
    id: str(f, 'tagId'), groupId: str(f, 'groupId'), name: str(f, 'name'), enabled: f.get('enabled') === 'on',
  }));
}

/**
 * Slice 9: "Mark all as read" in the Overview Tasks panel — one update category, or all, for the companies the panel shows.
 * The service writes only the caller's own read markers and refuses a company whose recruitment they may not see.
 */
export async function markRecruitmentTasksReadAction(f: FormData) {
  const category = str(f, 'category');
  return run(back(f, '/recruitment'), (s) => markRecruitmentTasksRead(s, f.getAll('companyId').map(String), category));
}
