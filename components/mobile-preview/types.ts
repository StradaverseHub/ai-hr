/** Only the fields the live design preview renders may cross the server/client boundary. */
export type PreviewRead<T> = { status: 'ready'; data: T } | { status: 'disabled' | 'unavailable' };
export type PreviewLeave = {
  id: string; name: string; available: number | null; balance: number | null;
  taken: number | null; pending: number | null; takenOnly: boolean;
  sharedWith: string[]; canRequest: boolean; notice: string | null;
  cycleStart: string; cycleEnd: string;
};
export type PreviewRequest = { id: string; type: string; from: string; to: string; status: string; partial: boolean };
export type PreviewAway = { employmentId: string; name: string; dates: { date: string; status: 'approved' | 'pending'; session: string }[] };
export type MobilePreviewData = {
  today: string; loadedAt: string; leaveHistoryHref: string;
  person: { name: string | null; employeeCode: string | null };
  employment: { id: string; company: string; department: string | null; position: string | null } | null;
  clock: PreviewRead<{ date: string; clockedIn: boolean; shiftStart: string | null; shiftEnd: string | null;
    events: { direction: string; time: string }[] }>;
  leave: PreviewRead<PreviewLeave[]>;
  requests: PreviewRead<{ items: PreviewRequest[]; total: number }>;
  claims: PreviewRead<{ id: string; type: string; date: string; status: string; amount: string }[]>;
  team: PreviewRead<PreviewAway[]>;
  tasks: PreviewRead<{ id: string; kind: string; subject: string | null; href: string }[]>;
  inbox: PreviewRead<{ id: string; title: string; body: string; href: string | null; read: boolean; createdAt: string }[]>;
  payslips: PreviewRead<{ id: string; company: string; period: string }[]>;
};
