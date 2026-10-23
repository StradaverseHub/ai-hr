/** One file-size contract for the photo owner and its native multipart action transport. */
export const PHOTO_MAX_BYTES=2*1024*1024;
// Next counts raw multipart boundaries/headers as well as file bytes. Keep that overhead bounded.
export const PHOTO_MULTIPART_HEADROOM_BYTES=64*1024;
export const PHOTO_ACTION_BODY_LIMIT=PHOTO_MAX_BYTES+PHOTO_MULTIPART_HEADROOM_BYTES;
