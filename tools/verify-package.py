"""Audit the delivered ZIP against the workspace without reading private data."""
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit
import argparse
import hashlib
import json
import posixpath
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / 'export/little-steps-source.zip'
HTML = ROOT / 'export/little-steps-demo.html'
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
RELEASE = 'v' + VERSION.split('.')[1] + ('.' + VERSION.split('.')[2] if VERSION.split('.')[2] != '0' else '')
REPORT = ROOT / ('export/' + RELEASE + '-package-verification.json')
PREFIX = 'little-steps/'
PRESERVED = {
    'export/little-steps-v4.zip': '8f9e7416044f6e96ee561c11bc359a28b09acf1844cdb70f185c00a92105d8d6',
    'export/little-steps-v5.zip': '53c618b7480ca6c3be8a65c51380cd624f78b99bb825019b348dd497b7ccf565',
    'artifacts/v6-baseline-v5.html': '1b2cb837cc199407b0416bdf1451003f551bc455dde6eba91ab3b8812ba97fbc',
    'export/little-steps-v6.zip': '20a419325fb7dd387ef6d5b8ae980da99a528f83f4a065b03d4584b774e60701',
    'export/little-steps-v6.html': 'b74bb52515de864b67af298ef982dadc5cc21aca81d5863e36501bd109d09c32',
    'export/little-steps-v7.zip': 'af9f245f29362bd6a3fdc4c238949845dec480c5b8c6572c873022bb0689fdc8',
    'export/little-steps-v7.html': '8d5eb485ba7521b2e72cfba67f0999f9204832390a7c74696c7c33c4345a320d',
    'export/little-steps-v8.zip': '28956de5b977e372889a1c9d0751109d5929cca860c1ad682cbd31a28198f370',
    'export/little-steps-v8.html': '4053fbb2d189a973876edaf3dc68a509d177c316b4eb66e007e2ef9b2056b137',
    'export/little-steps-v8.1.zip': 'f424b119e42bef5d954e516a3eb0f2536c4dcb68f8215c99aaa94085ef15afca',
    'export/little-steps-v8.1.html': '903566acff6da0051f74bd80935125048ba8d4277e8b0bfe6c04efa274c91d06',
    'export/little-steps-v9.html': '73fbbfdcb1770209f57644d2754a8f26404842a730750f3d11463aa957ab26e5',
    'export/little-steps-v9.zip': '3f25ec30c03af2f7629a62c7050aebe450d00f74460675887d90ea371a253e73'
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def audit(require_history=False):
    result = {'version': VERSION, 'archive': str(ARCHIVE.relative_to(ROOT)),
              'archiveSha256': digest(ARCHIVE.read_bytes()),
              'htmlSha256': digest(HTML.read_bytes()),
              'entries': 0, 'sourceMirrors': 0, 'htmlCopies': 0,
              'relativeMarkdownLinks': 0, 'selfArchiveLinks': [], 'omittedPrivateLinks': [],
              'preserved': {}, 'errors': []}
    errors = result['errors']
    for name, expected in PRESERVED.items():
        file = ROOT / name
        actual = digest(file.read_bytes()) if file.is_file() else None
        result['preserved'][name] = {'expected': expected, 'actual': actual, 'status': 'not-present' if actual is None else 'matched' if actual == expected else 'changed'}
        if actual is None and require_history:
            errors.append('Required historical evidence missing: ' + name)
        elif actual is not None and actual != expected:
            errors.append('Historical evidence changed: ' + name)
    result['historyComplete'] = all(row['actual'] == row['expected'] for row in result['preserved'].values())
    with zipfile.ZipFile(ARCHIVE) as archive:
        entries = archive.namelist()
        names = set(entries)
        result['entries'] = len(entries)
        result['crcValid'] = archive.testzip() is None
        if not result['crcValid']:
            errors.append('ZIP CRC failed')
        if len(names) != len(entries):
            errors.append('ZIP contains duplicate paths')
        for name in entries:
            parts = PurePosixPath(name).parts
            if not name.startswith(PREFIX) or '..' in parts or any(
                part.startswith('.') or part in {'data', 'node_modules', 'runtime', '__pycache__'}
                for part in parts
            ) or PurePosixPath(name).suffix.lower() in {'.key', '.pem', '.pfx', '.p12', '.pyc'} or (name.startswith(PREFIX + 'artifacts/') and any(private in PurePosixPath(name).name for private in ('live', 'migration'))):
                errors.append('Unexpected or private archive path: ' + name)
                continue
            rel = name[len(PREFIX):]
            content = archive.read(name)
            if rel in {'offline-demo.html', 'export/little-steps-demo.html'}:
                result['htmlCopies'] += 1
                if content != HTML.read_bytes():
                    errors.append('Standalone HTML differs: ' + rel)
            else:
                file = ROOT / rel
                if not file.is_file() or content != file.read_bytes():
                    errors.append('Workspace mirror differs: ' + rel)
                else:
                    result['sourceMirrors'] += 1
            if name.endswith('.md'):
                markdown = re.sub(r'```.*?```', '', content.decode('utf-8'), flags=re.S)
                for match in re.finditer(r'\[[^\]]*\]\((?:<([^>]+)>|([^\)]+))\)', markdown):
                    link = match.group(1) or match.group(2)
                    link = re.sub(r'\s+[\"\'].*$', '', link).strip()
                    parsed = urlsplit(link)
                    if parsed.scheme or parsed.netloc or not parsed.path:
                        continue
                    result['relativeMarkdownLinks'] += 1
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(name), unquote(parsed.path)))
                    if target == PREFIX + 'export/little-steps-source.zip':
                        result['selfArchiveLinks'].append({'from': name, 'target': link})
                    elif target.startswith(PREFIX + 'artifacts/') and any(private in PurePosixPath(target).name for private in ('live', 'migration')):
                        result['omittedPrivateLinks'].append({'from': name, 'target': link})
                    elif target not in names:
                        errors.append('Broken packaged Markdown link: ' + name + ' -> ' + link)
    if result['htmlCopies'] != 2:
        errors.append('Expected exactly two identical standalone HTML copies')
    html = HTML.read_text(encoding='utf-8')
    if 'window.__FAMILY_OFFLINE__ = true;' not in html:
        errors.append('Offline mode flag is missing')
    if '<script src=' in html or '<link rel="stylesheet"' in html:
        errors.append('Standalone HTML still loads external code')
    for name in ('model.js', 'assistant.js', 'pet.js', 'app.js'):
        source = (ROOT / name).read_text(encoding='utf-8').replace('</script', '<\\/script')
        if ('<script>' + source + '</script>') not in html:
            errors.append('Inline JavaScript differs: ' + name)
    for name in ('styles.css', 'pet.css'):
        if ('<style>' + (ROOT / name).read_text(encoding='utf-8') + '</style>') not in html:
            errors.append('Inline stylesheet differs: ' + name)
    result['passed'] = not errors
    REPORT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: result[key] for key in ('passed', 'entries', 'sourceMirrors', 'htmlCopies', 'relativeMarkdownLinks', 'errors')}, ensure_ascii=False, indent=2))
    print(str(REPORT))
    return not errors


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-history', action='store_true', help='Also require all preserved v4/v5/v6/v7/v8 baselines in this workspace')
    raise SystemExit(0 if audit(parser.parse_args().require_history) else 1)
