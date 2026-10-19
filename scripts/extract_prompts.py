#!/usr/bin/env python3
"""Extract Hermes' review/curator prompt constants verbatim into JSON.

Uses ast so the text is byte-identical to what the running agent sends; no
hand-copying, no paraphrase. Python string concatenation (`+`) and module-level
refs are resolved the way Python would; f-strings keep literal parts and report
placeholders in `dynamic`.
"""
import ast
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
OUT = Path(os.environ['HERMES_EVOLVE_OUT']) if os.environ.get('HERMES_EVOLVE_OUT') else HERE / 'src' / 'prompts.hermes.json'
SOURCE = 'NousResearch/hermes-agent@d923a5eb48 (v0.22.2)'


def hermes_root() -> Path:
    if len(sys.argv) > 1:
        return Path(sys.argv[1]).resolve()
    env = os.environ.get('HERMES_SRC')
    if env:
        return Path(env).resolve()
    return (HERE.parent / 'hermes-agent').resolve()


ROOT = hermes_root()
if not (ROOT / 'agent').is_dir():
    raise SystemExit(f'not a hermes checkout: {ROOT} (pass the path as argv[1] or $HERMES_SRC)')
WANT = {
    'agent/background_review.py': [
        '_MEMORY_ROUTING_BLOCK', '_MEMORY_REVIEW_PROMPT', '_LESSON_LAYER_BLOCK',
        '_DO_NOT_CAPTURE_BLOCK', '_SKILL_REVIEW_PROMPT', '_COMBINED_REVIEW_PROMPT',
    ],
    'agent/curator.py': ['CURATOR_DRY_RUN_BANNER', 'CURATOR_REVIEW_PROMPT'],
}
dynamic = {}


def add(left, right):
    parts = []
    for side in (left, right):
        if isinstance(side, dict) and '__concat__' in side:
            parts.extend(side['__concat__'])
        else:
            parts.append(side)
    if all(isinstance(p, str) for p in parts):
        return ''.join(parts)
    return {'__concat__': parts}


def eval_node(node, src):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        out = []
        for part in node.values:
            if isinstance(part, ast.Constant):
                out.append(str(part.value))
            elif isinstance(part, ast.FormattedValue):
                expr = ast.get_source_segment(src, part.value) or '?'
                out.append('{' + expr + '}')
                dynamic[expr] = dynamic.get(expr, 0) + 1
            else:
                raise ValueError(f'unhandled fstring part {part}')
        return ''.join(out)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return add(eval_node(node.left, src), eval_node(node.right, src))
    if isinstance(node, ast.Name):
        return {'__ref__': node.id}
    raise ValueError(f'unhandled node {ast.dump(node)[:160]}')


raw = {}
for rel, names in WANT.items():
    src = (ROOT / rel).read_text(encoding='utf-8')
    tree = ast.parse(src)
    found = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    found[target.id] = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            found[node.target.id] = node.value
    for name in names:
        if name not in found:
            print(f'MISSING {rel}:{name}', file=sys.stderr)
            continue
        raw[name] = eval_node(found[name], src)


def resolve(value, depth=0):
    if depth > 12:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and '__ref__' in value:
        target = raw.get(value['__ref__'])
        return None if target is None else resolve(target, depth + 1)
    if isinstance(value, dict) and '__concat__' in value:
        pieces = []
        for part in value['__concat__']:
            got = resolve(part, depth + 1)
            if got is None:
                return None
            pieces.append(got)
        return ''.join(pieces)
    return None


texts = {}
unresolved = []
for name, value in raw.items():
    got = resolve(value)
    if got is None:
        unresolved.append(name)
        texts[name] = ''
    else:
        texts[name] = got

OUT.write_text(json.dumps({
    'source': 'NousResearch/hermes-agent@d923a5eb48 (v0.22.2)',
    'texts': texts,
    'dynamic': sorted(dynamic),
}, ensure_ascii=False, indent=1), encoding='utf-8')
print('wrote', len(texts), 'texts; unresolved:', unresolved, 'dynamic:', sorted(dynamic))
for key, val in texts.items():
    print(f'{key:26s} {len(val):6d} chars')
