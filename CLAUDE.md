# Annotate – CLAUDE.md

## What this app is

A browser-based image annotation tool. Users open an image, place geometric annotations (points, lines, rectangles) on it, assign tags to them, and export the result as JSON. No server, no build step, no dependencies.

## File structure

```
index.html   – DOM layout (toolbar, sidebar, canvas area, status bar)
app.js       – All application logic (~1100 lines, single file)
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
| `selectedId` | UUID of selected annotation, or null |
| `expandedAnnotationId` | Annotation whose inline tag editor is open |
| `activeTags` | Set of tag IDs pre-selected for the next annotation |
| `mode` | `'select' \| 'point' \| 'line' \| 'rect'` |
| `scale` | canvas px / image px (zoom level) |
| `counters` | `{point, line, rect}` — incremented for auto-naming |
| `undoStack` | Array of `{annotations, tags, counters}` snapshots (max 50) |

### Coordinate system

All annotations are stored in **image coordinates** (original pixel space). `c2i()` converts canvas→image, `i2c()` converts image→canvas. The `scale` variable is the only transform (no pan offset stored — panning uses `scrollLeft/scrollTop` on the canvas-area div).

### Colors

```js
C_NORMAL   = '#f6e05e'  // yellow – default annotation (no tag)
C_PREVIEW  = '#68d391'  // green  – in-progress drawing
```

There is no fixed `C_SELECTED`. The selected color is computed dynamically by `annotationColor()`:

```js
function annotationColor(ann) {
  let base = C_NORMAL;
  if (ann.tags?.length > 0) base = tags.find(t => t.id === ann.tags[0])?.color ?? C_NORMAL;
  return ann.id === selectedId ? mixWithWhite(base, 0.55) : base;
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
- Annotations are tested in reverse order (top-most drawn = first hit)
- Points: distance to center ≤ HIT_RADIUS
- Lines: perpendicular distance to segment ≤ HIT_RADIUS
- Rectangles: proximity to any edge ≤ HIT_RADIUS

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

- **Panning**: right-click drag
- **Zoom**: mouse wheel
- **Fit to view**: `F` key — resets scale and scroll to fit the image in the viewport
- **Shift held during line/rect drawing**: constrains to horizontal or vertical
- **Auto-naming**: `<prefix><counter padded to 3 digits>`. Prefix defaults per type (`Point`, `Line`, `Rectangle`) but the toolbar input overrides all three.
- **Tag selection for new annotations**: click tag in sidebar to toggle; Shift+click for range; Cmd/Ctrl+click for single toggle
- **Drag-and-drop**: canvas-area accepts both image files and JSON files
- **Keyboard shortcuts**: S / P / L / R (tools), Del (delete selected), Esc (cancel in-progress), F (fit), Tab / Shift+Tab (cycle annotations), Cmd/Ctrl+Z (undo)

## Undo

`pushUndo()` records a deep-copy snapshot of `{annotations, tags, counters}` before every mutating operation. `undo()` pops the stack and restores all three, then calls `refreshTagsList()`, `refreshList()`, `redraw()`. Stack limit: 50 entries.

Operations that call `pushUndo()`: `addAnnotation`, `deleteAnnotation`, `clearAnnotations` (after confirm), `deleteTag`, annotation name change, annotation tag toggle, tag creation, JSON import.

## DOM update pattern

- `redraw()` — clears and redraws the main canvas
- `refreshList()` — rebuilds `#annotation-list` from scratch and re-attaches listeners
- `updateCoordsHud(ix, iy)` — updates the coords/zoom HUD; pass `null, null` for zoom-only display
- Selection state uses class toggling on existing rows where possible (to preserve focused inputs)

## CSS themes

Dark is default (`:root` variables). Light theme adds `body.light` and overrides the same custom properties. `color-mix()` is used for some derived values. The dot-grid background uses `--bg3` (`#2d3748`) in dark theme and `#c8cdd6` in light theme.

## Tools menu (top-right toolbar)

A wrench "Tools" button opens a dropdown with two data-analysis tools that operate on the **current in-memory annotations** (no export/import needed). Each opens a dialog where the user picks an optional tag filter, then clicks "Download CSV".

### Extract
Ports `scripts/extract.py`. Projects **point** annotations onto axes defined by **line** annotations.

- **Axis line naming**: `NAME: val1 val2 [L]`  — e.g. `X: 0 100`, `Y: 1e-3 1e3 L` (L = log scale)
- Regex: `/^(\w+):\s*([\d.efg+\-]+)\s+([\d.efg+\-]+)\s*(L?)/i`
- Each point is projected onto every axis using the dot-product formula from `extract.py`
- CSV columns: one per axis name (sorted), one row per point
- Output filename: `<imageBaseName>_extract.csv`

### Measure
Ports `scripts/measure.py`. Measures the pixel length of **line** annotations using a reference scale.

- **Scale line naming**: `NAME: length`  — e.g. `scale: 100` (this line spans 100 units)
- Regex: `/^(\w+):\s*([\d.efg+\-]+)$/i`
- All lines passing the tag filter are measured against every scale (including scale lines themselves if unfiltered — faithful to the Python original)
- CSV columns: `name` + one per scale name (sorted), one row per measured line
- Output filename: `<imageBaseName>_measure.csv`

### Tag filtering in tools
Tags are stored in-memory by UUID (`ann.tags` = array of tag IDs). The dialog populates a `<select>` with tag names mapped to their IDs. `tagId && !ann.tags.includes(tagId)` performs the filter — identical semantics to the Python `tag not in item["tags"]` check on exported tag names.

### CSV sanitization
`csvSanitize(s)` wraps fields containing commas, double-quotes, or newlines in double-quotes, and escapes internal double-quotes as `""` (RFC 4180).

## Running

```sh
bash launch.sh        # macOS – opens in default browser
# or just open index.html directly in any modern browser
```
