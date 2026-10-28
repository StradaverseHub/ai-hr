import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { getAssessmentPersonalRecord, myReviews, onehrAssignments, performanceTabAccess } from '@/packs/performance/service';
import { PerformanceTabStrip } from '@/components/performance-tabs';
import { PersonalRecord } from '../workspace/personal-record';

type Query={record?:string;recordTab?:string;planYear?:string};
const RECORD_ID=/^(current|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * D-P1-32 PT-X2 — Feedback: the viewer's own 360 report, in the existing personal record (opened on its
 * Feedback section), the source's first choice. The tab shows for a confirmed 360 subject before release and
 * for any released own report; before release the record's own empty state says HR has not released it. A
 * manager or HOD without an own report has no Feedback tab (DQ-5), so the route 404s for them.
 *
 * The record is anchored on the viewer's latest own review, as /me/performance anchors it; the record
 * service rechecks ownership and every release itself.
 */
export default async function FeedbackReportPage({searchParams}:{searchParams:Promise<Query>}) {
 await requireModule('performance');const {s}=await scopedSession();
 const query=await searchParams;
 const {mayOpen,facts}=await performanceTabAccess(s,'feedback.feedback');
 if(!mayOpen)notFound();
 const [reviews,assignments,area,p]=await Promise.all([myReviews(s),onehrAssignments(s),getTranslations('performanceArea'),getTranslations('onehr.personalRecord')]);
 const own=new Set(reviews.map(r=>r.reviewId)),anchor=assignments.reviews.find(r=>own.has(r.id));
 const planYear=query.planYear&&/^\d{4}$/.test(query.planYear)?Number(query.planYear):undefined;
 const record=anchor?await getAssessmentPersonalRecord(s,anchor.id,query.record&&RECORD_ID.test(query.record)?query.record:undefined,planYear):null;
 return <div className="mx-auto max-w-[100rem] space-y-3">
  <PerformanceTabStrip strip="feedback" facts={facts}/>
  <h1 className="sr-only">{area('tabs.f360.feedback')}</h1>
  <main className="min-w-0 rounded-lg border border-border bg-card">{record?<PersonalRecord v={record} tab={query.recordTab??'feedback'} baseHref="/performance/feedback"/>:<p className="p-5 text-sm text-muted-foreground">{p('unreleasedReport')}</p>}</main>
 </div>;
}
