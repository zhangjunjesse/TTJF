"""Compose unedited v0.8 phone captures of parent setup and verification."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
folder = root / 'artifacts'
canvas = Image.new('RGB', (1250, 904), '#f7f8f4')
draw = ImageDraw.Draw(canvas)
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 23)
for x, name, label in (
    (20, 'v8-preview-setup.png', '首次设置'),
    (430, 'v8-preview-change.png', '修改密码'),
    (840, 'v8-preview-verify.png', '当前密码核验'),
):
    image = Image.open(folder / name).convert('RGB')
    if image.size != (390, 844):
        raise ValueError('Unexpected screenshot dimensions: ' + name)
    draw.text((x, 10), label, font=font, fill='#2c493c')
    canvas.paste(image, (x, 50))
canvas.save(folder / 'v8-preview.png', optimize=True)
print(str(folder / 'v8-preview.png'))
