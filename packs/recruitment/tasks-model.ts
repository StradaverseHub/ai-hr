/**
 * Recruitment slice 9 rules — tasks and updates. Pure, deterministic and client-safe: no database, no clock, no model.
 *
 * packs/recruitment/tasks.ts reads the live recruitment records under the viewer's own row security and hands the rows
 * to these helpers; nothing here decides who may see what (the database does). D-031: items are computed live, never
 * stored as text. D-032: read state is one "read up to" time per user, company and category.
 */
import type { PackTaskItem, RecruitmentTaskKind } from '../../lib/assigned-work';

/** The update categories, each with its own read marker (db/migrations/4409_recruitment_tasks.sql). */
export const TASK_CATEGORIES = ['requisitions', 'offers', 'interviews', 'applications'] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];
/** The Overview Tasks panel's tabs: the live to-do list, then one tab per update category. */
export const TASK_TABS = ['todo', ...TASK_CATEGORIES] as const;
export type TaskTab = (typeof TASK_TABS)[number];

/** Things waiting for the viewer's action. */
export const TODO_KINDS = ['requisitionApproval', 'offerApproval', 'feedback', 'toSchedule', 'toScreen'] as const;
export type TodoKind = (typeof TODO_KINDS)[number];
/** The viewer's personal to-dos (approval steps, feedback due): the bell, My tasks and the Overview's To do tab. */
export const PERSONAL_TODO_KINDS = ['requisitionApproval', 'offerApproval', 'feedback'] as const;
export type PersonalTodoKind = (typeof PERSONAL_TODO_KINDS)[number];
/** Per-job counts: only on the Overview's To do tab, loaded after the page (D-035). */
export const JOB_TODO_KINDS = ['toSchedule', 'toScreen'] as const;

/** Things that happened, per category. */
export const UPDATE_KINDS = {
  requisitions: ['requisitionApproved', 'requisitionDenied'],
  offers: ['offerApproved', 'offerDenied', 'offerAccepted', 'offerDeclined'],
  interviews: ['feedbackSubmitted'],
  applications: ['careersApplication', 'referral'],
} as const satisfies Record<TaskCategory, readonly string[]>;
export type UpdateKind = (typeof UPDATE_KINDS)[TaskCategory][number];

/** Updates older than this are not shown or counted. */
export const UPDATES_WINDOW_DAYS = 90;
export const UPDATES_PAGE_SIZE = 20;
/** How far back the panel pages (keyset paging, so each page costs the same): at most 50 pages of 20, i.e. the newest
 *  1,000 updates of a category; the last page offers no "Older" link. A larger ?page= reads as this one. */
export const UPDATES_MAX_PAGE = 50;
/** Unread counts stop counting here; the badge then reads "99+". */
export const UNREAD_CAP = 100;
/** At most this many items of one to-do kind are read for one viewer (the bell runs on every page). */
export const TODO_LIMIT = 50;
/** The schedule and screen counts (Overview only) read at most this many of the viewer's Open or On hold jobs, most
 *  recently updated first (closed jobs give no to-dos). Each application read costs its row-security check (about
 *  0.1 ms), so a job with hundreds of candidates in Interview costs tens of ms: the counts stream in after the page. */
export const TODO_JOB_LIMIT = 50;
/** The bell and My tasks statement timeout: over it they show no recruitment items rather than slowing every page. */
export const BELL_TIMEOUT_MS = 1500;
/** The Overview's per-job counts statement timeout: over it the tab says the counts could not be loaded. */
export const JOB_TODOS_TIMEOUT_MS = 3000;
/** A per-job count (to schedule, to screen) stops counting here; it then reads "99+". */
export const TODO_COUNT_CAP = 100;

/** One to-do, as the Overview panel and the bell show it. Names are read live; `candidateName` is null when the viewer
 *  cannot read the candidate (an approver who is not on the job's team) or the candidate was removed (`candidateRemoved`). */
export type RecruitmentTodo = {
  kind: TodoKind;
  /** The offer, requisition, interview or job the item is about. */
  id: string;
  companyId: string;
  jobId: string | null;
  /** The job title or the requisition title, as the viewer may read it; null when they cannot. */
  title: string | null;
  /** MJ or HC number. */
  number: string | null;
  candidateName: string | null;
  candidateRemoved: boolean;
  /** Per-job counts (to schedule, to screen), capped at TODO_COUNT_CAP. */
  count: number | null;
  /** Approval steps: the viewer's position and the number of steps. */
  step: { position: number; steps: number } | null;
  /** ISO instant: when the item became the viewer's (the step was reached, the interview started, the latest arrival). */
  at: string;
  /** The page where the viewer acts. */
  href: string;
};

/** One update. Never a referral reason, an applicant's message, a salary, an offer value or a score. */
export type RecruitmentUpdate = {
  /** Stable per event (the approval decision, scorecard, referral, careers application or offer decision). */
  id: string;
  category: TaskCategory;
  kind: UpdateKind;
  companyId: string;
  jobId: string | null;
  title: string | null;
  number: string | null;
  candidateName: string | null;
  candidateRemoved: boolean;
  /** ISO instant. */
  at: string;
  href: string;
  unread: boolean;
};

export function isTaskCategory(value: unknown): value is TaskCategory {
  return typeof value === 'string' && (TASK_CATEGORIES as readonly string[]).includes(value);
}
/** The tab in ?tasks=…; anything else is the To do tab. */
export function parseTaskTab(value: unknown): TaskTab {
  return typeof value === 'string' && (TASK_TABS as readonly string[]).includes(value) ? (value as TaskTab) : 'todo';
}
/** The page in ?page=… (1 when absent or unreadable; never above UPDATES_MAX_PAGE). */
export function parseUpdatesPage(value: unknown): number {
  const n = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : typeof value === 'number' ? value : 1;
  return Number.isInteger(n) && n >= 1 ? Math.min(n, UPDATES_MAX_PAGE) : 1;
}
/** Whether the page has an "Older" link: more rows than a page were read, and the page is not the last allowed one. */
export function updatesHasMore(page: number, rowsRead: number): boolean {
  return rowsRead > UPDATES_PAGE_SIZE && page < UPDATES_MAX_PAGE;
}
/** The keyset position after an update (its time and id), as the ?after= value: `<ISO instant>_<update id>`. */
export function encodeUpdatesCursor(at: string, id: string): string {
  return `${at}_${id}`;
}
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:careers|:decision)?$/;
/** The keyset position from ?after=; null for anything that is not one this module wrote. */
export function decodeUpdatesCursor(value: unknown): { at: string; id: string } | null {
  if (typeof value !== 'string' || value.length > 120) return null;
  const [at, id, ...rest] = value.split('_');
  if (rest.length || !at || !id || !CURSOR_ID.test(id)) return null;
  const when = new Date(at);
  return Number.isNaN(when.getTime()) || when.toISOString() !== at ? null : { at, id };
}
/** The categories "Mark all as read" moves: one, or every one. */
export function readCategories(category: TaskCategory | 'all'): TaskCategory[] {
  return category === 'all' ? [...TASK_CATEGORIES] : [category];
}
/** The start of the updates window for `now`. */
export function updatesSince(now: Date): Date {
  return new Date(now.getTime() - UPDATES_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}
/** A capped count as badge text. */
export function countText(n: number, cap: number = UNREAD_CAP): string {
  return n >= cap ? `${cap - 1}+` : String(n);
}

/** Where each to-do is acted on. */
export function todoHref(kind: TodoKind, ids: { id: string; jobId?: string | null; stageId?: string | null }): string {
  switch (kind) {
    case 'requisitionApproval':
    case 'offerApproval':
      return '/recruitment/approvals';
    case 'feedback':
      return `/recruitment/interviews/${encodeURIComponent(ids.id)}/feedback`;
    case 'toSchedule':
    case 'toScreen': {
      const q = new URLSearchParams({ job: ids.jobId ?? ids.id, ...(ids.stageId ? { tab: ids.stageId } : {}) });
      return `/recruitment/candidates?${q.toString()}`;
    }
  }
}
/** Where each update opens. */
export function updateHref(kind: UpdateKind, ids: { requisitionId?: string | null; applicationId?: string | null }): string {
  if (kind === 'requisitionApproved' || kind === 'requisitionDenied') return `/recruitment/requisitions/${encodeURIComponent(ids.requisitionId ?? '')}`;
  return `/recruitment/applications/${encodeURIComponent(ids.applicationId ?? '')}`;
}

const BELL_KIND: Record<PersonalTodoKind, RecruitmentTaskKind> = {
  requisitionApproval: 'recruitmentRequisitionApproval',
  offerApproval: 'recruitmentOfferApproval',
  feedback: 'recruitmentFeedback',
};
export function isPersonalTodo(item: RecruitmentTodo): item is RecruitmentTodo & { kind: PersonalTodoKind } {
  return (PERSONAL_TODO_KINDS as readonly string[]).includes(item.kind);
}

/**
 * A personal to-do as a bell task (lib/assigned-work.ts PackTaskItem: id, kind, subject, owner time and link — nothing
 * else); null for a per-job count, which the bell does not carry (D-035). The subject is plain text without words, so it
 * needs no translation: the candidate and the job or requisition title. A removed candidate, or one the viewer cannot
 * read, is left out; the bell's kind label says what is waiting.
 */
export function todoToPackTask(item: RecruitmentTodo): PackTaskItem | null {
  if (!isPersonalTodo(item)) return null;
  const parts = [item.candidateRemoved ? null : item.candidateName, item.title].filter((p): p is string => !!p);
  return {
    id: `${item.kind}:${item.id}`,
    kind: BELL_KIND[item.kind],
    subjectName: parts.length ? parts.join(' · ') : item.number,
    createdAt: item.at,
    linkPath: item.href,
  };
}

/** Newest first, then by kind and id, so equal times keep one order. */
export function byNewest<T extends { at: string; kind: string; id: string }>(a: T, b: T): number {
  return a.at < b.at ? 1 : a.at > b.at ? -1 : a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
}
