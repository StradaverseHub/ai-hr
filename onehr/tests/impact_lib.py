"""Shared helpers for the impact map (tests/impact_map.py) and the touched-suites picker (tests/affected.py).

Suite speed plan, Change 2 (6 Nov 2026). Standard library only. Functions are keyed by FILE + top-level def name
("app.py::login", methods as "Class.method"), never by line number, so the map survives code moving.
"""
import ast

# A def counts as "reached" by a suite when the suite ran a line of its BODY. The `def` line itself (and its decorators)
# run at import time in every suite, so they say nothing. A def whose body starts on the `def` line (`def f(): return 1`)
# cannot be told apart, so it is left out of the map; the picker's grep fallback covers it.


class Def:
    __slots__ = ("key", "start", "body", "end")

    def __init__(self, key, start, body, end):
        self.key, self.start, self.body, self.end = key, start, body, end   # start = first decorator or `def`; body..end = the body


def _fn(node, prefix=""):
    start = min([d.lineno for d in node.decorator_list] + [node.lineno])
    return Def(prefix + node.name, start, node.body[0].lineno, node.end_lineno), node


def parse(source):
    """-> (tree, defs, def_nodes): every top-level def and top-level class method."""
    tree = ast.parse(source)
    defs, nodes = [], {}
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            d, node = _fn(n)
            defs.append(d)
            nodes[d.key] = node
        elif isinstance(n, ast.ClassDef):
            for m in n.body:
                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    d, node = _fn(m, n.name + ".")
                    defs.append(d)
                    nodes[d.key] = node
    return tree, defs, nodes


def def_is_mappable(d, nodes):
    node = nodes[d.key]
    return d.body > node.lineno   # the body starts after the `def` line


def module_stmt_names(tree, lo, hi):
    """Names assigned by the top-level statements that overlap lines lo..hi and are not defs (module-level code)."""
    names = set()
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        start = min([d.lineno for d in getattr(n, "decorator_list", [])] + [n.lineno])
        if start <= hi and n.end_lineno >= lo:
            if isinstance(n, ast.ClassDef):
                spans = [(min([d.lineno for d in m.decorator_list] + [m.lineno]), m.end_lineno) for m in n.body
                         if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))]
                a, b = max(lo, start), min(hi, n.end_lineno)
                if any(not any(x <= l <= y for x, y in spans) for l in range(a, b + 1)):   # a class-level line, not a method's
                    names.add(n.name)
                continue
            for x in ast.walk(n):
                if isinstance(x, ast.Name) and isinstance(x.ctx, (ast.Store, ast.Del)):
                    names.add(x.id)
    return names


def readers_of(nodes, names):
    """Keys of the defs whose code reads any of `names`."""
    out = set()
    if not names:
        return out
    for key, node in nodes.items():
        for x in ast.walk(node):
            if isinstance(x, ast.Name) and x.id in names:
                out.add(key)
                break
    return out


def defs_touching(defs, lo, hi):
    return [d for d in defs if d.start <= hi and d.end >= lo]
