#!/usr/bin/env python3
"""build_single.py — fold the split project back into one portable HTML file.

The project is split so it can be worked on; this puts it back together so it
can be carried around. Output: dist/btc-stochastic.html, which behaves exactly
like the split app and needs nothing next to it.

    python tools/build_single.py

part of Odysseus
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
OUT = ROOT / "dist" / "btc-stochastic.html"

CSS_LINK = re.compile(r'^\s*<link rel="stylesheet" href="(css/[^"]+)">\s*$')
SCRIPT_SRC = re.compile(r'^\s*<script src="(js/[^"]+)"></script>\s*$')


def main() -> int:
    if not INDEX.exists():
        print(f"can't find {INDEX}", file=sys.stderr)
        return 1

    out, css, js = [], [], []
    css_slot = js_slot = None

    for raw in INDEX.read_text(encoding="utf-8").split("\n"):
        m_css, m_js = CSS_LINK.match(raw), SCRIPT_SRC.match(raw)
        if m_css:
            css.append(m_css.group(1))
            if css_slot is None:
                css_slot = len(out)
                out.append(None)          # placeholder for the whole <style> block
        elif m_js:
            js.append(m_js.group(1))
            if js_slot is None:
                js_slot = len(out)
                out.append(None)          # placeholder for the whole <script> block
        else:
            out.append(raw)

    def read(rel: str) -> str:
        p = ROOT / rel
        if not p.exists():
            raise SystemExit(f"index.html references {rel}, which does not exist")
        return p.read_text(encoding="utf-8").rstrip("\n")

    if css_slot is not None:
        out[css_slot] = "<style>\n" + "\n".join(read(f) for f in css) + "\n</style>"
    if js_slot is not None:
        out[js_slot] = "<script>\n" + "\n".join(read(f) for f in js) + "\n</script>"

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(out), encoding="utf-8")

    kb = OUT.stat().st_size / 1024
    print(f"built {OUT.relative_to(ROOT)}  ({kb:,.0f} KB)")
    print(f"  {len(css)} stylesheets + {len(js)} scripts inlined, in load order")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
