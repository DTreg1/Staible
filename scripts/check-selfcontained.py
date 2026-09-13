#!/usr/bin/env python3
"""Fail if the page gained an external dependency.

Staible's promise is one file, no build, no CDN. Google Fonts is the single
allowed remote origin (the Artifact sandbox permits it and nothing else).
Anything else creeping in -- a CDN script, a stylesheet, a remote image --
breaks the promise, so CI refuses it.
"""
import re, sys

ALLOWED = ("https://fonts.googleapis.com", "https://fonts.gstatic.com")
ATTR = re.compile(r"""<(script|link|img|iframe|source)\b[^>]*?\b(src|href)\s*=\s*["']([^"']+)["']""", re.I)

def main(path):
    html = open(path, encoding="utf-8").read()
    bad = []
    for tag, attr, url in ATTR.findall(html):
        u = url.strip()
        if u.startswith(("#", "data:", "blob:")):
            continue
        if u.startswith(ALLOWED):
            continue
        if u.startswith(("http://", "https://", "//")):
            bad.append(f"{tag} {attr}={u}")
        else:
            bad.append(f"{tag} {attr}={u}  (local file — the page must be self-contained)")
    if bad:
        print(f"{path} is no longer self-contained:")
        for b in bad:
            print("  " + b)
        return 1
    print(f"ok  {path} is self-contained")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "index.html"))
