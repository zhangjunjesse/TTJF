"""Package the current sources; never include runtime data or AI credentials."""
from pathlib import Path
import base64
import mimetypes
import zipfile

root = Path(__file__).resolve().parents[1]
out = root / 'export'
out.mkdir(exist_ok=True)
html = (root / 'index.html').read_text(encoding='utf-8')
html = html.replace('<link rel="manifest" href="manifest.webmanifest">', '')
for name in ('styles.css', 'pet.css'):
    css = (root / name).read_text(encoding='utf-8')
    marker = '<link rel="stylesheet" href="' + name + '">'
    if marker not in html:
        raise ValueError('Missing required stylesheet marker: ' + name)
    html = html.replace(marker, '<style>' + css + '</style>')
# An explicit flag also forces local mode when a file previewer serves this HTML over HTTP.
html = html.replace('<script src="model.js"></script>', '<script>window.__FAMILY_OFFLINE__ = true;</script>\n<script src="model.js"></script>')
for name in ('model.js', 'assistant.js', 'pet.js', 'app.js'):
    source = (root / name).read_text(encoding='utf-8').replace('</script', '<\\/script')
    marker = '<script src="' + name + '"></script>'
    if marker not in html:
        raise ValueError('Missing required script marker: ' + name)
    html = html.replace(marker, '<script>' + source + '</script>')
for name in ('favicon.svg', 'app-icon.png', 'complete.wav', 'points.wav', 'redeem.wav'):
    file = root / 'assets' / name
    mime = mimetypes.guess_type(name)[0] or 'application/octet-stream'
    uri = 'data:' + mime + ';base64,' + base64.b64encode(file.read_bytes()).decode('ascii')
    html = html.replace('assets/' + name, uri)
if '<script src=' in html or '<link rel="stylesheet"' in html:
    raise ValueError('The standalone export still has external code dependencies')
standalone = out / 'little-steps-demo.html'
standalone.write_text(html, encoding='utf-8')
archive = out / 'little-steps-source.zip'
allowed_top = {'index.html', 'styles.css', 'pet.css', 'pet.js', 'app.js', 'model.js', 'assistant.js', 'assistant-service.cjs', 'server.cjs', 'manifest.webmanifest', 'package.json', 'README.md'}
allowed_tools = {'package-demo.py', 'verify-package.py', 'make-preview.py', 'make-assets.py'}
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
    for file in sorted(root.rglob('*')):
        if not file.is_file():
            continue
        rel = file.relative_to(root)
        if any(part.startswith('.') for part in rel.parts) or file.suffix.lower() in {'.key', '.pem'}:
            continue
        include = len(rel.parts) == 1 and rel.name in allowed_top
        if rel.parts[0] in {'assets', 'docs', 'test'}:
            include = True
        elif rel.parts[0] == 'tools':
            include = file.name in allowed_tools or (len(rel.parts) == 3 and rel.parts[1] == 'pet-v6' and file.suffix in {'.html', '.js', '.css'})
        elif rel.parts[0] == 'artifacts':
            include = (rel.parts[1].startswith(('v4-', 'v5-', 'v6-', 'v7-', 'v8-', 'v9-', 'v10-')) or (file.name.startswith('v3-') and 'failure' not in file.name)) and not any(private in file.name for private in ('live', 'migration'))
        if include:
            z.write(file, 'little-steps/' + rel.as_posix())
    z.write(standalone, 'little-steps/offline-demo.html')
    z.write(standalone, 'little-steps/export/little-steps-demo.html')
    baseline = root / 'export/little-steps-v8.html'
    if baseline.is_file():
        z.write(baseline, 'little-steps/export/little-steps-v8.html')
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    assert not any('/data/' in name or '/node_modules/' in name or '/.env' in name for name in z.namelist())
print(str(standalone) + ' (' + str(standalone.stat().st_size) + ' bytes)')
print(str(archive) + ' (' + str(archive.stat().st_size) + ' bytes; CRC verified; no runtime data)')
