"""Build local lightweight artwork and original gentle feedback sounds; no external audio samples."""
from pathlib import Path
from PIL import Image
import math, wave, struct
root = Path(__file__).resolve().parents[1]
a = root / 'assets'
image = Image.open(a / 'capybara-original.png').convert('RGB')
image.resize((1152,768), Image.Resampling.LANCZOS).save(a / 'capybara.jpg',quality=88,optimize=True)
# The 512px PWA icon is also the master for the smaller installed icons.
with Image.open(a / 'app-icon-512.png') as icon:
    for size, name in ((180, 'app-icon.png'), (192, 'app-icon-192.png')):
        icon.resize((size, size), Image.Resampling.LANCZOS).save(a / name, optimize=True)
rate=22050
for name, notes in {
 'complete': [(523.25,0.0,.34),(783.99,.14,.42)],
 'points': [(659.25,0.0,.36),(880.0,.14,.37),(1046.5,.28,.40)],
 'redeem': [(523.25,0.0,.42),(659.25,.13,.43),(783.99,.26,.44),(1046.5,.39,.48)]
}.items():
    duration=max(start+length for _,start,length in notes)+.1
    samples=[]
    for i in range(int(rate*duration)):
        t=i/rate
        v=0.0
        for freq,start,length in notes:
            u=t-start
            if 0 <= u <= length:
                attack=min(1.,u/.012)
                release=min(1.,(length-u)/.055)
                env=attack*release*math.exp(-7*u/length)
                v+=.17*env*(math.sin(2*math.pi*freq*u)+.18*math.sin(2*math.pi*freq*2.76*u))
        samples.append(struct.pack('<h',int(max(-.75,min(.75,v))*32767)))
    with wave.open(str(a/(name+'.wav')),'wb') as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(rate);w.writeframes(b''.join(samples))
print('Artwork optimized; app icon and three original WAV chimes generated.')
