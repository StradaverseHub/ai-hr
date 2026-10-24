/** Public action result; never serialize raw database errors or another recipient's evidence. */
export type NoticeAcknowledgementState={acknowledgedAt?:string;error?:'unavailable'|'changed'|'failed'};
