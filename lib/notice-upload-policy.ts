/** One technical byte budget for the editor, service, multipart reader and framework transport. */
export const NOTICE_ATTACHMENT_MAX_BYTES=10*1024*1024;
export const NOTICE_UPLOAD_MULTIPART_OVERHEAD_BYTES=64*1024;
// Preserve one extra byte so the application can positively refuse an over-budget stream even when
// Next truncates its own clone. No complete allowed multipart body may be truncated before the reader.
export const NOTICE_UPLOAD_PROXY_MAX_BYTES=NOTICE_ATTACHMENT_MAX_BYTES+NOTICE_UPLOAD_MULTIPART_OVERHEAD_BYTES+1;
