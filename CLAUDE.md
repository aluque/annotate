# Annotate – CLAUDE.md

## What this app is

A browser-based image annotation tool. Users open an image, place geometric annotations (points, lines, rectangles) on it, assign tags to them, and export the result as JSON. No server, no build step, no dependencies.

## File structure

```
index.html   – DOM layout (toolbar, sidebar, canvas area, status bar)
app.js       – All application logic (~900 lines, single file)
style.css    – Styling; dark theme by default, light theme via body.light
launch.sh    – macOS helper that opens the app in a browser (tries Safari → Chrome → Chromium → Firefox)
```

## Tech stack

Vanilla HTML5/CSS3/JS. No frameworks, no bundler, no package manager. The canvas API does all drawing.

## Architecture

Single-page app, entirely client-side. State lives in module-level variables in `app.js`. Changes call `redraw()` (canvas) and/or `refreshList()` (DOM sidebar). There is no reactivity layer.

### Layout

```
Toolbar (50px)       – tools, prefix input, file controls, theme toggle
├── Sidebar (230px)  – annotation list, tags panel, 4× zoom viewer
└── Canvas area      – zoomable/pannable image with overlay canvas
Status bar (22px)    – current tool, keyboard shortcuts, context hint
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

### Coordinate system

All annotations are stored in **image coordinates** (original pixel space). `c2i()` converts canvas→image, `i2c()` converts image→canvas. The `scale` variable is the only transform (no pan offset stored — panning uses `scrollLeft/scrollTop` on the canvas-area div).

### Colors

```js
C_NORMAL   = '#f6e05e'  // yellow  – default annotation
C_SELECTED = '#fc8181'  // red     – selected annotation
C_PREVIEW  = '#68d391'  // green   – in-progress drawing
```

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
- **Shift held during line/rect drawing**: constrains to horizontal or vertical
- **Auto-naming**: `<prefix><counter padded to 3 digits>`. Prefix defaults per type (`Point`, `Line`, `Rectangle`) but the toolbar input overrides all three.
- **Tag selection for new annotations**: click tag in sidebar to toggle; Shift+click for range; Cmd/Ctrl+click for single toggle
- **Drag-and-drop**: canvas-area accepts both image files and JSON files
- **Keyboard shortcuts**: S / P / L / R (tools), Del (delete selected), Esc (cancel in-progress)

## DOM update pattern

- `redraw()` — clears and redraws the main canvas
- `refreshList()` — rebuilds `#annotation-list` from scratch, then calls `refreshTagsPanel()` and re-attaches listeners
- Selection state uses class toggling on existing rows where possible (to preserve focused inputs)

## CSS themes

Dark is default (`:root` variables). Light theme adds `body.light` and overrides the same custom properties. `color-mix()` is used for some derived values.

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

### JS functions (app.js Tools section)
| Function | Purpose |
|---|---|
| `toggleToolsMenu(e)` | Opens/closes the dropdown |
| `openToolDialog(toolName)` | Populates and shows the modal |
| `closeToolDialog()` | Hides modal, clears `currentTool` |
| `runCurrentTool()` | Calls the tool's `run(tagId)`, downloads CSV |
| `runExtract(tagId)` | Extract logic |
| `runMeasure(tagId)` | Measure logic |
| `downloadCSV(content, filename)` | Blob download helper |
| `csvSanitize(s)` | Wraps strings containing commas in quotes |

## Running

```sh
bash launch.sh        # macOS – opens in default browser
# or just open index.html directly in any modern browser
```
