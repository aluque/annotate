# Annotate – CLAUDE.md

## What this app is

A browser-based image annotation tool. Users open an image, place geometric annotations (points, lines, rectangles) on it, assign tags to them, and export the result as JSON. No server, no build step, no dependencies.

## File structure

```
index.html   – DOM layout (toolbar, sidebar, canvas area, status bar)
app.js       – All application logic (~1820 lines, single file)
style.css    – Styling; dark theme by default, light theme via body.light
launch.sh    – macOS helper that opens the app in a browser (tries Safari → Chrome → Chromium → Firefox)
scripts/     – Standalone Python CLI tools (extract.py, measure.py); superseded in-browser by the Tools menu
```

## Tech stack

Vanilla HTML5/CSS3/JS. No frameworks, no bundler, no package manager. The canvas API does all drawing.

## Architecture

Single-page app, entirely client-side. State lives in module-level variables in `app.js`. Changes call `redraw()` (canvas) and/or `refreshList()` (DOM sidebar). There is no reactivity layer.

### Layout

```
Toolbar (50px)       – tools, prefix input, file controls, theme toggle, Tools menu
├── Sidebar (230px)  – annotation list, tags panel, 4× zoom viewer
└── Canvas area      – zoomable/pannable image with overlay canvas
Status bar (22px)    – current tool, keyboard shortcuts, context hint
Coords HUD           – fixed bottom-right (position:fixed, above status bar); shows x/y + zoom %
```

### State (app.js top)

| Variable | Purpose |
|---|---|
| `annotations` | Array of `{id, type, name, coords, tags}` |
| `tags` | Array of `{id, name, color}` |
| `selectedId` | UUID of primary selected annotation, or null |
| `selectedIds` | Set of UUIDs for multi-select |
| `expandedAnnotationId` | Annotation whose inline tag editor is open |
| `activeTags` | Set of tag IDs pre-selected for the next annotation |
| `hiddenTagIds` | Set of tag IDs whose annotations are hidden from canvas and dimmed in sidebar |
| `mode` | `'select' \| 'point' \| 'line' \| 'rect'` |
| `scale` | canvas px / image px (zoom level) |
| `counters` | `{point, line, rect}` — incremented for auto-naming |
| `undoStack` | Array of `{annotations, tags, counters}` snapshots (max 50) |
| `redoStack` | Array of snapshots pushed by `undo()`; cleared on `pushUndo()` |
| `colorPickerPopover` | Reference to the currently open color-picker DOM node, or null |
| `dragTarget` | Annotation being dragged, or null |
| `dragPart` | `'whole' \| 'p1' \| 'p2'` — which part of the annotation is being dragged |
| `dragStart` | `{canvasX, canvasY}` at mousedown |
| `dragOrigCoords` | Deep-copy of `dragTarget.coords` at drag start |
| `dragMoved` | Whether the drag has moved past the 2px threshold (used to gate `pushUndo()`) |

### Coordinate system

All annotations are stored in **image coordinates** (original pixel space). `c2i()` converts canvas→image, `i2c()` converts image→canvas. The `scale` variable is the only transform (no pan offset stored — panning uses `scrollLeft/scrollTop` on the canvas-area div).

### Colors

```js
C_NORMAL   = '#94a3b8'  // slate – default annotation (no tag)
C_PREVIEW  = '#68d391'  // green – in-progress drawing
```

There is no fixed `C_SELECTED`. The selected color is computed dynamically by `annotationColor()`:

```js
function annotationColor(ann) {
  let base = C_NORMAL;
  if (ann.tags?.length > 0) base = tags.find(t => t.id === ann.tags[0])?.color ?? C_NORMAL;
  const isSelected = ann.id === selectedId || selectedIds.has(ann.id);
  return isSelected ? mixWithWhite(base, 0.55) : base;
}
```

`mixWithWhite(hex, t)` blends a hex color 55% toward `#ffffff`, producing a lighter pastel of the same hue. Selected annotations also draw with thicker strokes (3 px vs 2 px) and larger dots.

### Tag colors

```js
const TAG_COLORS = [
  '#f87171', '#60a5fa', '#4ade80', '#facc15',
  '#fb923c', '#34d399', '#a78bfa', '#f472b6',
];
```

Ordered so the first two defaults (red, blue) are maximally distinct — important for two-series plots.

### Hit testing

- `HIT_RADIUS = 8` canvas px
- Hidden annotations (via `hiddenTagIds`) are skipped in all hit tests
- Annotations are tested in reverse order (top-most drawn = first hit)
- `hitTest(cx, cy)` — returns the hit annotation or null; used for hover
- `hitTestWithPart(cx, cy)` — returns `{ann, part}` or null; used for drag/select:
  - Points: distance ≤ HIT_RADIUS → `part: 'whole'`
  - Lines: endpoint distance ≤ HIT_RADIUS → `part: 'p1'` or `'p2'`; perp-distance ≤ HIT_RADIUS → `part: 'whole'`
  - Rects: corner distance ≤ HIT_RADIUS → `part: 'p1'` or `'p2'` (resize); edge proximity ≤ HIT_RADIUS → `part: 'whole'` (move)

## Annotation types and coord format

| Type | `coords` |
|---|---|
| `point` | `[x, y]` |
| `line` | `[[x1,y1], [x2,y2]]` |
| `rect` | `[[x1,y1], [x2,y2]]` (top-left, bottom-right) |

## Export/import JSON format

```json
{
  "metadata": { "image": "photo.jpg", "exported": "<ISO timestamp>" },
  "tags": [{ "name": "important", "color": "#f87171" }],
  "annotations": [
    { "type": "point", "name": "Point001", "coords": [150.5, 200.3], "tags": ["important"] },
    { "type": "line",  "name": "Line001",  "coords": [[50,50],[200,150]], "tags": [] },
    { "type": "rect",  "name": "Rect001",  "coords": [[10,20],[300,400]], "tags": ["important"] }
  ]
}
```

Tags are serialized by name (not by ID) in the export.

## Key behaviors

- **Panning**: right-click drag or Space+drag (cursor shows grab/grabbing feedback)
- **Zoom**: mouse wheel (proportional accumulation via RAF; lateral-axis events ignored for Magic Mouse compatibility)
- **Zoom keyboard shortcuts**: `+` / `=` zoom in, `-` zoom out — both zoom around the viewport center
- **Fit to view**: `F` key — resets scale and scroll to fit the image in the viewport
- **Shift held during line/rect drawing**: constrains to horizontal or vertical
- **Auto-naming**: `<prefix><counter padded to 3 digits>`. Prefix defaults per type (`Point`, `Line`, `Rectangle`) but the toolbar input overrides all three.
- **Tag selection for new annotations**: click tag in sidebar to toggle; Shift+click for range; Cmd/Ctrl+click for single toggle
- **Drag-and-drop**: canvas-area accepts both image files and JSON files
- **Drag-to-move**: in select mode, drag a selected annotation to move it; for lines, dragging an endpoint (p1/p2) moves only that endpoint; for rects, dragging a corner (p1/p2) resizes it; `pushUndo()` fires on first pixel moved (2px threshold)
- **Multi-select**: Shift+click on canvas toggles annotations in/out of `selectedIds`; Del/Backspace deletes all selected in one undo entry
- **Hide by tag**: eye icon in the tag sidebar row; hidden tag's annotations disappear from canvas and are dimmed in the sidebar list
- **Keyboard shortcuts**: S / P / L / R (tools), Del/Backspace (delete selected), Esc (cancel in-progress), F (fit), M (toggle labels), Tab / Shift+Tab (cycle annotations), Cmd/Ctrl+Z (undo), Cmd+Y or Cmd+Shift+Z (redo), +/- (zoom)

## Undo / Redo

`pushUndo()` records a deep-copy snapshot of `{annotations, tags, counters}` before every mutating operation, and **clears `redoStack`**.

`undo()` pushes a snapshot onto `redoStack`, pops from `undoStack`, restores state, then calls `refreshTagsList()`, `refreshList()`, `redraw()`. Stack limit: 50 entries.

`redo()` manually pushes to `undoStack` (without calling `pushUndo()`, which would wipe `redoStack`), pops from `redoStack`, and restores state.

Operations that call `pushUndo()`: `addAnnotation`, `deleteAnnotation`, `clearAnnotations` (after confirm), `deleteTag`, annotation name change, annotation tag toggle, tag creation, JSON import, tag color change, drag-move (on first pixel threshold crossed), batch delete.

## Drawing functions

```js
drawAnnotation(ctx, ann, color, showLabel, selected=false, labelSize=11.5)
paintLabel(ctx, text, x, y, color, fontSize=11.5)
```

`labelSize` / `fontSize` default to `11.5` px for on-canvas display. `downloadAnnotatedImage()` passes a scaled value (`Math.max(16, Math.round(imgW/80))`) so labels are legible at full image resolution.

## Wheel zoom implementation

```js
let wheelAccum = 0, wheelPivotX = 0, wheelPivotY = 0, wheelRafId = null;

mainCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (!sourceImage) return;
  // Ignore lateral-dominant events (Magic Mouse two-finger swipe)
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  // Normalize deltaMode (LINE/PAGE → approximate pixels)
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16;
  if (e.deltaMode === 2) dy *= 400;
  wheelAccum += dy;
  wheelPivotX = e.clientX; wheelPivotY = e.clientY;
  if (!wheelRafId) wheelRafId = requestAnimationFrame(() => {
    zoomBy(Math.pow(0.9995, wheelAccum), wheelPivotX, wheelPivotY);
    wheelAccum = 0; wheelRafId = null;
  });
}, { passive: false });
```

`zoomBy(factor, pivotClientX, pivotClientY)` clamps scale to `[minScale, 4]`, resizes canvas, and adjusts `scrollLeft/scrollTop` to keep the pivot point stationary.

## Tag sidebar features

- **Tag count badge**: `refreshTagsList()` precomputes a `countMap` and renders a `.tag-count` badge if count > 0
- **Eye toggle (hide by tag)**: `.tag-eye-btn` appears on hover; `.hidden-tag` class keeps it visible when active
- **Color picker**: clicking the tag dot (`.tag-dot-btn`) opens a `.color-picker-popover` with 8 `TAG_COLORS` swatches plus a native `<input type="color">`. `openColorPicker(tag, anchorEl)` positions it fixed near the anchor; `closeColorPicker()` removes it. The global click handler calls `closeColorPicker()`.

## Save Image

`downloadAnnotatedImage()` renders annotations at the original image resolution:

1. Create an offscreen canvas sized `imgW × imgH`
2. Draw `sourceImage` onto it
3. Temporarily set `scale = 1` so `i2c()` returns identity — canvas coords equal image coords
4. Call `drawAnnotation()` for each visible annotation with scaled `labelSize`
5. Restore `scale`, export via `canvas.toBlob()` → object URL → `<a>` click

Output filename: `<imageBaseName>_annotated.png`.

## DOM update pattern

- `redraw()` — clears and redraws the main canvas; skips annotations in `hiddenTagIds`
- `refreshList()` — rebuilds `#annotation-list` from scratch and re-attaches listeners; applies `.selected` from `selectedIds`, `.ann-hidden` from `hiddenTagIds`
- `refreshTagsList()` — rebuilds the tags panel; applies count badges, eye buttons, dot-as-button
- `updateCoordsHud(ix, iy)` — updates the coords/zoom HUD; pass `null, null` for zoom-only display. When mouse is over the canvas, a second row shows `R G B L` sampled from the main canvas, normalised to [0, 1] (silently omitted if canvas is cross-origin tainted)
- Selection state uses class toggling on existing rows where possible (to preserve focused inputs)

## CSS themes

Dark is default (`:root` variables). Light theme adds `body.light` and overrides the same custom properties. `color-mix()` is used for some derived values. The dot-grid background uses `--bg3` (`#2d3748`) in dark theme and `#c8cdd6` in light theme.

### CSS classes added for new features

| Class | Purpose |
|---|---|
| `.tag-count` | Annotation count badge in tag row |
| `.tag-eye-btn` | Eye toggle button in tag row (hidden until hover; always visible when active) |
| `.tag-eye-btn.hidden-tag` | Active (tag is hidden) state — highlighted color |
| `.tag-dot-btn` | Tag color dot, now a button that opens the color picker |
| `.color-picker-popover` | Fixed-positioned color picker popover |
| `.color-swatches` | 4-column grid of color swatches inside popover |
| `.color-swatch` | Individual swatch (22×22 px, hover scale) |
| `.color-swatch.active` | Currently selected swatch (white border) |
| `.color-custom-row` | Row with native color input + label |
| `.color-native-input` | The `<input type="color">` element |
| `.color-custom-label` | Label next to native color input |
| `.ann-item.ann-hidden` | Dimmed sidebar row for hidden annotations |

## Tools menu (top-right toolbar)

A wrench "Tools" button opens a dropdown with six data-analysis tools that operate on the **current in-memory annotations** (no export/import needed). Each opens a dialog where the user picks an optional tag filter, then clicks "Download CSV".

### Extract
Ports `scripts/extract.py`. Projects **point** annotations onto axes defined by **line** annotations.

- **Axis line naming**: `NAME: val1 val2 [L]`  — e.g. `X: 0 100`, `Y: 1e-3 1e3 L` (L = log scale)
- Regex: `/^(\w+):\s*([\d.efg+\-]+)\s+([\d.efg+\-]+)\s*(L?)/i`
- Each point is projected onto every axis using the dot-product formula from `extract.py`
- CSV columns: `name` + one per axis name (sorted), one row per point
- Output filename: `<imageBaseName>_extract.csv`

### Measure
Ports `scripts/measure.py`. Measures the pixel length of **line** annotations using a reference scale.

- **Scale line naming**: `NAME: length`  — e.g. `scale: 100` (this line spans 100 units)
- Regex: `/^(\w+):\s*([\d.efg+\-]+)$/i`
- All lines passing the tag filter are measured against every scale (including scale lines themselves if unfiltered — faithful to the Python original)
- CSV columns: `name` + one per scale name (sorted), one row per measured line
- Output filename: `<imageBaseName>_measure.csv`

### Profile
Samples pixel intensity along **line** annotations at natural image resolution.

- Any line annotation qualifies (no special naming required)
- Renders `sourceImage` to an offscreen canvas, calls `getImageData` once per tool invocation
- Samples nearest-neighbour at N+1 evenly-spaced points where N = `ceil(pixel length)`, capped at 10 000
- Luminance: `0.2126r + 0.7152g + 0.0722b`
- If any `NAME: length` scale lines exist, three columns per scale are inserted after `y_px`: `position_NAME, x_NAME, y_NAME` (physical units)
- CSV columns: `name, position_px, x_px, y_px, [position_S, x_S, y_S …], r, g, b, luminance`
- Output filename: `<imageBaseName>_profile.csv`

### Angle
Measures the orientation of **line** annotations.

- Any line annotation qualifies (no special naming required)
- Algorithm: `atan2(-dy, dx)` in degrees, normalised to `[0, 180)` (y negated to flip image→math coords; undirected)
- 0° = horizontal, 90° = vertical; subtract two values to get the inter-line angle
- CSV columns: `name, angle_deg`
- Output filename: `<imageBaseName>_angle.csv`

### Distances
Measures pairwise pixel distances between all **point** annotations, with optional unit conversion.

- **Scale line naming**: `NAME: length` — same convention as Measure
- All pairs (i < j) of filtered points are measured; pixel distance × unitperpx per scale
- CSV columns: `from, to, dist_<scale1>, dist_<scale2>, …`
- Output filename: `<imageBaseName>_distances.csv`

### Area
Measures dimensions, aspect ratio, and area of **rectangle** annotations, with optional unit conversion.

- **Scale line naming**: `NAME: length` — same convention as Measure
- Per rectangle: `width_px`, `height_px`, `aspect_ratio` (w/h), then per scale: `width_K`, `height_K`, `area_K`
- CSV columns: `name, width_px, height_px, aspect_ratio, width_<K>, height_<K>, area_<K>, …`
- Output filename: `<imageBaseName>_area.csv`

### Tag filtering in tools
Tags are stored in-memory by UUID (`ann.tags` = array of tag IDs). The dialog populates a `<select>` with tag names mapped to their IDs. `tagId && !ann.tags.includes(tagId)` performs the filter — identical semantics to the Python `tag not in item["tags"]` check on exported tag names.

### CSV sanitization
`csvSanitize(s)` wraps fields containing commas, double-quotes, or newlines in double-quotes, and escapes internal double-quotes as `""` (RFC 4180).

## Running

```sh
bash launch.sh        # macOS – opens in default browser
# or just open index.html directly in any modern browser
```
