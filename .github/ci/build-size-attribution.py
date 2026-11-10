#!/usr/bin/env python3
"""DIAGNOSTIC ONLY, never release evidence: measure a finished .next tree.

Writes per-file rows (path, size, sha256, first-occurrence gzip-9 size), per-directory
and per-extension totals (logical and unique-content), and source-map attribution: for
every unique .map, the sourcesContent bytes per original source path.
"""
import gzip, hashlib, json, os, sys, zlib
from collections import defaultdict

root, out = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
os.makedirs(out, exist_ok=True)
EXCLUDED = {"cache", "dev"}
rows, seen = [], {}
for dirpath, dirnames, filenames in os.walk(root):
    rel_dir = os.path.relpath(dirpath, root)
    if rel_dir == ".":
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDED)
    else:
        dirnames.sort()
    for name in sorted(filenames):
        path = os.path.join(dirpath, name)
        if os.path.islink(path) or not os.path.isfile(path):
            continue
        rel = os.path.relpath(path, root)
        with open(path, "rb") as stream:
            data = stream.read()
        digest = hashlib.sha256(data).hexdigest()
        first = digest not in seen
        gz = None
        if first:
            gz = len(zlib.compress(data, 9))
            seen[digest] = rel
        rows.append({"path": rel, "size": len(data), "sha256": digest, "unique": first, "gz9": gz})

def bucket(path):
    parts = path.split("/")
    if len(parts) == 1:
        return "root"
    if parts[0] == "server" and len(parts) > 2 and parts[1] in ("app", "chunks", "pages"):
        if parts[1] == "chunks" and len(parts) > 3:
            return "server/chunks/" + parts[2]
        return "server/" + parts[1]
    if parts[0] == "static" and len(parts) > 2:
        return "static/" + parts[1]
    return parts[0]

def ext(path):
    for suffix in (".nft.json", ".js.map", ".map", ".json", ".mjs", ".js", ".css", ".html", ".rsc", ".meta", ".body", ".ts"):
        if path.endswith(suffix):
            return suffix
    return os.path.splitext(path)[1] or "none"

totals = {"dir": defaultdict(lambda: [0, 0, 0, 0]), "ext": defaultdict(lambda: [0, 0, 0, 0])}
for row in rows:
    for kind, key in (("dir", bucket(row["path"])), ("ext", ext(row["path"]))):
        t = totals[kind][key]
        t[0] += 1; t[1] += row["size"]
        if row["unique"]:
            t[2] += row["size"]; t[3] += row["gz9"]

sources = defaultdict(lambda: [0, 0])  # bytes of sourcesContent across unique maps, number of unique maps
static_sources = defaultdict(lambda: [0, 0])
map_errors = 0
for row in rows:
    if not row["unique"] or not row["path"].endswith(".map"):
        continue
    try:
        with open(os.path.join(root, row["path"]), "rb") as stream:
            data = json.load(stream)
    except Exception:
        map_errors += 1
        continue
    maps = [section.get("map", {}) for section in data.get("sections", [])] if "sections" in data else [data]
    target = static_sources if row["path"].startswith("static/") else sources
    local = defaultdict(int)
    for item in maps:
        names = item.get("sources") or []
        contents = item.get("sourcesContent") or []
        for index, name in enumerate(names):
            content = contents[index] if index < len(contents) else None
            local[name] += len(content.encode("utf-8")) if isinstance(content, str) else 0
    for name, size in local.items():
        target[name][0] += size
        target[name][1] += 1

def ranked(table, limit):
    return [{"source": k, "bytes": v[0], "maps": v[1]} for k, v in sorted(table.items(), key=lambda kv: -kv[1][0])[:limit]]

def chunk_rank(prefix, limit):
    picked = [r for r in rows if r["path"].startswith(prefix) and r["unique"]]
    return sorted(picked, key=lambda r: -r["size"])[:limit]

summary = {
    "kind": "BUILD_SIZE_ATTRIBUTION_DIAGNOSTIC_NOT_RELEASE",
    "files": len(rows), "logicalBytes": sum(r["size"] for r in rows),
    "uniqueBytes": sum(r["size"] for r in rows if r["unique"]), "uniqueGz9Bytes": sum(r["gz9"] for r in rows if r["unique"]),
    "mapErrors": map_errors,
    "directoryTotals": {k: dict(zip(("files", "bytes", "uniqueBytes", "uniqueGz9"), v)) for k, v in sorted(totals["dir"].items())},
    "extensionTotals": {k: dict(zip(("files", "bytes", "uniqueBytes", "uniqueGz9"), v)) for k, v in sorted(totals["ext"].items())},
    "largestStatic": chunk_rank("static/", 40),
    "largestUnique": sorted([r for r in rows if r["unique"]], key=lambda r: -r["size"])[:60],
}
with open(os.path.join(out, "summary.json"), "w") as stream:
    json.dump(summary, stream, indent=1)
with gzip.open(os.path.join(out, "files.jsonl.gz"), "wt") as stream:
    for row in rows:
        stream.write(json.dumps(row) + "\n")
with gzip.open(os.path.join(out, "map-sources.json.gz"), "wt") as stream:
    json.dump({"server": ranked(sources, 20000), "static": ranked(static_sources, 20000)}, stream)
print(json.dumps({k: summary[k] for k in ("files", "logicalBytes", "uniqueBytes", "uniqueGz9Bytes", "mapErrors")}))
