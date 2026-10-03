# ST-MQ branding assets

[smart-timing.svg](smart-timing.svg) is the editable source for the Home Energy
clock-and-lightning artwork. It contains vector shapes with no fonts, embedded
bitmaps or external assets, and follows the project MIT license.

Home Assistant uses the exported [icon.png](../../icon.png) (128 px) and
[logo.png](../../logo.png) (512 px) beside `config.json`. The dashboard uses the
same root icon as its browser tab icon. Keep these required filenames; the
sidebar icon is configured separately through `panel_icon`.

Export the root PNGs from this directory with CairoSVG (an artwork tool, not
an application dependency):

```sh
cairosvg smart-timing.svg -o ../../icon.png --output-width 128 --output-height 128
cairosvg smart-timing.svg -o ../../logo.png --output-width 512 --output-height 512
```

See the [Home Assistant presentation guide](https://developers.home-assistant.io/docs/apps/presentation/#app-icon--logo)
for store artwork requirements.

## Installed Android app icons

The dashboard links [app.webmanifest](../../chart/public/app.webmanifest), using
the name **Home Energy** and the forest green launch background. Its dedicated
192 px and 512 px PNGs are exported from the Smart timing vector. The 512 px
maskable variant has an opaque forest green background; the clock and bolt fit
inside Android's central circular safe area (radius 40% of the image width).
The browser tab and Home Assistant add-on keep their existing icons.

Vite serves `chart/public/` during development and copies it into `dist/` during
the production/container build. Manifest URLs are relative to preserve a hosting
prefix. The application serves the manifest as `application/manifest+json` with
revalidation. The manifest link includes credentials for cookie-authenticated
hosting. Actual installation still depends on the browser and hosting context.

To regenerate the installed-app PNGs, run from the repository root with CairoSVG
installed (an artwork tool only, not an application dependency):

```sh
python3 - <<'PY'
from pathlib import Path
import cairosvg

source = Path('assets/branding/smart-timing.svg').read_bytes()
output = Path('chart/public/icons')
output.mkdir(parents=True, exist_ok=True)
for size in (192, 512):
    cairosvg.svg2png(bytestring=source, output_width=size, output_height=size,
                    write_to=str(output / f'home-energy-{size}.png'))
cairosvg.svg2png(bytestring=source, output_width=512, output_height=512,
                background_color='#101e19',
                write_to=str(output / 'home-energy-maskable-512.png'))
PY
```

After deploying the new build, remove the old installed app/shortcut and install
it again from Chrome to test the new launch artwork. Verify the launch on an
Android device; desktop manifest checks cannot confirm Android's animation.
