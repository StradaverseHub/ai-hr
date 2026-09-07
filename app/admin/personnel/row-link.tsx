/**
 * THE CLICKABLE TABLE ROW — and the WebKit fact the first attempt at it got wrong.
 *
 * A row that highlights under the pointer has to be clickable across its whole width, and it has to stay
 * a real link: keyboard-focusable, middle-clickable, ⌘-clickable. The obvious shape for that is the
 * STRETCHED LINK — make the `<tr>` the positioning context and let one anchor paint a transparent
 * `::after` across it. IT DOES NOT WORK IN SAFARI, and it does not fail quietly.
 *
 * MEASURED — not inferred, and not in Chromium. This component's own rendered markup, with the app's
 * compiled stylesheet, was loaded into a WKWebView on this machine (AppleWebKit 605.1.15, macOS 26.5,
 * 2026-09-07: the engine Safari uses, and every browser on iOS) and hit-tested with `elementFromPoint`.
 *   • A `<tr>` carrying `position: relative` computes as **static** — WebKit drops the declaration
 *     (bug 240961, filed 2022, fixed on trunk only on 2026-04-11, which is after the newest Safari this
 *     machine can run). With the overlay pinned to the row, EVERY probe on the page answered with the
 *     LAST row's anchor: the cells of the other rows, the paragraph below the table, the top of the
 *     content area. One invisible link over the whole screen, and every click opens the same record.
 *     `<main className="relative …">` in app/layout.tsx is what it escapes to.
 *   • A `<td>` carrying `position: relative` computes as **relative**, and with the overlay pinned to the
 *     cell every probe answered with its own row: all three cells of all three rows, the top and bottom
 *     edge of the short Employee ID cell in a two-line-tall row, the far right end past the last text —
 *     and the paragraph below the table answered with no link at all.
 * NOT measured, and so not claimed: older Safari versions (this machine ships one WebKit), and any engine
 * other than that WebKit and the Chromium test/personnel-row-click.browser.test.tsx runs in. What the
 * Chromium file adds is a case that forces the rows to `static` — the shape WebKit gives them — so a
 * regression back to a row-pinned overlay fails there too, in the engine that would otherwise hide it.
 *
 * WHY NOT A BLOCK WRAPPER INSIDE THE CELL, the other way to avoid positioning the row — measured too, in
 * Chromium, by mutating this file and re-running the browser test: a wrapper is only as tall as its own
 * content, while the CELL is as tall as the row, so an overlay pinned to a wrapper left the top and bottom
 * of every SHORT cell answering with no link. Dead bands the width of the table. The cell is the only box
 * in a table row that is both dependably a containing block and the full height of the row.
 *
 * WHAT A ROW IS MADE OF
 *   • the `<tr>` carries CLICKABLE_ROW_CLS: the hover tint it already had (the tint is the promise), plus
 *     the pointer cursor, so the tint is no longer the only signal. It is NOT a positioning context.
 *   • every `<td>` carries ROW_CELL_CLS — the cell padding AND the positioning. The padding must be on
 *     the same box as the positioning: an overlay pinned to a cell covers that cell's padding too, which
 *     is what closes the gaps between one cell's text and the next.
 *   • the cell showing the name puts ROW_NAME_LINK_CLS on the real, visible, focusable link, whose
 *     `::after` stretches over that one cell.
 *   • every other cell gets a <RowOverlayLink> to the same href: an empty anchor pinned to the cell,
 *     hidden from assistive technology and out of the tab order — so the row is still ONE link and ONE
 *     tab stop for a screen-reader or keyboard user, while a mouse can click, middle-click or ⌘-click
 *     anywhere in it.
 *
 * THE TRADE, stated rather than discovered later: an overlay is the topmost hit target, so dragging the
 * pointer across a cell no longer selects its text — an employee code is copied from the profile page or
 * the Excel export instead. Every stretched link buys its hit area this way; the alternative (an anchor
 * wrapped around the text only) leaves the cell padding and the whole right-hand end of the row dead,
 * which is the defect being fixed.
 */
import Link from 'next/link';

/** The row itself. Deliberately carries NO positioning — see the header: WebKit ignores it on a row. */
export const CLICKABLE_ROW_CLS = 'cursor-pointer hover:bg-muted/40';

/** Every cell of a clickable row: the padding and the positioning have to be the same box. */
export const ROW_CELL_CLS = 'relative px-4 py-3';

/** The overlay: pinned to the cell that contains it, and to nothing else. */
export const ROW_OVERLAY_CLS = 'absolute inset-0';

/** The one visible, focusable link of the row — its `::after` covers the cell it sits in. */
export const ROW_NAME_LINK_CLS =
  "font-medium text-foreground hover:text-primary after:absolute after:inset-0 after:content-['']";

/**
 * The transparent hit area for one cell. `aria-hidden` + `tabIndex={-1}` keep it out of the accessibility
 * tree and out of the tab order: it is the same destination the row's named link already announces, and a
 * row that offered one link per column would be a new defect traded for the old one.
 */
export function RowOverlayLink({ href }: { href: string }) {
  return <Link href={href} className={ROW_OVERLAY_CLS} aria-hidden="true" tabIndex={-1} />;
}
