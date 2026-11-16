#!/usr/bin/env python3
"""css_units.py: put every text size in OneHR's CSS on rem, so the Text size setting (html[data-text]) scales it.

    python3 tools/css_units.py            convert in place (the repo this file lives in)
    python3 tools/css_units.py --dry      count only, change nothing
    python3 tools/css_units.py --check    exit 1 when anything is left to convert (the lint test uses the same rules)
    python3 tools/css_units.py <root>     another checkout (a QC copy, a branch worktree)

What it does, in `static/style.css` and the inline styles of `templates/*.html`:
  * font-size: Npx, line-height: Npx and the size (and /line-height) in a `font:` shorthand become rem (N / 16)
  * every size at 11.5px or less, the rem sizes already in the file included, becomes max(10px, <rem>) so Small
    (87.5%) never draws text under 10px; a size already under 10px floors at its own px (a 10px floor would GROW
    it at Standard, and Standard must stay pixel-identical)
  * widths, paddings, gaps and media queries stay px: text wraps rather than the page growing sideways
Never touched: `@media print` blocks, email templates (a template named *email* or holding `bgcolor`: Outlook has no
rem, and an email preview iframe has its own root), the email builders and in-iframe preview pages in app.py, the
PDF styles, and the certificate canvas in static/learning_certs.js. They are reported, never edited.

Idempotent: a rem value never matches the px rules, and a size already wrapped in max() is never wrapped again.
When a branch merges later, take its CSS as written and run this again (docs: Dark mode and text size plan)."""
import collections
import glob
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXTRA_CSS = ("static/gradeh_calib.css", "static/gradeh_lm.css", "static/gradeh_staff.css")   # stylesheets besides style.css that the same rules hold for
LIMIT_PX = 11.5          # a size at or under this gets the floor


def num(n):
    return ("%.6f" % n).rstrip("0").rstrip(".")


def rem(px):
    return num(px / 16) + "rem"


def wrap(px, text):
    """max(floor, text): the floor is 10px, or the size's own px when that is already under 10px."""
    return "max(%spx, %s)" % (num(10 if px >= 10 else px), text)


def print_spans(text):
    """[(start, end)] of every `@media print { ... }` block."""
    spans = []
    for m in re.finditer(r"@media\s+print\s*\{", text):
        i, d = m.end(), 1
        while i < len(text) and d:
            d += (text[i] == "{") - (text[i] == "}")
            i += 1
        spans.append((m.start(), i))
    return spans


NUM = r"(\d*\.?\d+)"
FS_PX = re.compile(r"(?<![-\w])(font-size\s*:\s*)" + NUM + r"px(?![\w-])")
FS_REM = re.compile(r"(?<![-\w])(font-size\s*:\s*)" + NUM + r"rem(?![\w-])")
LH_PX = re.compile(r"(?<![-\w])(line-height\s*:\s*)" + NUM + r"px(?![\w-])")
# font: [style / variant / weight]* <size>[/<line-height>] family
FONT = re.compile(r"(?<![-\w])(font\s*:\s*(?:(?:italic|oblique|normal|bold|bolder|lighter|small-caps|\d{3})\s+)*)"
                  + NUM + r"px(?:(/)" + NUM + r"(px)?)?(?=\s)")
FONT_REM = re.compile(r"(?<![-\w])(font\s*:\s*(?:(?:italic|oblique|normal|bold|bolder|lighter|small-caps|\d{3})\s+)*)"
                      + NUM + r"rem(?=[\s/])")


def is_email_template(path, text):
    return "email" in os.path.basename(path).lower() or "bgcolor" in text


def convert(text, st):
    spans = print_spans(text)
    inprint = lambda pos: any(a <= pos < b for a, b in spans)       # noqa: E731

    def size(px, orig_text=None):
        if px <= LIMIT_PX:
            st["floored"] += 1
            if px < 10:
                st["floored_under_10px_at_own_size"] += 1
            return wrap(px, orig_text or rem(px))
        return orig_text or rem(px)

    def fs_px(m):
        if inprint(m.start()):
            st["print_left"] += 1
            return m.group(0)
        st["font-size px -> rem"] += 1
        return m.group(1) + size(float(m.group(2)))

    def fs_rem(m):
        if inprint(m.start()):
            return m.group(0)
        px = float(m.group(2)) * 16
        if px > LIMIT_PX:
            return m.group(0)
        st["font-size rem -> floored"] += 1
        return m.group(1) + size(px, m.group(2) + "rem")

    def lh_px(m):
        if inprint(m.start()):
            st["print_left"] += 1
            return m.group(0)
        st["line-height px -> rem"] += 1
        return m.group(1) + rem(float(m.group(2)))

    def font_px(m):
        if inprint(m.start()):
            st["print_left"] += 1
            return m.group(0)
        st["font: shorthand px -> rem"] += 1
        out = m.group(1) + size(float(m.group(2)))
        if m.group(3):
            out += "/" + (rem(float(m.group(4))) if m.group(5) else m.group(4))
        return out

    def font_rem(m):
        if inprint(m.start()):
            return m.group(0)
        px = float(m.group(2)) * 16
        if px > LIMIT_PX:
            return m.group(0)
        st["font: shorthand rem -> floored"] += 1
        return m.group(1) + size(px, m.group(2) + "rem")

    text = FS_PX.sub(fs_px, text)
    text = LH_PX.sub(lh_px, text)
    text = FONT.sub(font_px, text)
    text = FS_REM.sub(fs_rem, text)
    text = FONT_REM.sub(font_rem, text)
    return text


# what is still px after conversion, outside print and outside a max(Npx, ...) floor
LEFT = [re.compile(r"(?<![-\w])font-size\s*:(?!\s*max\()[^;}\"']*\b\d*\.?\d+px"),
        re.compile(r"(?<![-\w])line-height\s*:\s*[^;}\"']*\b\d*\.?\d+px"),
        re.compile(r"(?<![-\w])font\s*:\s*(?:(?:italic|oblique|normal|bold|bolder|lighter|small-caps|\d{3})\s+)*(?!max\()\d*\.?\d+px")]


def leftovers(text):
    spans = print_spans(text)
    out = []
    for rx in LEFT:
        for m in rx.finditer(text):
            if not any(a <= m.start() < b for a, b in spans):
                out.append(m.group(0)[:60])
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    ROOT = os.path.abspath(args[0]) if args else os.path.dirname(HERE)
    DRY = "--dry" in sys.argv
    CHECK = "--check" in sys.argv
    st = collections.Counter()
    css = os.path.join(ROOT, "static/style.css")
    tpls = sorted(glob.glob(os.path.join(ROOT, "templates/*.html")))
    changed, left, skipped = [], [], []
    # the Grade H calibration page's own sheet (polish list, 9 Nov 2026): its sizes were px, so the Text size setting did not reach it
    extra = [os.path.join(ROOT, r) for r in EXTRA_CSS if os.path.isfile(os.path.join(ROOT, r))]
    for p in [css] + extra + tpls:
        src = open(p, encoding="utf-8").read()
        rel = os.path.relpath(p, ROOT)
        if p != css and p not in extra and is_email_template(p, src):
            skipped.append(rel)
            continue
        out = convert(src, st)
        if out != src:
            changed.append(rel)
            if not DRY and not CHECK:
                open(p, "w", encoding="utf-8").write(out)
        for s in leftovers(out):
            left.append((rel, s))
    def grep(pattern, paths):
        """grep over real files only (grep with no file reads stdin and never returns), nothing printed from a missing one."""
        paths = [x for x in paths if os.path.isfile(x)]
        if not paths:
            return []
        return subprocess.run(["grep", "-nE", pattern] + paths, capture_output=True, text=True,
                              stdin=subprocess.DEVNULL).stdout.strip().splitlines()
    notes = {}
    notes["email templates skipped"] = skipped
    notes["static/*.js with a px size (the certificate canvas)"] = grep(
        r"style\.fontSize|font-size: *[0-9.]+px", glob.glob(os.path.join(ROOT, "static/*.js")))
    notes["app.py px sizes (email builders, email preview pages, PDF styles: left alone)"] = [
        l[:20] for l in grep(r"font(-size)?: *[0-9.]+px", [os.path.join(ROOT, "app.py")])]
    print(json.dumps({"converted": dict(st), "files_changed": len(changed), "changed": changed,
                      "still_px_outside_print_and_floor": len(left),
                      "not_scanned": {k: len(v) for k, v in notes.items()}}, indent=1))
    for rel, s in left[:20]:
        print("LEFT:", rel, "|", s)
    if CHECK:
        sys.exit(1 if (changed or left) else 0)


if __name__ == "__main__":
    main()
