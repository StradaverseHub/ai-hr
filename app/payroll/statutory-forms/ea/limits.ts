/**
 * r256 (item 858a1128) — HOW MANY C.P.8A (EA) STATEMENTS ONE PRESS MAY ASK FOR.
 *
 * ⚠️ THE CEILING HAS TO BE ONE THE TRANSPORT CAN ACTUALLY DELIVER, and the first one was not. The picker
 * submits its selection as one hidden `id` input per person on a GET form, so every ticked person costs
 * 40 bytes of URL (`id=` + a 36-character UUID + `&`) and the whole request line plus its headers has to
 * fit Node's 16 KB `max-http-header-size`. Measured against a running dev server: 400 ids (16,114 bytes)
 * still reached the route; 500 came back as a bare `431 Request Header Fields Too Large`. A ceiling of 500
 * was therefore a ceiling that could never be consulted — a tenant with 500 employments who pressed Select
 * All and then Generate got an unexplained error page instead of either a PDF or the route's own refusal.
 *
 * 200 leaves more than half the header budget for cookies and everything else, so the number the screen
 * advertises is the number that is enforced. It is also a LOAD ceiling: each statement is one
 * `employeeEaStatement` read and one pdf-lib render inside a single request, so 200 is already a long
 * request and 500 was a much longer one.
 *
 * BOTH SIDES READ THIS ONE CONSTANT. The picker refuses to submit above it and says so in the operator's
 * language before anything is generated; the download route refuses again, because the URL can be edited
 * by hand. A number written down twice is two ceilings that drift.
 */
export const MAX_EA_SELECTION = 200;
