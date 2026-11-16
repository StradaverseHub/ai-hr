"""Dark mode's palette is readable (Chris, 2026-11-01; canvas board C1; OneHR/Dark mode build brief 2026-11-01.md).

Parses the colour token blocks IN static/style.css (the light :root block and the dark block that tools/css_tokens.py writes
from its table) and checks, in light AND dark, every text-on-background pair board C1 lists:
  * text: at least 4.5:1 (WCAG AA body text)
  * a UI outline that must be seen (the focus ring / selected outline, --accent-line): at least 3:1
  * the dark ratios are the ones C1 prints (13.9, 10.0, 6.8, 5.0 ...), so a changed palette value shows here
Light has two known misses that are today's look and are allowlisted with a comment: --faint on a white or grey ground (3.2:1) and
the amber ink on its tint (4.3:1). Dark must have none.
The lines (--line, --line-soft, --line-strong) are decorative separators: WCAG exempts them, so they are not held to 3:1.
Also: every derived dark text colour (--d-fg-*) keeps at least 4.5:1 on the dark page and on the grey ground, so a derived token
cannot quietly drop under the line; and a planted low-contrast pair is caught.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

s = H.Suite("Dark mode: the palette is readable (4.5:1 text, 3:1 outlines) in light and dark")
CSS = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
BEGIN = CSS.index("/* css_tokens:begin")
END = CSS.index("/* css_tokens:end */")
REGION = CSS[BEGIN:END]


def block(selector):
    m = re.search(re.escape(selector) + r" \{(.*?)\n\}", REGION, re.S)
    return dict(re.findall(r"--([\w-]+):\s*([^;]+);", m.group(1))) if m else {}


LIGHT = block(":root")
DARK = block("html[data-theme=dark]")


def rgb(v):
    v = v.strip().lower()
    m = re.match(r"^#([0-9a-f]{6})$", v)
    if m:
        h = m.group(1)
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return None


def lum(c):
    f = lambda x: (lambda y: y / 12.92 if y <= 0.03928 else ((y + 0.055) / 1.055) ** 2.4)(x / 255)  # noqa: E731
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])


def ratio(a, b):
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def r_of(block_, fg, bg):
    a, b = rgb(block_.get(fg, "")), rgb(block_.get(bg, ""))
    return ratio(a, b) if a and b else None


s.section("the token blocks parse")
s.check("the light block and the dark block are in style.css (dozens of tokens each)", len(LIGHT) > 40 and len(DARK) > 40, (len(LIGHT), len(DARK)))
s.check("every token the pairs below use is in both blocks", all(k in LIGHT and k in DARK for k in
        "page surface surface-2 surface-3 ink ink-2 muted faint accent-ink link accent accent-line on-fill ai ai-ink ai-tint danger-ink ok-tint ok-ink ok-fill "
        "info-tint info-ink warn-tint warn-ink bad-tint bad-ink ua-bg ua-fg be-bg be-fg me-bg me-fg ae-bg ae-fg ou-bg ou-fg seg-on".split()))

# (text token, ground token, C1's printed dark ratio or None). Every text-on-background pair C1 lists, and the grounds a text sits on.
TEXT = [
    ("ink", "page", None), ("ink", "surface", 13.9), ("ink", "surface-2", None), ("ink", "surface-3", None),
    ("ink-2", "surface", 10.0), ("ink-2", "page", None), ("ink-2", "surface-2", None),
    ("muted", "surface", 6.8), ("muted", "surface-3", 5.6), ("muted", "page", None), ("muted", "surface-2", None),
    ("faint", "surface", 5.0), ("faint", "page", None),
    ("accent-ink", "surface", 11.1), ("accent-ink", "page", None), ("accent-ink", "surface-2", None), ("accent-ink", "seg-on", None),
    ("link", "surface", 7.5), ("link", "page", None),
    ("on-fill", "accent", 6.6), ("on-fill", "ai", 5.2), ("on-fill", "ok-fill", None),
    ("ai-ink", "surface", 6.1), ("ai-ink", "ai-tint", None), ("danger-ink", "surface", 6.6),
    ("ok-ink", "ok-tint", 7.8), ("info-ink", "info-tint", 7.2), ("warn-ink", "warn-tint", 7.7), ("bad-ink", "bad-tint", 7.8),
    ("ua-fg", "ua-bg", 7.8), ("be-fg", "be-bg", 7.7), ("me-fg", "me-bg", 7.9), ("ae-fg", "ae-bg", 8.3), ("ou-fg", "ou-bg", 8.1),
]
OUTLINE = [("accent-line", "page"), ("accent-line", "surface"), ("accent-line", "surface-2"), ("accent-line", "surface-3")]
# today's light look, known and allowed (Chris's plan: --faint 3.2:1, the amber ink on its tint 4.3:1)
LIGHT_ALLOWED = {("faint", "surface"), ("faint", "page"), ("warn-ink", "warn-tint")}

s.section("dark: every pair is at least 4.5:1 (and is the ratio C1 prints)")
miss = [(f, b, round(r_of(DARK, f, b), 2)) for f, b, _ in TEXT if r_of(DARK, f, b) < 4.5]
s.check("no text pair in dark is under 4.5:1 (%d pairs)" % len(TEXT), not miss, miss)
off = [(f, b, round(r_of(DARK, f, b), 2), c1) for f, b, c1 in TEXT if c1 and abs(r_of(DARK, f, b) - c1) > 0.15]
s.check("the ratios are the ones board C1 prints (13.9, 10.0, 6.8, 5.6, 5.0, 11.1 ... within 0.15)", not off, off)
omiss = [(f, b, round(r_of(DARK, f, b), 2)) for f, b in OUTLINE if r_of(DARK, f, b) < 3]
s.check("the accent outline (focus ring, selected) is at least 3:1 on every dark ground", not omiss, omiss)

s.section("light: the same pairs, with today's two known misses allowlisted")
lmiss = [(f, b, round(r_of(LIGHT, f, b), 2)) for f, b, _ in TEXT if r_of(LIGHT, f, b) < 4.5 and (f, b) not in LIGHT_ALLOWED]
s.check("no light pair is under 4.5:1 except the allowlisted (--faint on white / grey 3.2:1, the amber ink on its tint 4.3:1: today's look)", not lmiss, lmiss)
s.check("(the allowlisted ones really are the misses: --faint is ~3.2:1 and the amber ink ~4.3:1, so the allowlist is not hiding more)",
        3.0 < r_of(LIGHT, "faint", "surface") < 3.4 and 4.2 < r_of(LIGHT, "warn-ink", "warn-tint") < 4.5, (r_of(LIGHT, "faint", "surface"), r_of(LIGHT, "warn-ink", "warn-tint")))
lo = [(f, b, round(r_of(LIGHT, f, b), 2)) for f, b in OUTLINE if r_of(LIGHT, f, b) < 3]
s.check("the accent outline is at least 3:1 on every light ground", not lo, lo)

s.section("the six misses on the canvas note")
s.check("\"No Data\" uses --faint's value in dark (the pale grey it is today stays in light)", DARK.get("nodata") == DARK.get("faint") and LIGHT.get("nodata") == "#c9cdd8")
s.check("the target ticks in Distribution vs. target are --ink, so they turn light in dark",
        re.search(r"\.calib-dist-tick \{[^}]*background: var\(--ink\)", CSS) is not None and rgb(DARK["ink"]) and lum(rgb(DARK["ink"])) > 0.5)
s.check("\"Need +11 more\" keeps the warn ink (a text pair that passes 4.5:1 on the dark surface)", r_of(DARK, "warn-ink", "surface") >= 4.5)
s.check("the Get Help icon is --accent-ink: today's navy in light, light in dark (passes 3:1 on the dark surface)",
        re.search(r"\.acct-help svg \{[^}]*stroke: var\(--accent-ink\)", CSS) is not None
        and re.search(r"\.acct-help-dot \{ fill: var\(--accent-ink\)", CSS) is not None
        and LIGHT.get("accent-ink") == "#252a59" and r_of(DARK, "accent-ink", "surface") >= 3)
s.check("a number on a navy fill is white (--on-fill) in both themes", LIGHT["on-fill"] == "#ffffff" and DARK["on-fill"] == "#ffffff")

s.section("a derived dark text colour cannot slip under the line")
d_fg = {k: v for k, v in DARK.items() if k.startswith("d-fg-")}
low = []
for k, v in d_fg.items():
    c = rgb(v)
    if c and (ratio(c, rgb(DARK["surface"])) < 4.5 or ratio(c, rgb(DARK["surface-3"])) < 4.5):
        # a pale text on a fill (white, light grey) keeps its light value: it is for a fill, not for the page
        light_v = rgb(LIGHT.get(k, ""))
        if not (light_v and lum(light_v) >= 0.6):
            low.append((k, v))
s.check("every derived dark text colour (--d-fg-*, %d of them) is 4.5:1 on the dark surface and on the grey ground" % len(d_fg), not low, low[:8])
pale = [k for k in d_fg if rgb(LIGHT.get(k, "")) and lum(rgb(LIGHT[k])) >= 0.6]
s.check("...except pale text meant for a fill (%d): it is the same colour lifted just enough to read on --accent (luminance 0.70, 4.5:1 on #4B54B0), never darker" % len(pale),
        all(lum(rgb(DARK.get(k, LIGHT[k]))) >= 0.70 - 0.005 and lum(rgb(DARK.get(k, LIGHT[k]))) >= lum(rgb(LIGHT[k])) - 1e-9 for k in pale)
        and all(ratio(rgb(DARK.get(k, LIGHT[k])), rgb(DARK["accent"])) >= 4.5 for k in pale), [k for k in pale if ratio(rgb(DARK.get(k, LIGHT[k])), rgb(DARK["accent"])) < 4.5][:5])

s.section("the check catches a bad pair")
s.check("a planted pair (#9aa0b0 on white) is under 4.5:1 and would be flagged", ratio((0x9a, 0xa0, 0xb0), (255, 255, 255)) < 4.5)
s.check("a planted pair (#858ca3 on #262b44) is under 4.5:1 too: the grey ground is the one that needs the higher floor", ratio((0x85, 0x8c, 0xa3), (0x26, 0x2b, 0x44)) < 4.5)

sys.exit(s.done())
