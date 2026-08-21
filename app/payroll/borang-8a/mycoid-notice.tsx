/**
 * 5dbce839 — THE MYCOID BOX GOES OUT EMPTY, AND THE SCREEN SAYS SO BEFORE THE DOWNLOAD DOES NOT.
 *
 * The reporter's own accepted BRG8A.txt carries "34111U" in positions 13-32; ours carries twenty spaces,
 * because `company_statutory_my.ssm_registration_no` has never been filled in for their company. PERKESO's
 * specification marks that field Mandatory = N, so REFUSING the download would be wrong and
 * `missingBorang8AHeader` deliberately keeps mycoid out of the blocking set. But an empty fixed-width box
 * is indistinguishable from a full one from the outside, and handing one over quietly is how somebody
 * finds out at the portal. So it is said out loud, here, beside the buttons that produce the file.
 *
 * ⚠️ A NOTICE, NOT A GATE. Nothing below hides a button or changes a byte of the file. If this ever grows
 * into a condition on the download, the specification says it should not.
 *
 * ITS OWN MODULE, and that is the point of the file rather than an accident of it. The rule is one
 * condition — "the number is blank" — and a condition living inside a 400-line async server component can
 * only be pinned by reading the page's source, which cannot tell the difference between a notice that
 * appears and one that appears always. Here both halves are a render: pass a blank number and the markup
 * carries the sentence, pass "34111U" and there is no markup at all. See test/borang-8a.test.ts.
 *
 * The WORDS are passed in already translated rather than looked up here, so the page keeps its single
 * `t('…')` call site per key — which is what test/borang-8a.test.ts scans to prove every key this screen
 * renders exists in every locale.
 */
export function Borang8AMycoidNotice({
  mycoid,
  title,
  body,
}: {
  /** The MyCoID / SSM registration number as the form carries it. Blank (or whitespace) is the case. */
  mycoid: string | null | undefined;
  title: string;
  body: string;
}) {
  if (String(mycoid ?? '').trim()) return null;
  return (
    <div className="basis-full rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
      <p className="font-medium">{title}</p>
      <p className="mt-1">{body}</p>
    </div>
  );
}
