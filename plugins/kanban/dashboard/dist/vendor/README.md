# Vendored third-party code

## pixi.min.mjs — PixiJS 8.19.0

WebGL renderer for the agency floor scene. Vendored rather than fetched from a
CDN because the dashboard is a local service: it must render with the network
down, and a factory view that silently degrades to nothing when a CDN is
unreachable is worse than no view.

Source: `pixi.js@8.19.0`, file `dist/pixi.min.mjs`, unmodified.
Licence: MIT, see `pixi-LICENSE.txt`.

Loaded with a dynamic `import()` from `../index.js` so the rest of the board
still renders if the scene layer fails to start.
