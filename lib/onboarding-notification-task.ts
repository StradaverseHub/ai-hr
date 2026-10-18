/** The queue owns business dates, not a recorded creation instant. Do not invent notification age. */
export function onboardingNotificationTask(item: { id: string; title: string; joiner: string }) {
  return { id: item.id, kind: 'onboarding' as const, subjectName: item.title + ' · ' + item.joiner, linkPath: '/tasks' };
}
