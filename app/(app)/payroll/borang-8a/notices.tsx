/**
 * THE THINGS THE BORANG 8A SCREEN SAYS BEFORE IT HANDS OVER A PERKESO UPLOAD FILE.
 *
 * Every one of them is ADVISORY and none hides a button: a file PERKESO's own specification accepts must
 * not be withheld over a judgement this screen is not entitled to make. What they buy is that nothing goes
 * out quietly — a fixed-width record looks identical whether the box behind it was filled in or not, and
 * looks broken in an editor that folds it.
 *
 * ── 5dbce839 — THE MYCOID BOX GOES OUT EMPTY, AND THE SCREEN SAYS SO BEFORE THE DOWNLOAD DOES NOT.
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

/**
 * r218 — EMPLOYEE NAMES THAT ARE NOT YET NAMES, beside the same buttons and with the same standing.
 *
 * Generated from the customer's own January 2026 run, fourteen of nineteen records went out named
 * `TEST0001` … `TEST0014`. PERKESO's field 4 is "Name as per IC or passport", so the format being right
 * to the character does not make the file filable. ADVISORY, NEVER BLOCKING — it is their data, the file
 * carries what the staff record says, and the fix is on the staff record. The identity number is shown
 * because a placeholder name leaves nothing else to find the person by.
 *
 * The rule itself is `lib/unfinished-name.ts`, shared with the CP39's identical warning, so the two
 * screens cannot come to disagree about whether a name is finished.
 */
export function Borang8AUnfinishedNames({
  people,
  title,
  hint,
}: {
  people: readonly { ic: string; name: string }[];
  title: string;
  hint: string;
}) {
  if (people.length === 0) return null;
  return (
    <div className="basis-full rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
      <p className="font-medium">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {people.map((p) => (
          <li key={`${p.ic}:${p.name}`}>
            <span className="font-mono">{p.name || '—'}</span>
            {p.ic ? ` — ${p.ic}` : ''}
          </li>
        ))}
      </ul>
      <p className="mt-1">{hint}</p>
    </div>
  );
}

/**
 * 64c09b0e — THE FILE IS ONE LONG LINE PER EMPLOYEE, SAID BEFORE THE FILE IS OPENED RATHER THAN AFTER.
 *
 * TWO ITEMS IN A ROW REPORTED THE SAME NON-DEFECT. 18c1d92b said records were "split across two lines";
 * 64c09b0e said it again and asked for the format to be re-configured against a field map that would have
 * moved every SOCSO amount into the boxes PERKESO reads as EIS. Both arrived as screenshots — and both
 * screenshots are a text editor with word wrap turned ON, folding a 278-character line. r218 read the
 * bytes of the reporter's own January 2026 file: nineteen records, every one 278 characters, CRLF between
 * records and none after the last. There was never a line break inside a record.
 *
 * So the sentence goes HERE, beside the button that produces the file, because by the time somebody has
 * opened it in Notepad they have already formed the belief this notice exists to prevent. The same
 * sentence heads the "Check the file" report (`perkesoFileReport`), for the reader who got there first.
 *
 * ⚠️ NOT A WARNING AND NOT A GATE. Nothing is wrong when this shows: it is how the format works. It is
 * styled as information rather than as the amber the two notices above use, because dressing a correct
 * file as a problem is its own way of misleading somebody.
 *
 * SHOWN ONLY WHEN THERE IS A FILE TO DOWNLOAD. While the screen is withholding the download buttons —
 * somebody is missing an identity card number, or the company has no employer code — there is no file to
 * open and no editor to open it in, and a paragraph about word wrap is noise in front of the sentence
 * that actually tells the operator what to fix. Both halves are a RENDER, like the two above: pass
 * `ready` and the markup carries the sentence, pass false and there is no markup at all.
 *
 * The words arrive already translated, so the page keeps one `t('…')` call site per key — which is what
 * test/borang-8a.test.ts scans to prove every key this screen renders exists in every locale.
 */
export function Borang8AOneLineNotice({
  ready,
  title,
  body,
}: {
  /** Whether the downloads are on offer at all. No file, no notice. */
  ready: boolean;
  title: string;
  body: string;
}) {
  if (!ready) return null;
  return (
    <div className="basis-full rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">{title}</p>
      <p className="mt-1">{body}</p>
    </div>
  );
}
