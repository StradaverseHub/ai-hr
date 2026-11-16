"""Every download header goes through _attachment_header (10 Nov 2026).

A hand-built Content-Disposition either crashes on a name beyond Latin-1 (the evidence download's 502) or strips the
name to ASCII (a Chinese or accented name arrived as ".pdf" or "Caf  quote.pdf"). This lint reads app.py and fails on
any line that sets Content-Disposition other than through a call to _attachment_header(...) (the helper's own body is
the one place the header string is built). Falsified by feeding the same checker a hand-built line. Also checks the
helper itself: a CR/LF or control character in a stored name never reaches the header, and a non-Latin-1 name encodes.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Download headers all use _attachment_header")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"


def offenders(src):
    """(line number, text) of every Content-Disposition line not built by _attachment_header, outside its def."""
    bad, in_helper = [], False
    for n, line in enumerate(src.splitlines(), 1):
        if line.startswith("def _attachment_header"):
            in_helper = True
            continue
        if in_helper and line and not line[0].isspace() and not line.startswith(('"""', "'''")):
            in_helper = False
        if in_helper or "content-disposition" not in line.lower():
            continue
        if re.search(r"Content-Disposition[\"']\s*[\]:=,]+\s*_attachment_header\(", line) or \
                re.search(r"Content-Disposition[\"']\]\s*=\s*_attachment_header\(", line):
            continue
        if re.match(r"\s*#", line):
            continue
        bad.append((n, line.strip()))
    return bad


with open(os.path.join(H.REPO, "app.py"), encoding="utf-8") as fh:
    SRC = fh.read()
bad = offenders(SRC)
s.check("no route builds Content-Disposition by hand (all go through _attachment_header)", not bad, bad[:5])
s.check("the lint sees the real call sites", len(re.findall(r"Content-Disposition[\"']\]?\s*[:=]\s*_attachment_header\(", SRC)) >= 8)

# falsify: hand-built lines of every shape the old code used must be caught
for plant in ('    headers={"Content-Disposition": f"attachment; filename={fname}"})',
              """    resp.headers["Content-Disposition"] = 'inline; filename="%s"' % safe""",
              """    headers={"Content-Disposition": 'attachment; filename="%s.xlsx"' % name})"""):
    s.check("falsified: a planted hand-built header is caught (%s...)" % plant.strip()[:40],
            len(offenders(SRC + "\n" + plant + "\n")) == len(bad) + 1)

# the helper itself
h = a._attachment_header("Café — 报价单.pdf", "inline")
s.check("a name beyond Latin-1 encodes: Latin-1 safe, UTF-8 form present", h.startswith("inline;") and
        "filename*=UTF-8''Caf%C3%A9%20%E2%80%94%20%E6%8A%A5%E4%BB%B7%E5%8D%95.pdf" in h and h.encode("latin-1") is not None, h)
h = a._attachment_header('a\r\nSet-Cookie: x=1\x00\x1b"b\\c.pdf')
s.check("CR, LF, NUL, ESC, quote and backslash never reach the header raw", not re.search(r"[\x00-\x1f\x7f]", h)
        and h.count('"') == 2 and "\\" not in h and "%0D%0A" in h, repr(h))
sys.exit(s.done())
