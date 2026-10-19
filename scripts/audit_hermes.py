#!/usr/bin/env python3
"""Differential audit: dsh-hermes-evolve vs the hermes-agent it was ported from.

Two independent checks, both machine-verifiable:

1. verbatim  -- re-run the two extractors against a live hermes checkout and
                diff the result against what this repo ships
                (src/prompts.hermes.json, src/schemas.hermes.json,
                src/tool_schemas.js). Catches hand-edits and upstream drift.
2. linter    -- feed the same SKILL.md fixtures to hermes' own
                tools.skill_linter.lint_content() and to this repo's
                src/skill_linter.js, then compare the rule sets.

Hermes' pure modules import fine on python >= 3.11 once ruamel.yaml (and
pyyaml, which the frontmatter parser digs into) are installed; the system
python on many machines is 3.10, which fails on ``datetime.UTC``. Hence the
explicit interpreter checks below -- a skip must never look like a pass.

    python3 scripts/audit_hermes.py --hermes /path/to/hermes-agent
    python3 scripts/audit_hermes.py --hermes ... --python /tmp/venv/bin/python

Exit codes: 0 every check ran and matched, 1 a check failed, 2 a check was
skipped by the environment (missing checkout / old interpreter / no node).
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SRC = HERE / 'src'


# ---------------------------------------------------------------- fixtures
def linter_fixtures():
    """One SKILL.md per rule, each written to trigger that rule and only it.

    The point is the *set of rules* hermes and this port report, not the
    wording of the messages, so fixtures lean on one violation each.
    """
    return {
        'clean': (
            '---\nname: clean-skill\ndescription: Extract text and tables from PDF files.\n'
            'version: 1.0.0\nauthor: audit\nlicense: MIT\n'
            'metadata:\n  hermes:\n    tags: [pdf, text]\n    related_skills: []\n---\n\n'
            '# Clean Skill\n\n## When to Use\n\nWhen a PDF needs text extraction.\n\n'
            '## Procedure\n\n1. Run the extractor.\n\n## Verification\n\nOpen the output.\n'
        ),
        'name-format': (
            '---\nname: Bad_Name\ndescription: Extract text and tables from PDF files.\n---\n\n'
            '# Bad\n\n## When to Use\n\nNever.\n'
        ),
        'description-missing': (
            '---\nname: nodesc\n---\n\n# No Desc\n\n## When to Use\n\nNever.\n'
        ),
        'description-marketing': (
            '---\nname: marketed\ndescription: The revolutionary, blazing-fast way to extract PDF text.\n---\n\n'
            '# Marketed\n\n## When to Use\n\nNever.\n'
        ),
        'oversized-body': (
            '---\nname: huge\ndescription: Extract text and tables from PDF files.\n---\n\n'
            '# Huge\n\n## When to Use\n\nNever.\n\n' + ('filler prose about the task. ' * 900) + '\n'
        ),
        'incident-log-shape': (
            '---\nname: incident\ndescription: Extract text and tables from PDF files.\n---\n\n'
            '# Incident\n\n## When to Use\n\nNever.\n\n'
            + 'Fixed in #12345 after the crash. ' * 6 + '\n'
        ),
        'description-length': (
            '---\nname: longdesc\ndescription: ' + 'x' * 70 + '\n---\n\n'
            '# Long Desc\n\n## When to Use\n\nNever.\n'
        ),
        'references-sprawl': (
            '---\nname: sprawl\ndescription: Extract text and tables from PDF files.\n---\n\n'
            '# Sprawl\n\n## When to Use\n\nNever.\n'
        ),
        'platforms-gating': (
            '---\nname: gated\ndescription: Extract text and tables from PDF files.\n---\n\n'
            '# Gated\n\n## When to Use\n\nNever.\n\nRun scripts/run.sh.\n'
        ),
        'missing-section': (
            '---\nname: nosection\ndescription: Extract text and tables from PDF files.\n---\n\n'
            '# No Section\n\nJust prose with no When to Use heading.\n'
        ),
        'shell-utility-reference': (
            '---\nname: shellref\ndescription: Extract text and tables from PDF files.\n---\n\n'
            '# Shell Ref\n\n## When to Use\n\nNever.\n\nUse `grep` to find lines and `cat` to read them.\n'
        ),
        'forbidden-file': (
            '---\nname: forbidden\ndescription: Extract text and tables from PDF files.\n---\n\n'
            '# Forbidden\n\n## When to Use\n\nNever.\n'
        ),
        'dangling-reference': (
            '---\nname: dangling\ndescription: Extract text and tables from PDF files.\n---\n\n'
            '# Dangling\n\n## When to Use\n\nNever.\n\nSee references/missing.md for details.\n'
        ),
    }


# Files laid down next to the fixtures (only for the rules that read disk).
FIXTURE_FILES = {
    'forbidden-file': {'README.md': '# readme\n', 'CHANGELOG.md': '# changes\n'},
    'dangling-reference': {},
    'references-sprawl': {f'references/r{i:02d}.md': '# note\n' for i in range(61)},
    'platforms-gating': {'scripts/run.sh': '#!/bin/sh\nosascript -e "beep"\n'},
}


# ---------------------------------------------------------------- hermes side
HERMES_LINT_SNIPPET = r'''
import json, sys
from pathlib import Path
root, payload = Path(sys.argv[1]), json.loads(sys.argv[2])
sys.path.insert(0, str(root))
from tools.skill_linter import lint_content
out = {}
for name, case in payload.items():
    findings = lint_content(case['content'], skill_dir=Path(case['dir']) if case['dir'] else None)
    out[name] = sorted({f.rule for f in findings})
print(json.dumps(out))
'''

HERMES_MEMORY_SNIPPET = r'''
import json, sys
root = sys.argv[1]
sys.path.insert(0, root)
from tools.memory_tool_store import ENTRY_DELIMITER, MEMORY_BLOCK_HEADERS
print(json.dumps({'delimiter': ENTRY_DELIMITER, 'headers': MEMORY_BLOCK_HEADERS}))
'''


def run_python(python, code, args):
    proc = subprocess.run([python, '-c', code, *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else 'python exited non-zero')
    return json.loads(proc.stdout)


# ---------------------------------------------------------------- node side
NODE_LINT_SNIPPET = r'''
const linter = require(process.argv[1]);
const payload = JSON.parse(process.argv[2]);
const out = {};
for (const [name, c] of Object.entries(payload)) {
  const findings = linter.lintContent(c.content, c.dir ? { skillDir: c.dir } : {});
  out[name] = [...new Set(findings.map((f) => f.rule))].sort();
}
process.stdout.write(JSON.stringify(out));
'''

NODE_MEMORY_SNIPPET = r'''
const m = require(process.argv[1]);
process.stdout.write(JSON.stringify({ delimiter: m.ENTRY_DELIMITER, headers: m.HEADERS }));
'''


def run_node(code, args, cwd):
    proc = subprocess.run(['node', '-e', code, *args], capture_output=True, text=True, cwd=cwd)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else 'node exited non-zero')
    return json.loads(proc.stdout)


# ---------------------------------------------------------------- checks
def check_verbatim(hermes, python):
    """Re-extract from hermes into a temp dir and diff against the repo."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        env = dict(os.environ, HERMES_EVOLVE_OUT=str(tmp / 'prompts.json'),
                   HERMES_EVOLVE_OUT_JSON=str(tmp / 'schemas.json'),
                   HERMES_EVOLVE_OUT_JS=str(tmp / 'tool_schemas.js'))
        for script in ('extract_prompts.py', 'extract_schemas.py'):
            proc = subprocess.run([python, str(HERE / 'scripts' / script), str(hermes)],
                                  capture_output=True, text=True, env=env)
            if proc.returncode != 0:
                return {'status': 'fail', 'detail': f'{script}: {proc.stderr.strip().splitlines()[-1]}'}
        fresh_prompts = json.loads((tmp / 'prompts.json').read_text(encoding='utf-8'))
        fresh_schemas = json.loads((tmp / 'schemas.json').read_text(encoding='utf-8'))
        fresh_js = (tmp / 'tool_schemas.js').read_text(encoding='utf-8')
    shipped_prompts = json.loads((SRC / 'prompts.hermes.json').read_text(encoding='utf-8'))
    shipped_schemas = json.loads((SRC / 'schemas.hermes.json').read_text(encoding='utf-8'))
    shipped_js = (SRC / 'tool_schemas.js').read_text(encoding='utf-8')
    diffs = []
    for text in sorted(set(fresh_prompts['texts']) | set(shipped_prompts['texts'])):
        a, b = shipped_prompts['texts'].get(text, ''), fresh_prompts['texts'].get(text, '')
        if a != b:
            diffs.append(f'prompt {text}: shipped {len(a)} chars, hermes {len(b)} chars')
    for schema in range(max(len(fresh_schemas), len(shipped_schemas))):
        a = shipped_schemas[schema] if schema < len(shipped_schemas) else None
        b = fresh_schemas[schema] if schema < len(fresh_schemas) else None
        if a != b:
            diffs.append(f'schema #{schema}: {json.dumps(a)[:60]}… != {json.dumps(b)[:60]}…')
    if fresh_js != shipped_js:
        diffs.append('tool_schemas.js differs from a fresh extraction')
    status = 'pass' if not diffs else 'fail'
    return {'status': status, 'detail': diffs or [
        f"{len(fresh_prompts['texts'])} prompt texts, {len(fresh_schemas)} schemas, tool_schemas.js — byte-identical",
        f"hermes source tag: {fresh_prompts.get('source', '?')}",
    ]}


def check_linter(hermes, python):
    with tempfile.TemporaryDirectory() as tmp:
        payload = {}
        for name, content in linter_fixtures().items():
            skill_dir = Path(tmp) / name
            skill_dir.mkdir()
            (skill_dir / 'SKILL.md').write_text(content, encoding='utf-8')
            for fname, body in FIXTURE_FILES.get(name, {}).items():
                target = skill_dir / fname
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(body, encoding='utf-8')
            payload[name] = {'content': content, 'dir': str(skill_dir) if name in FIXTURE_FILES else None}
        hermes_out = run_python(python, HERMES_LINT_SNIPPET, [str(hermes), json.dumps(payload)])
        node_out = run_node(NODE_LINT_SNIPPET, [str(SRC / 'skill_linter.js'), json.dumps(payload)], HERE)
    diffs = []
    for name in sorted(payload):
        a, b = set(hermes_out.get(name, [])), set(node_out.get(name, []))
        if a != b:
            diffs.append(f'{name}: hermes-only={sorted(a - b)} port-only={sorted(b - a)}')
    status = 'pass' if not diffs else 'fail'
    covering = sorted({r for rules in hermes_out.values() for r in rules})
    return {'status': status, 'detail': diffs or [
        f'{len(payload)} fixtures, {len(covering)} hermes rules exercised: {", ".join(covering)}',
    ]}


def check_memory_format(hermes, python):
    h = run_python(python, HERMES_MEMORY_SNIPPET, [str(hermes)])
    n = run_node(NODE_MEMORY_SNIPPET, [str(SRC / 'memory.js')], HERE)
    diffs = []
    if h['delimiter'] != n['delimiter']:
        diffs.append(f'delimiter: hermes {h["delimiter"]!r} != port {n["delimiter"]!r}')
    if h['headers'] != n['headers']:
        diffs.append(f'headers: hermes {h["headers"]} != port {n["headers"]}')
    return {'status': 'fail' if diffs else 'pass', 'detail': diffs or [
        f'delimiter {n["delimiter"]!r}, headers {sorted(n["headers"])}',
    ]}


CHECKS = {
    'verbatim': check_verbatim,
    'linter': check_linter,
    'memory-format': check_memory_format,
}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--hermes', default=os.environ.get('HERMES_SRC', '../hermes-agent'),
                        help='path to a hermes-agent checkout (default: $HERMES_SRC or ../hermes-agent)')
    parser.add_argument('--python', default=sys.executable,
                        help='interpreter that can import hermes tools.* (needs ruamel.yaml, pyyaml)')
    parser.add_argument('--only', action='append', choices=sorted(CHECKS), help='run a single check (repeatable)')
    args = parser.parse_args()

    hermes = Path(args.hermes).resolve()
    names = args.only or list(CHECKS)
    print(f'hermes: {hermes}')
    print(f'python: {args.python}')
    print(f'node:   {subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()}')
    print()

    if not (hermes / 'agent' / 'background_review.py').is_file():
        print(f'SKIP  not a hermes checkout: {hermes}')
        return 2

    probe = subprocess.run(
        [args.python, '-c',
         'import sys; sys.path.insert(0, sys.argv[1]); '
         'import tools.skill_linter, tools.memory_tool_store',
         str(hermes)],
        capture_output=True, text=True)
    importable = probe.returncode == 0
    if not importable:
        hint = probe.stderr.strip().splitlines()[-1] if probe.stderr.strip() else 'import failed'
        print(f'SKIP  hermes modules not importable with {args.python}: {hint}')
        print('      (needs python >= 3.11 with ruamel.yaml and pyyaml; '
              'pass --python /path/to/venv/bin/python)')
        print()

    failed = skipped = 0
    for name in names:
        if name in ('linter', 'memory-format') and not importable:
            skipped += 1
            print(f'SKIP  {name}: hermes modules not importable (see above)')
            continue
        try:
            result = CHECKS[name](hermes, args.python)
        except RuntimeError as exc:
            failed += 1
            print(f'FAIL  {name}: {exc}')
            continue
        except subprocess.CalledProcessError as exc:  # pragma: no cover - defensive
            failed += 1
            print(f'FAIL  {name}: {exc}')
            continue
        verdict ={'pass': 'PASS', 'fail': 'FAIL'}[result['status']]
        print(f'{verdict}  {name}')
        for line in result['detail']:
            print(f'      {line}')
        if result['status'] == 'fail':
            failed += 1

    print()
    print(f'{len(names) - failed - skipped} passed, {failed} failed, {skipped} skipped')
    if failed:
        return 1
    return 2 if skipped else 0


if __name__ == '__main__':
    sys.exit(main())