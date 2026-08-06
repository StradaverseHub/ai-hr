# Plan mockups — design the screen before building it

A board plan is ~6,000 characters of plain text that the board renders **raw** (no Markdown — see
`.claude/skills/feedback-plan`). The reporter reads it, presses approve, and finds out what we meant
when the build lands.

**They do not communicate that way.** Of 151 attachments on production, **143 are images**. They send
screenshots; we send prose. When the screen that arrives is not what they pictured, the item comes back —
`e7eb5d83` returned from `deployed` as *"the whole thing is crap, can you delete everything and based on
my request to rebuild again?"*.

So: **draw it first, attach it to the plan, let them look before they decide.**

## How

```bash
pnpm mockup docs/mockups/da4af51f-payslip.html /tmp/da4af51f-payslip.png --width 1280
```

Then push it with the plan — one call, and the ordering is handled for you:

```bash
echo '{"id":"…","tenantId":"…","reporterEmploymentId":"…","plan":"…","model":"claude-opus-5",
       "mockupPaths":["/tmp/da4af51f-payslip.png"]}' | pnpm improve:push-plan
```

`plan_revision` is stamped **server-side from the item**, so a mockup always names the plan it
illustrates. The board shows only the current revision's mockups beside the plan; older generations stay
reachable in the timeline. Attach after pushing, never before — `pushPlanWithMockups` enforces the order.

## The rules that matter

**A mockup is a PROMISE, and a picture cannot hedge.** The `da4af51f` plan says *"we will show every line
we have and totals where we do not"* — that sentence has no honest visual. Draw the certain parts; leave
the uncertain ones in words. A picture that overpromises manufactures a *new* class of "not up to
standard", which is the problem this exists to solve, not to relocate.

**Label it a sketch.** The board prints a caveat under every mockup in all six languages
(`feedback.planMockupsCaveat`) saying wording, spacing and colours will differ. That caveat is doing real
work — do not quietly make the mockup pixel-exact and start implying otherwise.

**Prefer BEFORE and AFTER where the screen exists.** Most contested items are *"four of your six points
already work"*, and prose has repeatedly failed to land that. Screenshot the real screen from a dev
server, put it beside the proposal, and the argument makes itself:

```bash
# before — the real thing, from a dev server
pnpm dev &
# navigate, then capture with the browser tooling, or point render.ts at a saved copy
```

**Everything must be inline.** `render.ts` blocks every non-`file:`/`data:` request and fails loudly if
the page reached for one, rather than silently shipping an image with no font or icons. Inline CSS in a
`<style>` block; embed images as `data:` URIs.

**Use the product's real look.** A mockup that imports the app's own stylesheet is a picture of *our*
app. A generic bootstrap-looking form is a picture of somebody else's, and the reporter will judge it as
one.

## What the reporter sees

The image renders **inline** in the plan card — full width, no click required — with the file name under
it and the sketch caveat above. Non-image attachments and older revisions fall back to the link list at
the top of the page, so nothing is ever invisible.
