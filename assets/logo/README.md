# Agentus brand assets

Everything in this directory is **generated**. The one hand-provided file is the master PNG;
the rest is produced from it by [`scripts/build-brand-assets.py`](../../scripts/build-brand-assets.py).

```
assets/logo/source/agentus-logo-source.png   the master (1817², kept verbatim)
      ↓  classify the two inks → denoise → potrace → rasterise at every size
agentus-icon.svg        the mark on a square canvas — favicon/PWA/app icon geometry
agentus-mark.svg        the mark hugging its own box (1484×880) — the UI header/login
agentus-wordmark.svg    the "Agentus" wordmark alone
agentus-logo.svg        the lockup: mark over wordmark, as in the master
agentus-icon-*.svg      light-ink variants for dark surfaces
agentus-icon-*.png      transparent raster exports (1024…16) + lockup + maskable
packages/web/public/icons/         what the browser and the PWA actually load
android/app/src/main/res/mipmap-*  launcher icons (adaptive + legacy + round)
android/app/src/main/res/drawable/ic_notify.xml  monochrome notification glyph
```

## The palette

| | hex | where |
|---|---|---|
| ink | `#424D54` | the mark, the wordmark |
| accent | `#76BBDF` | the three nodes |
| canvas | `#FEFDF9` | the brand field (maskable/legacy iOS icons) |
| ink, dark surfaces | `#DCE3E8` | header/login on the dark theme |
| accent, dark surfaces | `#8CCBF0` | ditto |

Measured off the master rather than guessed: a median filter over the source's core pixels
gives `#424D54` / `#76BBDF`, the canvas is `#FEFDF9`. The app's own UI accent (amber
`#ffb454`) is a separate, user-configurable choice — the brand accent is not applied to the
cockpit chrome.

## Rebuilding

```bash
python3 -m venv .venv && .venv/bin/pip install pillow numpy
brew install potrace librsvg
python3 scripts/build-brand-assets.py          # writes every asset above
python3 scripts/build-brand-assets.py --check  # verify the committed ones
```

Then rebuild what consumes them: `npm run build -w @agentus/web` and
`bash scripts/build-apk.sh`.

## Two things worth knowing

**Why trace instead of shipping the PNG.** The master is a 1817² raster with a textured field;
as an app icon it would be soft at 512 and unusable as a favicon. Tracing each ink as its own
flat layer gives true vector art that stays crisp at every size, and the artefact is small
(the mark is ~21 KB of paths, ~7 KB gzipped).

**Fidelity.** The traced mark was verified against the master numerically: the three node
circles come out at centres (178.3, 737.8) / (759.0, 737.9) / (1339.0, 737.9) with radii
88.6 / 88.4 / 88.4 — identical to the source within a tenth of a pixel — and per-ink IoU
against the source mask is 0.996. The pre-blur that makes this cheap does not move any edge
visibly at any size the assets are used at.

**Provenance.** The master is AI-generated (Doubao) by the project operator. It is a
placeholder-grade mark: fine for shipping the cockpit's icons today, but a logo used as a
trademark should be either drawn by hand or traced and then refined, and the name should be
cleared before it matters commercially.
