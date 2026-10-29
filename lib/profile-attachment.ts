/** Attachment bytes travel only with an authenticated profile submission, never through URLs/events. */
export type ProfileAttachmentInput={fieldIds:string[];fileName:string;mimeType:string;contentBase64:string};
export const PROFILE_ATTACHMENT_MAX_BYTES=5*1024*1024;
export const PROFILE_ATTACHMENT_MAX_FILES=3;

export const PROFILE_ATTACHMENT_TOTAL_MAX_BYTES=10*1024*1024;
// Base64 transport plus bounded proposal/action framing. Each owner retains its own file limits.
export const PROFILE_ATTACHMENT_ACTION_BODY_LIMIT=Math.ceil(PROFILE_ATTACHMENT_TOTAL_MAX_BYTES/3)*4+256*1024;
