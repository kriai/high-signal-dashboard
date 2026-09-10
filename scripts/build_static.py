#!/usr/bin/env python3
"""Generate Cloudflare static assets from the single Flask template source."""

from pathlib import Path
import re
import shutil


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / 'templates' / 'index.html'
STATIC = ROOT / 'static'
OUTPUT = ROOT / 'dist'
ASSET_URL = re.compile(
    r"\{\{\s*url_for\(['\"]static['\"],\s*filename=['\"]([^'\"]+)['\"]\)\s*\}\}")


def build():
    html = TEMPLATE.read_text()
    html, replacements = ASSET_URL.subn(lambda match: '/static/' + match.group(1), html)
    leftovers = re.findall(r'\{[{%].*?[}%]\}', html)
    if leftovers:
        raise RuntimeError('Unresolved template expressions: ' + ', '.join(leftovers[:3]))
    if replacements == 0:
        raise RuntimeError('No static asset URLs were resolved')

    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT / 'index.html').write_text(html)
    target = OUTPUT / 'static'
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(STATIC, target)
    print(f'Built {OUTPUT / "index.html"} and {replacements} asset URLs')


if __name__ == '__main__':
    build()
