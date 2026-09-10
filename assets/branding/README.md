# ST-MQ branding assets

**Smart timing** (the clock/crosshair ring with an amber lightning bolt) is the
selected default ST-MQ icon. All three designs remain available for reuse, using
the dashboard's forest, sage, mint and amber palette. **Warm home** communicates
home heating; **Thermal loop** is the abstract alternative.

![Three ST-MQ icon concepts, including small previews on light and dark backgrounds](preview.png)

| Design | Editable vector | Add-on PNG | Larger PNG |
| --- | --- | --- | --- |
| 01 · Warm home | [SVG](warm-home.svg) | [128 × 128](warm-home-128.png) | [512 × 512](warm-home-512.png) |
| 02 · Thermal loop | [SVG](thermal-loop.svg) | [128 × 128](thermal-loop-128.png) | [512 × 512](thermal-loop-512.png) |
| **03 · Smart timing · default** | [SVG](smart-timing.svg) | [128 × 128](smart-timing-128.png) | [512 × 512](smart-timing-512.png) |

The SVGs scale to any resolution and contain only vector shapes, with no fonts,
embedded bitmaps or external assets. Each includes a forest green rounded badge
with transparent outer corners. For a symbol without the badge, remove the first
`rect` element. The artwork follows the project's MIT license.

The add-on images are real PNG files in the repository root, beside `config.json`:

- [`icon.png`](../../icon.png): the selected 128 × 128 export for the add-on icon.
- [`logo.png`](../../logo.png): the selected 512 × 512 export for the add-on logo.

Home Assistant discovers these filenames for the add-on store and detail pages;
they do not need entries in `config.json` or copies inside the container. The
sidebar uses the separate `panel_icon` setting. Home Assistant recommends a
128 × 128 icon and permits a different logo size/aspect ratio; see the
[official presentation guide](https://developers.home-assistant.io/docs/apps/presentation/#app-icon--logo).
An existing Home Assistant installation must receive this repository revision
and refresh its add-on repository metadata before it can show the new images.

To revise a design, edit its SVG in a vector editor and export at 128 px and
512 px. The supplied exports were rendered with CairoSVG 2.8.2, for example:

```sh
cairosvg smart-timing.svg -o smart-timing-128.png --output-width 128 --output-height 128
cairosvg smart-timing.svg -o smart-timing-512.png --output-width 512 --output-height 512
cp smart-timing-128.png ../../icon.png
cp smart-timing-512.png ../../logo.png
```

Run those commands from this directory with CairoSVG installed. It is only an
artwork export tool, not an application dependency. Keep the root copies in sync
when changing the selected icon. Update the comparison image after changing the
artwork; its small samples show 32 px and 64 px rendering on light and dark
backgrounds.
