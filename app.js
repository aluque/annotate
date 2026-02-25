'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const C_NORMAL   = '#94a3b8';   // slate – default annotation color (no tag)
const C_PREVIEW  = '#68d391';   // green  – in-progress drawing
const ZOOM_FACTOR = 4;
const HIT_RADIUS  = 8;          // canvas px

// ── State ──────────────────────────────────────────────────────────────────
let annotations  = [];
let selectedId   = null;
let selectedIds  = new Set();  // for multi-select
let mode         = 'select';
let sourceImage  = null;        // HTMLImageElement
let imageBaseName = 'annotations'; // derived from the loaded image filename
let imageFileName = '';            // full original filename including extension
let imgW = 0, imgH = 0;
let scale = 1;                  // canvas px / image px
let minScale = 0.1;             // updated by fitCanvas()

// In-progress drawing state
let lineP1   = null;            // {x,y} in image coords
let rectP1   = null;
let dragging = false;

// Annotation drag-move state
let dragTarget     = null;
let dragPart       = null;      // 'whole' | 'p1' | 'p2'
let dragStart      = null;      // {canvasX, canvasY}
let dragOrigCoords = null;      // deep-copy of ann.coords at drag start
let dragMoved      = false;

let mouseCanvas = null;         // {x,y} in canvas coords, or null
let shiftHeld   = false;
let spaceHeld   = false;
let showLabels  = true;

// Panning state
let isPanning = false;
let panStart  = null;           // {mouseX, mouseY, scrollLeft, scrollTop}

// Touch / pinch state
let touchIsPinching     = false;
let touchPinchDist0     = null;   // finger distance at pinch start
let touchPinchScale0    = null;   // scale at pinch start
let touchPinchImgAnchor = null;   // image coords under midpoint at pinch start

// Name counters
const counters = { point: 0, line: 0, rect: 0 };

// ── Tags state ─────────────────────────────────────────────────────────────
const TAG_COLORS = [
  '#f87171', '#60a5fa', '#4ade80', '#facc15',
  '#fb923c', '#34d399', '#a78bfa', '#f472b6',
];
let tags               = [];   // [{id, name, color}]
let activeTags         = new Set(); // IDs of tags applied to the next new annotation
let hiddenTagIds       = new Set(); // IDs of tags whose annotations are hidden
let tagAnchorId        = null;     // anchor for shift-click range selection
let expandedAnnotationId = null;   // annotation whose tag editor is open

// Undo / redo stacks
const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 50;

// Color picker popover reference
let colorPickerPopover = null;

// ── DOM refs ───────────────────────────────────────────────────────────────
const mainCanvas = document.getElementById('main-canvas');
const mainCtx    = mainCanvas.getContext('2d');
const zoomCanvas = document.getElementById('zoom-canvas');
const zoomCtx    = zoomCanvas.getContext('2d');
const annList    = document.getElementById('annotation-list');
const tagsList   = document.getElementById('tags-list');
const coordsHud  = document.getElementById('coords-hud');
const dropZone   = document.getElementById('drop-zone');
const canvasWrap = document.getElementById('canvas-wrapper');
const canvasArea = document.getElementById('canvas-area');

// ── Utilities ──────────────────────────────────────────────────────────────
function uid() { return crypto.randomUUID(); }

const DEFAULT_PREFIX = { point: 'Point', line: 'Line', rect: 'Rectangle' };

function nextName(type) {
  counters[type]++;
  const n      = String(counters[type]).padStart(3, '0');
  const prefix = document.getElementById('prefix-input').value.trim() || DEFAULT_PREFIX[type];
  return `${prefix}${n}`;
}

// Mix a 6-digit hex color toward white.  t=0 → original, t=1 → #ffffff.
function mixWithWhite(hex, t) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mix = c => Math.round(c + (255 - c) * t).toString(16).padStart(2, '0');
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeHexColor(value, fallback = TAG_COLORS[0]) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

function annotationHasTag(ann, tagId) {
  return Array.isArray(ann.tags) && ann.tags.includes(tagId);
}

/** Returns false if every tag on this annotation is hidden. Untagged annotations are always visible. */
function isAnnotationVisible(ann) {
  if (!ann.tags || ann.tags.length === 0) return true;
  return !ann.tags.some(tid => hiddenTagIds.has(tid));
}

// Coordinate helpers
function c2i(cx, cy) { return { x: cx / scale, y: cy / scale }; }
function i2c(ix, iy) { return { x: ix * scale, y: iy * scale }; }

// Constrain p2 to be axis-aligned with p1 (horizontal or vertical)
function constrainAxis(p1, p2) {
  const dx = Math.abs(p2.x - p1.x), dy = Math.abs(p2.y - p1.y);
  return dx >= dy ? { x: p2.x, y: p1.y } : { x: p1.x, y: p2.y };
}

function getCanvasPos(e) {
  const r = mainCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// ── Undo ───────────────────────────────────────────────────────────────────
function pushUndo() {
  undoStack.push({
    annotations: JSON.parse(JSON.stringify(annotations)),
    tags:        JSON.parse(JSON.stringify(tags)),
    counters:    { ...counters },
  });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0; // clear redo on any new action
}

function undo() {
  if (undoStack.length === 0) return;
  // Save current state to redoStack before undoing
  redoStack.push({
    annotations: JSON.parse(JSON.stringify(annotations)),
    tags:        JSON.parse(JSON.stringify(tags)),
    counters:    { ...counters },
  });
  const state = undoStack.pop();
  annotations          = state.annotations;
  tags                 = state.tags;
  counters.point       = state.counters.point;
  counters.line        = state.counters.line;
  counters.rect        = state.counters.rect;
  selectedId           = null;
  selectedIds          = new Set();
  expandedAnnotationId = null;
  // Drop any activeTags / hiddenTagIds that no longer exist
  const tagIds = new Set(tags.map(t => t.id));
  for (const id of activeTags)    if (!tagIds.has(id)) activeTags.delete(id);
  for (const id of hiddenTagIds)  if (!tagIds.has(id)) hiddenTagIds.delete(id);
  refreshTagsList();
  refreshList();
  redraw();
}

function redo() {
  if (redoStack.length === 0) return;
  // Push current state to undoStack without clearing redoStack
  undoStack.push({
    annotations: JSON.parse(JSON.stringify(annotations)),
    tags:        JSON.parse(JSON.stringify(tags)),
    counters:    { ...counters },
  });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  const state = redoStack.pop();
  annotations          = state.annotations;
  tags                 = state.tags;
  counters.point       = state.counters.point;
  counters.line        = state.counters.line;
  counters.rect        = state.counters.rect;
  selectedId           = null;
  selectedIds          = new Set();
  expandedAnnotationId = null;
  const tagIds = new Set(tags.map(t => t.id));
  for (const id of activeTags)   if (!tagIds.has(id)) activeTags.delete(id);
  for (const id of hiddenTagIds) if (!tagIds.has(id)) hiddenTagIds.delete(id);
  refreshTagsList();
  refreshList();
  redraw();
}

// ── Mode ───────────────────────────────────────────────────────────────────
function setMode(m) {
  mode     = m;
  lineP1   = null;
  rectP1   = null;
  dragging = false;

  document.querySelectorAll('.btn-tool').forEach(b => b.classList.remove('active'));
  const btnId = { select: 'btn-select', point: 'btn-point', line: 'btn-line', rect: 'btn-rect' }[m];
  if (btnId) document.getElementById(btnId).classList.add('active');

  const modeLabel = { select: 'Select', point: 'Add Point', line: 'Add Line', rect: 'Add Rectangle' }[m] || m;
  document.getElementById('status-mode').textContent = modeLabel;

  if (DEFAULT_PREFIX[m]) {
    document.getElementById('prefix-input').value = DEFAULT_PREFIX[m];
  }

  const hints = {
    select: 'Click an annotation to select it',
    point:  'Click to place a point',
    line:   'Click start point, then click end point',
    rect:   'Click and drag to draw a rectangle',
  };
  document.getElementById('status-hint').textContent = hints[m] || '';

  mainCanvas.style.cursor = m === 'select' ? 'default' : 'crosshair';
  redraw();
}

// ── Image loading ──────────────────────────────────────────────────────────
function openImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  imageFileName = file.name;
  imageBaseName = file.name.replace(/\.[^.]+$/, ''); // strip extension
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    sourceImage = img;
    imgW = img.naturalWidth;
    imgH = img.naturalHeight;
    dropZone.style.display   = 'none';
    canvasWrap.style.display = 'block';
    fitToView();
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function fitCanvas() {
  const padX = 40, padY = 40;
  const maxW = canvasArea.clientWidth  - padX;
  const maxH = canvasArea.clientHeight - padY;
  minScale = Math.min(maxW / imgW, maxH / imgH);
  scale    = Math.min(1, minScale);
  mainCanvas.width  = Math.round(imgW * scale);
  mainCanvas.height = Math.round(imgH * scale);
  updateCanvasPadding();
}

// Keep the canvas centred via margin when it is smaller than the viewport,
// and use a fixed minimum gap when it is larger. Reading canvasWrap.offsetLeft
// after this call gives the exact value needed for scroll calculations.
function updateCanvasPadding() {
  const pad = 20;
  const mx = Math.max(pad, Math.round((canvasArea.clientWidth  - mainCanvas.width)  / 2));
  const my = Math.max(pad, Math.round((canvasArea.clientHeight - mainCanvas.height) / 2));
  canvasWrap.style.margin = `${my}px ${mx}px`;
}

// Fit image to viewport and scroll to show it centred (F key).
function fitToView() {
  if (!sourceImage) return;
  fitCanvas();
  redraw();
  canvasArea.scrollLeft = 0;
  canvasArea.scrollTop  = 0;
  updateCoordsHud(null, null);
}

/** Zoom by a multiplicative factor, keeping the given client-space point fixed. */
function zoomBy(factor, pivotClientX, pivotClientY) {
  if (!sourceImage) return;
  const newScale = Math.max(minScale, Math.min(4, scale * factor));
  if (newScale === scale) return;
  const canvasRect   = mainCanvas.getBoundingClientRect();
  const mouseCanvasX = pivotClientX - canvasRect.left;
  const mouseCanvasY = pivotClientY - canvasRect.top;
  const imgX = mouseCanvasX / scale;
  const imgY = mouseCanvasY / scale;
  scale = newScale;
  mainCanvas.width  = Math.round(imgW * scale);
  mainCanvas.height = Math.round(imgH * scale);
  updateCanvasPadding();
  redraw();
  const areaRect = canvasArea.getBoundingClientRect();
  canvasArea.scrollLeft = canvasWrap.offsetLeft + imgX * scale - (pivotClientX - areaRect.left);
  canvasArea.scrollTop  = canvasWrap.offsetTop  + imgY * scale - (pivotClientY - areaRect.top);
  updateCoordsHud(null, null);
}

// Update the coordinate / zoom HUD.  Call with (ix, iy) when the mouse is
// over the canvas, or (null, null) to show only the zoom level.
function updateCoordsHud(ix, iy) {
  if (!sourceImage) { coordsHud.textContent = '—'; return; }
  const z = `${Math.round(scale * 100)}%`;
  if (ix == null) { coordsHud.textContent = z; return; }

  let pixelLine = '';
  try {
    const cx = Math.max(0, Math.min(mainCanvas.width  - 1, Math.round(ix * scale)));
    const cy = Math.max(0, Math.min(mainCanvas.height - 1, Math.round(iy * scale)));
    const px = mainCtx.getImageData(cx, cy, 1, 1).data;
    const lum = 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
    const fmt = v => (v / 255).toFixed(3);
    pixelLine = `R:${fmt(px[0])}  G:${fmt(px[1])}  B:${fmt(px[2])}  L:${fmt(lum)}`;
  } catch (_) { /* cross-origin tainted — omit pixel row */ }

  coordsHud.innerHTML =
    `x: ${ix.toFixed(2)}   y: ${iy.toFixed(2)}   ·   ${z}` +
    (pixelLine ? `<br>${pixelLine}` : '');
}

// ── Annotation CRUD ────────────────────────────────────────────────────────
function addAnnotation(ann) {
  pushUndo();
  ann.tags = [...activeTags];
  annotations.push(ann);
  selectedId  = ann.id;
  selectedIds = new Set([ann.id]);
  refreshList();
  redraw();
  scrollToSelected();
}

function deleteAnnotation(id) {
  pushUndo();
  annotations = annotations.filter(a => a.id !== id);
  if (selectedId === id) selectedId = null;
  selectedIds.delete(id);
  if (expandedAnnotationId === id) expandedAnnotationId = null;
  refreshList();
  redraw();
}

function selectAnnotation(id) {
  selectedId  = id;
  selectedIds = new Set(id ? [id] : []);
  // Update classes in-place so a focused input isn't destroyed by a DOM rebuild
  annList.querySelectorAll('.ann-item').forEach(el => {
    el.classList.toggle('selected', selectedIds.has(el.dataset.id));
  });
  redraw();
  if (id) scrollToSelected();
}

/** Toggle a single annotation in/out of the multi-select set. */
function toggleSelectAnnotation(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
    if (selectedId === id) selectedId = selectedIds.size > 0 ? [...selectedIds][0] : null;
  } else {
    selectedIds.add(id);
    selectedId = id;
  }
  annList.querySelectorAll('.ann-item').forEach(el => {
    el.classList.toggle('selected', selectedIds.has(el.dataset.id));
  });
  redraw();
}

function scrollToSelected() {
  const el = annList.querySelector(`[data-id="${selectedId}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

// ── Hit testing ────────────────────────────────────────────────────────────
function distPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx*dx + dy*dy;
  if (lenSq === 0) return Math.hypot(px-ax, py-ay);
  const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / lenSq));
  return Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
}

function hitTest(cx, cy) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (!isAnnotationVisible(a)) continue;
    if (a.type === 'point') {
      const p = i2c(a.coords[0], a.coords[1]);
      if (Math.hypot(cx-p.x, cy-p.y) <= HIT_RADIUS) return a;
    } else if (a.type === 'line') {
      const p1 = i2c(a.coords[0][0], a.coords[0][1]);
      const p2 = i2c(a.coords[1][0], a.coords[1][1]);
      if (distPointToSegment(cx, cy, p1.x, p1.y, p2.x, p2.y) <= HIT_RADIUS) return a;
    } else if (a.type === 'rect') {
      const p1 = i2c(a.coords[0][0], a.coords[0][1]);
      const p2 = i2c(a.coords[1][0], a.coords[1][1]);
      const onV  = cy >= p1.y - HIT_RADIUS && cy <= p2.y + HIT_RADIUS;
      const onH  = cx >= p1.x - HIT_RADIUS && cx <= p2.x + HIT_RADIUS;
      const nearL = Math.abs(cx - p1.x) <= HIT_RADIUS && onV;
      const nearR = Math.abs(cx - p2.x) <= HIT_RADIUS && onV;
      const nearT = Math.abs(cy - p1.y) <= HIT_RADIUS && onH;
      const nearB = Math.abs(cy - p2.y) <= HIT_RADIUS && onH;
      if (nearL || nearR || nearT || nearB) return a;
    }
  }
  return null;
}

/** Like hitTest but also returns which part was hit for drag-move purposes. */
function hitTestWithPart(cx, cy) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (!isAnnotationVisible(a)) continue;
    if (a.type === 'point') {
      const p = i2c(a.coords[0], a.coords[1]);
      if (Math.hypot(cx-p.x, cy-p.y) <= HIT_RADIUS) return { ann: a, part: 'whole' };
    } else if (a.type === 'line') {
      const p1 = i2c(a.coords[0][0], a.coords[0][1]);
      const p2 = i2c(a.coords[1][0], a.coords[1][1]);
      if (Math.hypot(cx-p1.x, cy-p1.y) <= HIT_RADIUS) return { ann: a, part: 'p1' };
      if (Math.hypot(cx-p2.x, cy-p2.y) <= HIT_RADIUS) return { ann: a, part: 'p2' };
      if (distPointToSegment(cx, cy, p1.x, p1.y, p2.x, p2.y) <= HIT_RADIUS) return { ann: a, part: 'whole' };
    } else if (a.type === 'rect') {
      const p1 = i2c(a.coords[0][0], a.coords[0][1]);
      const p2 = i2c(a.coords[1][0], a.coords[1][1]);
      // Corner dots are resize handles — check them first
      if (Math.hypot(cx-p1.x, cy-p1.y) <= HIT_RADIUS) return { ann: a, part: 'p1' };
      if (Math.hypot(cx-p2.x, cy-p2.y) <= HIT_RADIUS) return { ann: a, part: 'p2' };
      // Edges move the whole rect
      const minX = Math.min(p1.x, p2.x), maxX = Math.max(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y), maxY = Math.max(p1.y, p2.y);
      const onV  = cy >= minY - HIT_RADIUS && cy <= maxY + HIT_RADIUS;
      const onH  = cx >= minX - HIT_RADIUS && cx <= maxX + HIT_RADIUS;
      const nearL = Math.abs(cx - p1.x) <= HIT_RADIUS && onV;
      const nearR = Math.abs(cx - p2.x) <= HIT_RADIUS && onV;
      const nearT = Math.abs(cy - p1.y) <= HIT_RADIUS && onH;
      const nearB = Math.abs(cy - p2.y) <= HIT_RADIUS && onH;
      if (nearL || nearR || nearT || nearB) return { ann: a, part: 'whole' };
    }
  }
  return null;
}

// ── Canvas events ──────────────────────────────────────────────────────────
mainCanvas.addEventListener('mousedown', e => {
  if (!sourceImage) return;

  // Right-click or Space+left-click → start pan
  if (e.button === 2 || (e.button === 0 && spaceHeld)) {
    isPanning = true;
    panStart  = { mouseX: e.clientX, mouseY: e.clientY,
                  scrollLeft: canvasArea.scrollLeft, scrollTop: canvasArea.scrollTop };
    mainCanvas.style.cursor = 'grabbing';
    return;
  }

  const cp = getCanvasPos(e);
  const ip = c2i(cp.x, cp.y);

  if (mode === 'select') {
    const hit = hitTestWithPart(cp.x, cp.y);
    if (e.shiftKey && hit) {
      toggleSelectAnnotation(hit.ann.id);
      return;
    }
    if (hit) {
      selectAnnotation(hit.ann.id);
      // Snap point / endpoint / corner to cursor so the zoom crosshair stays accurate.
      // Whole-body line/rect drags keep the offset so the body doesn't jump.
      const isHandle = hit.ann.type === 'point' || hit.part !== 'whole';
      if (isHandle) {
        pushUndo();
        if (hit.ann.type === 'point') {
          hit.ann.coords = [ip.x, ip.y];
        } else if (hit.part === 'p1') {
          hit.ann.coords[0] = [ip.x, ip.y];
        } else {
          hit.ann.coords[1] = [ip.x, ip.y];
        }
      }
      dragTarget     = hit.ann;
      dragPart       = hit.part;
      dragStart      = { canvasX: cp.x, canvasY: cp.y };
      dragOrigCoords = JSON.parse(JSON.stringify(hit.ann.coords));
      dragMoved      = isHandle;
      if (isHandle) redraw();
    } else {
      selectAnnotation(null);
    }
    return;
  }

  if (mode === 'point') {
    addAnnotation({ id: uid(), type: 'point', name: nextName('point'), coords: [ip.x, ip.y] });
    return;
  }

  if (mode === 'line') {
    lineP1   = ip;
    dragging = true;
    return;
  }

  if (mode === 'rect') {
    rectP1   = ip;
    dragging = true;
    return;
  }
});

mainCanvas.addEventListener('mousemove', e => {
  // Pan takes priority
  if (isPanning && panStart) {
    canvasArea.scrollLeft = panStart.scrollLeft - (e.clientX - panStart.mouseX);
    canvasArea.scrollTop  = panStart.scrollTop  - (e.clientY - panStart.mouseY);
    return;
  }

  const cp = getCanvasPos(e);
  mouseCanvas = cp;
  shiftHeld   = e.shiftKey;

  if (spaceHeld) mainCanvas.style.cursor = 'grab';

  // Drag-move annotation
  if (dragTarget && dragStart) {
    const dx = cp.x - dragStart.canvasX;
    const dy = cp.y - dragStart.canvasY;
    if (dragMoved || Math.hypot(dx, dy) >= 2) {
      if (!dragMoved) { pushUndo(); dragMoved = true; }
      const idx = dx / scale, idy = dy / scale;
      const orig = dragOrigCoords, ann = dragTarget;
      if (ann.type === 'point') {
        ann.coords = [orig[0] + idx, orig[1] + idy];
      } else if (ann.type === 'line') {
        if (dragPart === 'p1')
          ann.coords = [[orig[0][0]+idx, orig[0][1]+idy], [...orig[1]]];
        else if (dragPart === 'p2')
          ann.coords = [[...orig[0]], [orig[1][0]+idx, orig[1][1]+idy]];
        else
          ann.coords = [[orig[0][0]+idx, orig[0][1]+idy], [orig[1][0]+idx, orig[1][1]+idy]];
      } else if (ann.type === 'rect') {
        if (dragPart === 'p1')
          ann.coords = [[orig[0][0]+idx, orig[0][1]+idy], [...orig[1]]];
        else if (dragPart === 'p2')
          ann.coords = [[...orig[0]], [orig[1][0]+idx, orig[1][1]+idy]];
        else
          ann.coords = [[orig[0][0]+idx, orig[0][1]+idy], [orig[1][0]+idx, orig[1][1]+idy]];
      }
      const isResizing = dragTarget.type === 'rect' && (dragPart === 'p1' || dragPart === 'p2');
      mainCanvas.style.cursor = isResizing ? 'nwse-resize' : 'move';
      redraw();
    }
  }

  if (sourceImage) {
    const ip = c2i(cp.x, cp.y);
    updateCoordsHud(ip.x, ip.y);
    updateZoom(cp.x, cp.y);
  }

  if (dragging || lineP1) redraw();

  // Hover cursor: resize for rect corners, move for everything else hittable
  if (mode === 'select' && !dragTarget && !isPanning && !spaceHeld && sourceImage) {
    const h = hitTestWithPart(cp.x, cp.y);
    mainCanvas.style.cursor = !h ? 'default'
      : (h.ann.type === 'rect' && (h.part === 'p1' || h.part === 'p2')) ? 'nwse-resize'
      : 'move';
  }
});

mainCanvas.addEventListener('mouseup', e => {
  if (isPanning && (e.button === 2 || e.button === 0)) {
    isPanning = false;
    panStart  = null;
    mainCanvas.style.cursor = spaceHeld ? 'grab' : (mode === 'select' ? 'default' : 'crosshair');
    return;
  }

  if (dragTarget) {
    if (dragMoved) refreshList();
    dragTarget = dragPart = dragStart = dragOrigCoords = null;
    dragMoved  = false;
    mainCanvas.style.cursor = 'default';
    return;
  }

  if (mode === 'line' && dragging && lineP1) {
    const cp = getCanvasPos(e);
    const ip = c2i(cp.x, cp.y);
    const ip2 = e.shiftKey ? constrainAxis(lineP1, ip) : ip;
    if (Math.hypot(ip2.x - lineP1.x, ip2.y - lineP1.y) > 2) {
      addAnnotation({ id: uid(), type: 'line', name: nextName('line'),
        coords: [[lineP1.x, lineP1.y], [ip2.x, ip2.y]] });
    }
    lineP1   = null;
    dragging = false;
    redraw();
  }

  if (mode === 'rect' && dragging && rectP1) {
    const cp = getCanvasPos(e);
    const ip = c2i(cp.x, cp.y);
    const x1 = Math.min(rectP1.x, ip.x), y1 = Math.min(rectP1.y, ip.y);
    const x2 = Math.max(rectP1.x, ip.x), y2 = Math.max(rectP1.y, ip.y);
    if (x2 - x1 > 2 && y2 - y1 > 2) {
      addAnnotation({ id: uid(), type: 'rect', name: nextName('rect'),
        coords: [[x1, y1], [x2, y2]] });
    }
    rectP1   = null;
    dragging = false;
    redraw();
  }
});

mainCanvas.addEventListener('mouseleave', () => {
  mouseCanvas = null;
  updateCoordsHud(null, null);
  updateZoom(null, null);
  if (dragging || lineP1) redraw();
  // Cancel drag if it hadn't moved yet (moved=true means undo already pushed — keep state)
  if (dragTarget && !dragMoved) {
    dragTarget = dragPart = dragStart = dragOrigCoords = null;
  }
});

mainCanvas.addEventListener('contextmenu', e => e.preventDefault());

// Wheel zoom: accumulate delta across all events in the same animation frame
// so that zoom is proportional to scroll intensity rather than event count.
// This prevents the Magic Mouse (which fires many small events) from feeling
// over-sensitive — a light touch produces a small zoom, a deliberate scroll
// produces a larger one.
let wheelAccum  = 0;   // accumulated normalised pixel delta
let wheelPivotX = 0;
let wheelPivotY = 0;
let wheelRafId  = null;
mainCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (!sourceImage) return;
  // Ignore lateral-dominant gestures (Magic Mouse horizontal swipes).
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  // Normalise to pixels regardless of deltaMode.
  let delta = e.deltaY;
  if (e.deltaMode === 1) delta *= 30;   // line  → ~pixels
  if (e.deltaMode === 2) delta *= 300;  // page  → ~pixels
  wheelAccum  += delta;
  wheelPivotX  = e.clientX;
  wheelPivotY  = e.clientY;
  if (wheelRafId) return; // already scheduled for this frame
  wheelRafId = requestAnimationFrame(() => {
    wheelRafId = null;
    // 0.9995^N: 100 px → ~5 %, 20 px → ~1 %, 5 px → ~0.25 %
    const factor = Math.pow(0.9995, wheelAccum);
    wheelAccum = 0;
    zoomBy(factor, wheelPivotX, wheelPivotY);
  });
}, { passive: false });

// ── Touch handlers ──────────────────────────────────────────────────────────

mainCanvas.addEventListener('touchstart', e => {
  e.preventDefault();
  if (!sourceImage) return;

  if (e.touches.length === 2) {
    // Cancel non-moved single-finger drag so it doesn't orphan state
    if (dragTarget && !dragMoved) {
      dragTarget = dragPart = dragStart = dragOrigCoords = null;
    }
    // Cancel line/rect-in-progress
    if (dragging) { lineP1 = null; rectP1 = null; dragging = false; redraw(); }

    const t1 = e.touches[0], t2 = e.touches[1];
    touchPinchDist0  = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    touchPinchScale0 = scale;
    const midCP = getCanvasPos({ clientX: (t1.clientX + t2.clientX) / 2,
                                  clientY: (t1.clientY + t2.clientY) / 2 });
    touchPinchImgAnchor = c2i(midCP.x, midCP.y);
    touchIsPinching = true;
    return;
  }

  if (e.touches.length === 1 && !touchIsPinching) {
    const touch = e.touches[0];
    const cp = getCanvasPos(touch);
    const ip = c2i(cp.x, cp.y);

    if (mode === 'select') {
      const hit = hitTestWithPart(cp.x, cp.y);
      if (hit) {
        selectAnnotation(hit.ann.id);
        const isHandle = hit.ann.type === 'point' || hit.part !== 'whole';
        if (isHandle) {
          pushUndo();
          if (hit.ann.type === 'point') {
            hit.ann.coords = [ip.x, ip.y];
          } else if (hit.part === 'p1') {
            hit.ann.coords[0] = [ip.x, ip.y];
          } else {
            hit.ann.coords[1] = [ip.x, ip.y];
          }
        }
        dragTarget     = hit.ann;
        dragPart       = hit.part;
        dragStart      = { canvasX: cp.x, canvasY: cp.y };
        dragOrigCoords = JSON.parse(JSON.stringify(hit.ann.coords));
        dragMoved      = isHandle;
        if (isHandle) redraw();
      } else {
        selectAnnotation(null);
      }
    } else if (mode === 'point') {
      addAnnotation({ id: uid(), type: 'point', name: nextName('point'),
                      coords: [ip.x, ip.y] });
    } else if (mode === 'line') {
      lineP1   = ip;
      dragging = true;
    } else if (mode === 'rect') {
      rectP1   = ip;
      dragging = true;
    }
  }
}, { passive: false });

mainCanvas.addEventListener('touchmove', e => {
  e.preventDefault();
  if (!sourceImage) return;

  if (e.touches.length === 2 && touchIsPinching) {
    const t1 = e.touches[0], t2 = e.touches[1];
    const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    const midX = (t1.clientX + t2.clientX) / 2;
    const midY = (t1.clientY + t2.clientY) / 2;

    const newScale = Math.max(minScale, Math.min(4,
      touchPinchScale0 * (dist / touchPinchDist0)));

    if (newScale !== scale) {
      scale = newScale;
      mainCanvas.width  = Math.round(imgW * scale);
      mainCanvas.height = Math.round(imgH * scale);
      updateCanvasPadding();
      redraw();
      const areaRect = canvasArea.getBoundingClientRect();
      canvasArea.scrollLeft = canvasWrap.offsetLeft
        + touchPinchImgAnchor.x * scale - (midX - areaRect.left);
      canvasArea.scrollTop  = canvasWrap.offsetTop
        + touchPinchImgAnchor.y * scale - (midY - areaRect.top);
      updateCoordsHud(null, null);
    }
    return;
  }

  if (e.touches.length === 1 && !touchIsPinching) {
    const touch = e.touches[0];
    const cp = getCanvasPos(touch);
    mouseCanvas = cp;
    const ip = c2i(cp.x, cp.y);
    updateCoordsHud(ip.x, ip.y);
    updateZoom(cp.x, cp.y);

    if (dragTarget && dragStart) {
      const dx = cp.x - dragStart.canvasX;
      const dy = cp.y - dragStart.canvasY;
      if (dragMoved || Math.hypot(dx, dy) >= 2) {
        if (!dragMoved) { pushUndo(); dragMoved = true; }
        const idx = dx / scale, idy = dy / scale;
        const orig = dragOrigCoords, ann = dragTarget;
        if (ann.type === 'point') {
          ann.coords = [orig[0] + idx, orig[1] + idy];
        } else if (ann.type === 'line') {
          if (dragPart === 'p1')
            ann.coords = [[orig[0][0]+idx, orig[0][1]+idy], [...orig[1]]];
          else if (dragPart === 'p2')
            ann.coords = [[...orig[0]], [orig[1][0]+idx, orig[1][1]+idy]];
          else
            ann.coords = [[orig[0][0]+idx, orig[0][1]+idy],
                          [orig[1][0]+idx, orig[1][1]+idy]];
        } else if (ann.type === 'rect') {
          if (dragPart === 'p1')
            ann.coords = [[orig[0][0]+idx, orig[0][1]+idy], [...orig[1]]];
          else if (dragPart === 'p2')
            ann.coords = [[...orig[0]], [orig[1][0]+idx, orig[1][1]+idy]];
          else
            ann.coords = [[orig[0][0]+idx, orig[0][1]+idy],
                          [orig[1][0]+idx, orig[1][1]+idy]];
        }
        redraw();
      }
    }

    if (dragging || lineP1) redraw();
  }
}, { passive: false });

mainCanvas.addEventListener('touchend', e => {
  e.preventDefault();

  if (e.touches.length === 1 && touchIsPinching) {
    touchIsPinching     = false;
    touchPinchDist0     = null;
    touchPinchScale0    = null;
    touchPinchImgAnchor = null;
    return;
  }

  if (e.touches.length === 0) {
    touchIsPinching     = false;
    touchPinchDist0     = null;
    touchPinchScale0    = null;
    touchPinchImgAnchor = null;

    if (dragTarget) {
      if (dragMoved) refreshList();
      dragTarget = dragPart = dragStart = dragOrigCoords = null;
      dragMoved  = false;
    }

    if (mode === 'line' && dragging && lineP1) {
      const touch = e.changedTouches[0];
      const cp = getCanvasPos(touch);
      const ip = c2i(cp.x, cp.y);
      if (Math.hypot(ip.x - lineP1.x, ip.y - lineP1.y) > 2) {
        addAnnotation({ id: uid(), type: 'line', name: nextName('line'),
                        coords: [[lineP1.x, lineP1.y], [ip.x, ip.y]] });
      }
      lineP1   = null;
      dragging = false;
      redraw();
    }

    if (mode === 'rect' && dragging && rectP1) {
      const touch = e.changedTouches[0];
      const cp = getCanvasPos(touch);
      const ip = c2i(cp.x, cp.y);
      const x1 = Math.min(rectP1.x, ip.x), y1 = Math.min(rectP1.y, ip.y);
      const x2 = Math.max(rectP1.x, ip.x), y2 = Math.max(rectP1.y, ip.y);
      if (x2 - x1 > 2 && y2 - y1 > 2) {
        addAnnotation({ id: uid(), type: 'rect', name: nextName('rect'),
                        coords: [[x1, y1], [x2, y2]] });
      }
      rectP1   = null;
      dragging = false;
      redraw();
    }

    mouseCanvas = null;
    redraw();
  }
}, { passive: false });

mainCanvas.addEventListener('touchcancel', e => {
  e.preventDefault();
  touchIsPinching     = false;
  touchPinchDist0     = null;
  touchPinchScale0    = null;
  touchPinchImgAnchor = null;
  mouseCanvas         = null;
  if (dragTarget && !dragMoved) {
    dragTarget = dragPart = dragStart = dragOrigCoords = null;
  }
  if (dragging) { lineP1 = null; rectP1 = null; dragging = false; }
  redraw();
}, { passive: false });

// ── Main canvas render ─────────────────────────────────────────────────────
function redraw() {
  if (!sourceImage) return;
  mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
  mainCtx.drawImage(sourceImage, 0, 0, mainCanvas.width, mainCanvas.height);

  for (const ann of annotations) {
    if (!isAnnotationVisible(ann)) continue;
    const isSel = ann.id === selectedId || selectedIds.has(ann.id);
    drawAnnotation(mainCtx, ann, annotationColor(ann), showLabels, isSel);
  }

  // In-progress previews
  const mp = mouseCanvas;

  if (mode === 'line' && lineP1 && mp) {
    const p1  = i2c(lineP1.x, lineP1.y);
    const end = shiftHeld ? constrainAxis(p1, mp) : mp;
    mainCtx.save();
    mainCtx.setLineDash([5, 4]);
    mainCtx.strokeStyle = C_PREVIEW;
    mainCtx.lineWidth = 1.5;
    mainCtx.beginPath();
    mainCtx.moveTo(p1.x, p1.y);
    mainCtx.lineTo(end.x, end.y);
    mainCtx.stroke();
    mainCtx.setLineDash([]);
    paintDot(mainCtx, p1.x, p1.y, C_PREVIEW, 5);
    mainCtx.restore();
  }

  if (mode === 'rect' && dragging && rectP1 && mp) {
    const p1 = i2c(rectP1.x, rectP1.y);
    const rx = Math.min(p1.x, mp.x), ry = Math.min(p1.y, mp.y);
    const rw = Math.abs(mp.x - p1.x),  rh = Math.abs(mp.y - p1.y);
    mainCtx.save();
    mainCtx.setLineDash([5, 4]);
    mainCtx.strokeStyle = C_PREVIEW;
    mainCtx.lineWidth = 1.5;
    mainCtx.strokeRect(rx, ry, rw, rh);
    mainCtx.setLineDash([]);
    mainCtx.restore();
  }
}

// ── Drawing helpers ────────────────────────────────────────────────────────
// Returns the display color for an annotation.
// Selected: base color mixed 55% toward white (lighter pastel of the same hue).
// Unselected: first tag color, or C_NORMAL yellow if untagged.
function annotationColor(ann) {
  let base = C_NORMAL;
  if (ann.tags && ann.tags.length > 0) {
    const tag = tags.find(t => t.id === ann.tags[0]);
    if (tag) base = tag.color;
  }
  const isSelected = ann.id === selectedId || selectedIds.has(ann.id);
  return isSelected ? mixWithWhite(base, 0.55) : base;
}

function drawAnnotation(ctx, ann, color, showLabel, selected = false, labelSize = 11.5) {
  ctx.save();
  const lw = selected ? 3 : 2;
  if (ann.type === 'point') {
    const p = i2c(ann.coords[0], ann.coords[1]);
    paintDot(ctx, p.x, p.y, color, selected ? 6 : 5);
    if (showLabel) paintLabel(ctx, ann.name, p.x + 9, p.y - 6, color, labelSize);

  } else if (ann.type === 'line') {
    const p1 = i2c(ann.coords[0][0], ann.coords[0][1]);
    const p2 = i2c(ann.coords[1][0], ann.coords[1][1]);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    paintDot(ctx, p1.x, p1.y, color, selected ? 5 : 4);
    paintDot(ctx, p2.x, p2.y, color, selected ? 5 : 4);
    if (showLabel) paintLabel(ctx, ann.name, (p1.x+p2.x)/2 + 6, (p1.y+p2.y)/2 - 6, color, labelSize);

  } else if (ann.type === 'rect') {
    const p1 = i2c(ann.coords[0][0], ann.coords[0][1]);
    const p2 = i2c(ann.coords[1][0], ann.coords[1][1]);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.strokeRect(p1.x, p1.y, p2.x-p1.x, p2.y-p1.y);
    paintDot(ctx, p1.x, p1.y, color, selected ? 5 : 4);
    paintDot(ctx, p2.x, p2.y, color, selected ? 5 : 4);
    if (showLabel) paintLabel(ctx, ann.name, p1.x + 5, p1.y - 6, color, labelSize);
  }
  ctx.restore();
}

function paintDot(ctx, x, y, color, r) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function paintLabel(ctx, text, x, y, color, fontSize = 11.5) {
  ctx.save();
  ctx.font = `${fontSize}px -apple-system, system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x - 2, y - fontSize, w + 6, fontSize * 1.3);
  ctx.fillStyle = color;
  ctx.fillText(text, x + 1, y);
  ctx.restore();
}

// ── Zoom viewer ────────────────────────────────────────────────────────────
function updateZoom(cx, cy) {
  const zoomPanel = document.getElementById('zoom-panel');
  const zw = zoomPanel.clientWidth - 16;
  const zh = 148;
  zoomCanvas.width  = zw;
  zoomCanvas.height = zh;

  zoomCtx.fillStyle = '#0d1117';
  zoomCtx.fillRect(0, 0, zw, zh);

  if (!sourceImage || cx === null) return;

  // Source region in image coords
  const srcW = zw / ZOOM_FACTOR;
  const srcH = zh / ZOOM_FACTOR;
  const ix   = cx / scale - srcW / 2;
  const iy   = cy / scale - srcH / 2;

  zoomCtx.imageSmoothingEnabled = false;
  zoomCtx.drawImage(sourceImage, ix, iy, srcW, srcH, 0, 0, zw, zh);

  // Transform from image coords to zoom-canvas coords
  const z2c = (imgX, imgY) => ({
    x: (imgX - ix) * ZOOM_FACTOR,
    y: (imgY - iy) * ZOOM_FACTOR,
  });

  for (const ann of annotations) {
    if (!isAnnotationVisible(ann)) continue;
    const color = annotationColor(ann);
    const sel   = ann.id === selectedId || selectedIds.has(ann.id);
    zoomCtx.save();

    if (ann.type === 'point') {
      const p = z2c(ann.coords[0], ann.coords[1]);
      paintDot(zoomCtx, p.x, p.y, color, sel ? 5 : 4);
    } else if (ann.type === 'line') {
      const p1 = z2c(ann.coords[0][0], ann.coords[0][1]);
      const p2 = z2c(ann.coords[1][0], ann.coords[1][1]);
      zoomCtx.strokeStyle = color; zoomCtx.lineWidth = sel ? 3 : 2;
      zoomCtx.beginPath(); zoomCtx.moveTo(p1.x, p1.y); zoomCtx.lineTo(p2.x, p2.y); zoomCtx.stroke();
      paintDot(zoomCtx, p1.x, p1.y, color, sel ? 4 : 3);
      paintDot(zoomCtx, p2.x, p2.y, color, sel ? 4 : 3);
    } else if (ann.type === 'rect') {
      const p1 = z2c(ann.coords[0][0], ann.coords[0][1]);
      const p2 = z2c(ann.coords[1][0], ann.coords[1][1]);
      zoomCtx.strokeStyle = color; zoomCtx.lineWidth = sel ? 3 : 2;
      zoomCtx.strokeRect(p1.x, p1.y, p2.x-p1.x, p2.y-p1.y);
    }
    zoomCtx.restore();
  }

  // Crosshair lines
  zoomCtx.save();
  zoomCtx.strokeStyle = 'rgba(252,129,129,0.75)';
  zoomCtx.lineWidth = 1;
  zoomCtx.setLineDash([3, 3]);
  zoomCtx.beginPath();
  zoomCtx.moveTo(zw/2, 0); zoomCtx.lineTo(zw/2, zh);
  zoomCtx.moveTo(0, zh/2); zoomCtx.lineTo(zw, zh/2);
  zoomCtx.stroke();
  zoomCtx.restore();

  // Center dot
  zoomCtx.save();
  zoomCtx.beginPath();
  zoomCtx.arc(zw/2, zh/2, 4, 0, Math.PI*2);
  zoomCtx.fillStyle = '#f87171';
  zoomCtx.fill();
  zoomCtx.strokeStyle = 'rgba(0,0,0,0.6)';
  zoomCtx.lineWidth = 1.5;
  zoomCtx.stroke();
  zoomCtx.restore();
}

// ── Annotation list ────────────────────────────────────────────────────────
const TYPE_ICONS = {
  point: `<svg class="ann-type-icon" viewBox="0 0 24 24" fill="#94a3b8" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="6"/></svg>`,
  line: `<svg class="ann-type-icon" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.5"
    stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><line x1="4" y1="20" x2="20" y2="4"/></svg>`,
  rect: `<svg class="ann-type-icon" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"
    xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="14" rx="1.5"/></svg>`,
};

function getTagDots(annTagIds) {
  if (!annTagIds || annTagIds.length === 0) return '';
  const dots = annTagIds
    .map(id => tags.find(t => t.id === id))
    .filter(Boolean)
    .map(t => `<span class="ann-tag-dot" style="background:${sanitizeHexColor(t.color)}" title="${esc(t.name)}"></span>`)
    .join('');
  return dots ? `<span class="ann-tag-dots">${dots}</span>` : '';
}

function refreshList() {
  document.getElementById('ann-count').textContent = annotations.length;
  annList.innerHTML = '';

  for (const ann of annotations) {
    const isExpanded = ann.id === expandedAnnotationId;
    const item = document.createElement('div');
    item.className = 'ann-item'
      + (selectedIds.has(ann.id) ? ' selected' : '')
      + (!isAnnotationVisible(ann) ? ' ann-hidden' : '');
    item.dataset.id = ann.id;
    item.innerHTML = `
      ${TYPE_ICONS[ann.type] || ''}
      <input class="ann-name-input" type="text" value="${esc(ann.name)}"
        data-id="${ann.id}" spellcheck="false">
      ${getTagDots(ann.tags)}
      <button class="tag-edit-btn${isExpanded ? ' active' : ''}" title="Edit tags">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
          <line x1="7" y1="7" x2="7.01" y2="7"/>
        </svg>
      </button>
      <button class="ann-del-btn" data-id="${ann.id}" title="Delete">×</button>
    `;

    // Expanded tag editor
    if (isExpanded) {
      const editor = document.createElement('div');
      editor.className = 'ann-tag-editor';
      const annTagSet = new Set(ann.tags || []);

      if (tags.length === 0) {
        const msg = document.createElement('span');
        msg.style.cssText = 'font-size:11.5px;color:var(--text-dim)';
        msg.textContent = 'No tags defined';
        editor.appendChild(msg);
      } else {
        for (const tag of tags) {
          const chip = document.createElement('span');
          chip.className = 'tag-editor-chip' + (annTagSet.has(tag.id) ? ' has-tag' : '');
          chip.innerHTML = `<span class="tag-editor-dot" style="background:${sanitizeHexColor(tag.color)}"></span>${esc(tag.name)}`;
          chip.addEventListener('mousedown', e => e.stopPropagation());
          chip.addEventListener('click', e => {
            e.stopPropagation();
            pushUndo();
            if (!ann.tags) ann.tags = [];
            if (annTagSet.has(tag.id)) {
              ann.tags = ann.tags.filter(id => id !== tag.id);
            } else {
              ann.tags.push(tag.id);
            }
            refreshList();
            redraw();
          });
          editor.appendChild(chip);
        }
      }

      const doneBtn = document.createElement('button');
      doneBtn.className = 'tag-editor-done';
      doneBtn.textContent = 'Done';
      doneBtn.addEventListener('mousedown', e => e.stopPropagation());
      doneBtn.addEventListener('click', e => {
        e.stopPropagation();
        expandedAnnotationId = null;
        refreshList();
      });
      editor.appendChild(doneBtn);
      item.appendChild(editor);
    }

    item.addEventListener('mousedown', e => {
      if (e.target.classList.contains('ann-del-btn')) return;
      if (e.target.closest('.ann-tag-editor')) return;
      if (e.target.closest('.tag-edit-btn')) return;
      if (!e.target.classList.contains('ann-name-input')) {
        selectAnnotation(ann.id);
      }
    });

    item.querySelector('.tag-edit-btn').addEventListener('click', e => {
      e.stopPropagation();
      expandedAnnotationId = expandedAnnotationId === ann.id ? null : ann.id;
      refreshList();
    });

    const inp = item.querySelector('.ann-name-input');
    inp.addEventListener('focus', e => {
      selectAnnotation(ann.id);
      setTimeout(() => e.target.select(), 0); // deferred so Safari's mouseup doesn't clear the selection
    });
    inp.addEventListener('change', e => {
      const a = annotations.find(x => x.id === e.target.dataset.id);
      if (a) { pushUndo(); a.name = e.target.value || a.name; redraw(); }
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.target.blur(); }
      e.stopPropagation(); // prevent global key handler
    });

    item.querySelector('.ann-del-btn').addEventListener('click', e => {
      e.stopPropagation();
      deleteAnnotation(e.currentTarget.dataset.id);
    });

    annList.appendChild(item);
  }
}

// ── Clear all ──────────────────────────────────────────────────────────────
function clearAnnotations() {
  if (annotations.length === 0) return;
  if (!confirm(`Remove all ${annotations.length} annotation${annotations.length > 1 ? 's' : ''}?`)) return;
  pushUndo();
  annotations  = [];
  selectedId   = null;
  selectedIds  = new Set();
  expandedAnnotationId = null;
  refreshList();
  redraw();
}

// ── Tags ───────────────────────────────────────────────────────────────────
function refreshTagsList() {
  // Build annotation count per tag
  const countMap = {};
  for (const tag of tags) countMap[tag.id] = 0;
  for (const ann of annotations)
    for (const tid of (ann.tags || []))
      if (tid in countMap) countMap[tid]++;

  tagsList.innerHTML = '';
  for (const tag of tags) {
    const isHidden = hiddenTagIds.has(tag.id);
    const item = document.createElement('div');
    item.className = 'tag-item' + (activeTags.has(tag.id) ? ' active' : '');
    item.dataset.id = tag.id;
    item.innerHTML = `
      <button class="tag-dot tag-dot-btn" style="background:${sanitizeHexColor(tag.color)}" title="Change color"></button>
      <span class="tag-name">${esc(tag.name)}</span>
      ${countMap[tag.id] > 0 ? `<span class="tag-count">${countMap[tag.id]}</span>` : ''}
      <button class="tag-eye-btn${isHidden ? ' hidden-tag' : ''}" title="Toggle visibility">
        ${isHidden
          ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
          : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`}
      </button>
      <button class="tag-del-btn" title="Delete tag">×</button>
    `;
    item.addEventListener('click', e => {
      if (e.target.closest('.tag-del-btn')) return;
      if (e.target.closest('.tag-eye-btn')) return;
      if (e.target.closest('.tag-dot-btn')) return;
      const ids = tags.map(t => t.id);
      if (e.shiftKey && tagAnchorId) {
        // Range: select from anchor to here, replacing current selection
        const a = ids.indexOf(tagAnchorId), b = ids.indexOf(tag.id);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        activeTags = new Set(ids.slice(lo, hi + 1));
        // anchor stays the same
      } else if (e.metaKey || e.ctrlKey) {
        // Toggle this tag, update anchor
        if (activeTags.has(tag.id)) activeTags.delete(tag.id);
        else activeTags.add(tag.id);
        tagAnchorId = tag.id;
      } else {
        // Plain click: select only this tag
        activeTags  = new Set([tag.id]);
        tagAnchorId = tag.id;
      }
      refreshTagsList();
    });
    item.querySelector('.tag-eye-btn').addEventListener('click', e => {
      e.stopPropagation();
      if (hiddenTagIds.has(tag.id)) hiddenTagIds.delete(tag.id);
      else hiddenTagIds.add(tag.id);
      refreshTagsList(); refreshList(); redraw();
    });
    item.querySelector('.tag-dot-btn').addEventListener('click', e => {
      e.stopPropagation();
      openColorPicker(tag, e.currentTarget);
    });
    item.querySelector('.tag-del-btn').addEventListener('click', e => {
      e.stopPropagation();
      deleteTag(tag.id);
    });
    tagsList.appendChild(item);
  }
}


function deleteTag(id) {
  pushUndo();
  tags = tags.filter(t => t.id !== id);
  activeTags.delete(id);
  hiddenTagIds.delete(id);
  if (tagAnchorId === id) tagAnchorId = null;
  for (const ann of annotations) {
    if (ann.tags) ann.tags = ann.tags.filter(tid => tid !== id);
  }
  refreshTagsList();
  refreshList();
}

/** Open the color picker popover anchored to the given element. */
function openColorPicker(tag, anchorEl) {
  closeColorPicker();
  const popover = document.createElement('div');
  popover.className = 'color-picker-popover';
  popover.innerHTML = `
    <div class="color-swatches">
      ${TAG_COLORS.map(c => `<button class="color-swatch${sanitizeHexColor(tag.color) === c ? ' active' : ''}"
        style="background:${c}" data-color="${c}" title="${c}"></button>`).join('')}
    </div>
    <div class="color-custom-row">
      <input type="color" class="color-native-input" value="${sanitizeHexColor(tag.color)}" title="Custom color">
      <span class="color-custom-label">Custom</span>
    </div>
  `;
  document.body.appendChild(popover);
  colorPickerPopover = popover;

  // Position near the anchor element
  const rect = anchorEl.getBoundingClientRect();
  popover.style.position = 'fixed';
  popover.style.top  = `${rect.bottom + 6}px`;
  popover.style.left = `${rect.left}px`;
  // Clamp to viewport on next frame (needs layout)
  requestAnimationFrame(() => {
    const pw = popover.offsetWidth;
    const maxLeft = window.innerWidth - pw - 8;
    if (popover.offsetLeft > maxLeft) popover.style.left = `${maxLeft}px`;
  });

  const applyColor = color => {
    pushUndo();
    tag.color = sanitizeHexColor(color, tag.color);
    refreshTagsList(); refreshList(); redraw();
    closeColorPicker();
  };

  popover.querySelectorAll('.color-swatch').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); applyColor(btn.dataset.color); });
  });
  popover.querySelector('.color-native-input').addEventListener('change', e => {
    e.stopPropagation(); applyColor(e.target.value);
  });
  popover.addEventListener('click', e => e.stopPropagation());
}

/** Close and remove the color picker popover. */
function closeColorPicker() {
  if (colorPickerPopover) { colorPickerPopover.remove(); colorPickerPopover = null; }
}

function startAddTag() {
  if (tagsList.querySelector('.tag-new-input')) return; // already adding
  const color   = TAG_COLORS[tags.length % TAG_COLORS.length];
  const wrapper = document.createElement('div');
  wrapper.className = 'tag-item';
  wrapper.innerHTML = `<span class="tag-dot" style="background:${sanitizeHexColor(color)}"></span>`;
  const inp = document.createElement('input');
  inp.type        = 'text';
  inp.className   = 'tag-new-input';
  inp.placeholder = 'Tag name…';
  inp.spellcheck  = false;
  wrapper.appendChild(inp);
  tagsList.appendChild(wrapper);
  inp.focus();

  const confirm = () => {
    const name = inp.value.trim();
    wrapper.remove();
    if (!name) return;
    pushUndo();
    const newTag = { id: uid(), name, color };
    tags.push(newTag);
    activeTags  = new Set([newTag.id]);
    tagAnchorId = newTag.id;
    refreshTagsList();
  };
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); confirm(); }
    if (e.key === 'Escape') { wrapper.remove(); }
    e.stopPropagation();
  });
  inp.addEventListener('blur', confirm);
}

// ── JSON export / import ───────────────────────────────────────────────────
function downloadJSON() {
  const payload = {
    metadata: {
      image:    imageFileName,
      exported: new Date().toISOString(),
    },
    tags: tags.map(t => ({ name: t.name, color: t.color })),
    annotations: annotations.map(a => ({
      type:   a.type,
      name:   a.name,
      coords: a.coords,
      tags:   (a.tags || []).map(id => tags.find(t => t.id === id)?.name).filter(Boolean),
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${imageBaseName}_annotations.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Export the image with annotations drawn at full (original) resolution. */
function downloadAnnotatedImage() {
  if (!sourceImage) return;
  const offCanvas = document.createElement('canvas');
  offCanvas.width  = imgW;
  offCanvas.height = imgH;
  const offCtx = offCanvas.getContext('2d');
  offCtx.drawImage(sourceImage, 0, 0, imgW, imgH);
  // Temporarily set scale=1 so i2c() becomes identity (image coords = canvas coords)
  // Font size proportional to image width so labels are readable at full resolution
  const labelSize = Math.max(16, Math.round(imgW / 80));
  const savedScale = scale;
  try {
    scale = 1;
    for (const ann of annotations) {
      if (!isAnnotationVisible(ann)) continue;
      const isSel = ann.id === selectedId || selectedIds.has(ann.id);
      drawAnnotation(offCtx, ann, annotationColor(ann), showLabels, isSel, labelSize);
    }
  } finally { scale = savedScale; }
  offCanvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${imageBaseName}_annotated.png`;
    a.click(); URL.revokeObjectURL(url);
  }, 'image/png');
}

function importJSONFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      pushUndo();
      // Restore tags
      tags = (data.tags || []).map(t => ({
        id: uid(),
        name: t.name,
        color: sanitizeHexColor(t.color, TAG_COLORS[0]),
      }));
      activeTags.clear();
      // Restore annotations, mapping tag names back to new IDs
      const list = data.annotations || (Array.isArray(data) ? data : []);
      annotations = list.map(a => ({
        id: uid(), type: a.type, name: a.name, coords: a.coords,
        tags: (a.tags || []).map(name => tags.find(t => t.name === name)?.id).filter(Boolean),
      }));
      // Sync name counters so new annotations don't collide
      const prefixMap = { point: 'point', line: 'line', rect: 'rect', rectangle: 'rect' };
      for (const a of annotations) {
        const m = a.name.match(/^([A-Za-z]+?)(\d+)$/);
        if (m) {
          const key = prefixMap[m[1].toLowerCase()];
          if (key) counters[key] = Math.max(counters[key] || 0, parseInt(m[2], 10));
        }
      }
      refreshTagsList();
      refreshList();
      redraw();
    } catch (err) {
      alert('Failed to parse JSON:\n' + err.message);
    }
  };
  reader.readAsText(file);
}

// ── File input wiring ──────────────────────────────────────────────────────
document.getElementById('file-input').addEventListener('change', function() {
  openImage(this.files[0]);
  this.value = '';
});

document.getElementById('json-input').addEventListener('change', function() {
  importJSONFile(this.files[0]);
  this.value = '';
});

// ── Drag & drop ────────────────────────────────────────────────────────────
canvasArea.addEventListener('dragover', e => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  dropZone.classList.add('drag-over');
});
canvasArea.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
canvasArea.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) {
    if (file.type.startsWith('image/')) openImage(file);
    else if (file.name.endsWith('.json')) importJSONFile(file);
  }
});

// ── Shift / Space key tracking ─────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Shift' && lineP1) { shiftHeld = true; redraw(); }
  if (e.key === ' ' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault(); // prevent page scroll
    if (!spaceHeld) { spaceHeld = true; if (sourceImage) mainCanvas.style.cursor = 'grab'; }
  }
});
document.addEventListener('keyup', e => {
  if (e.key === 'Shift' && lineP1) { shiftHeld = false; redraw(); }
  if (e.key === ' ') {
    spaceHeld = false;
    if (!isPanning) mainCanvas.style.cursor = mode === 'select' ? 'default' : 'crosshair';
  }
});

// ── Keyboard shortcuts ─────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const k = e.key.toLowerCase();
  if (k === 's') { setMode('select'); return; }
  if (k === 'p') { setMode('point');  return; }
  if (k === 'l') { setMode('line');   return; }
  if (k === 'r') { setMode('rect');   return; }
  if (k === 'f') { fitToView(); return; }
  if (k === 'm') { showLabels = !showLabels; redraw(); return; }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && k === 'z') { e.preventDefault(); undo(); return; }
  if ((e.metaKey || e.ctrlKey) && (k === 'y' || (e.shiftKey && k === 'z'))) {
    e.preventDefault(); redo(); return;
  }
  if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    const r = canvasArea.getBoundingClientRect();
    zoomBy(1.25, r.left + r.width / 2, r.top + r.height / 2); return;
  }
  if (e.key === '-') {
    e.preventDefault();
    const r = canvasArea.getBoundingClientRect();
    zoomBy(1 / 1.25, r.left + r.width / 2, r.top + r.height / 2); return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    if (annotations.length === 0) return;
    const idx  = annotations.findIndex(a => a.id === selectedId);
    const next = e.shiftKey
      ? (idx <= 0 ? annotations.length - 1 : idx - 1)
      : (idx >= annotations.length - 1 ? 0 : idx + 1);
    selectAnnotation(annotations[next].id);
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
    pushUndo();
    const toDelete = new Set(selectedIds);
    annotations = annotations.filter(a => !toDelete.has(a.id));
    if (toDelete.has(expandedAnnotationId)) expandedAnnotationId = null;
    selectedId  = null;
    selectedIds = new Set();
    refreshList(); redraw(); return;
  }
  if (e.key === 'Escape') {
    if (lineP1 || dragging) {
      lineP1 = null; rectP1 = null; dragging = false;
      redraw();
    } else if (selectedId || selectedIds.size > 0) {
      selectAnnotation(null);
    } else {
      setMode('select');
    }
  }
});

// ── Window resize ──────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  if (sourceImage) { fitCanvas(); redraw(); updateCoordsHud(null, null); }
});

// ── Theme ──────────────────────────────────────────────────────────────────
function toggleTheme() {
  document.body.classList.toggle('light');
}

// ── Tools ──────────────────────────────────────────────────────────────────
const TOOL_CONFIGS = {
  extract: {
    title: 'Extract',
    desc:  'Projects point annotations onto axes defined by line annotations. ' +
           'Name axis lines as "X: 0 100" (start value, end value) or "Y: 1e-3 1 L" (log scale). ' +
           'Points are projected onto every axis; tag filter limits which points are included.',
    run:   runExtract,
  },
  measure: {
    title: 'Measure',
    desc:  'Measures line lengths using a pixel scale. Name one line annotation as ' +
           '"scale: 100" to indicate it spans 100 units. ' +
           'Tag filter limits which other lines are measured (scale lines are always used as reference).',
    run:   runMeasure,
  },
  profile: {
    title: 'Profile',
    desc:  'Samples pixel intensity along each line annotation. ' +
           'Outputs position, coordinates, R/G/B, and luminance for each sample point. ' +
           'Tag filter limits which lines are profiled.',
    run:   runProfile,
  },
  angle: {
    title: 'Angle',
    desc:  'Measures orientation of line annotations in degrees (0–180°, where 0° is horizontal). ' +
           'Subtract two values to get the inter-line angle. ' +
           'Tag filter limits which lines are included.',
    run:   runAngle,
  },
  distances: {
    title: 'Distances',
    desc:  'Measures pairwise pixel distances between all point annotations, ' +
           'with optional conversion to physical units. ' +
           'Name a line as "scale: 100" to define a scale. ' +
           'Tag filter limits which points are measured.',
    run:   runDistances,
  },
  area: {
    title: 'Area',
    desc:  'Measures width, height, aspect ratio, and area of rectangle annotations, ' +
           'with optional conversion to physical units. ' +
           'Name a line as "scale: 100" to define a scale. ' +
           'Tag filter limits which rectangles are measured.',
    run:   runArea,
  },
};

let currentTool = null;

function toggleToolsMenu(e) {
  e.stopPropagation();
  const btn      = document.getElementById('btn-tools');
  const dropdown = document.getElementById('tools-dropdown');
  const isOpen   = dropdown.classList.contains('open');
  closeToolsMenu();
  if (!isOpen) {
    btn.classList.add('open');
    dropdown.classList.add('open');
  }
}

function closeToolsMenu() {
  document.getElementById('btn-tools').classList.remove('open');
  document.getElementById('tools-dropdown').classList.remove('open');
}

function toggleFileMenu(e) {
  e.stopPropagation();
  const btn      = document.getElementById('btn-file');
  const dropdown = document.getElementById('file-dropdown');
  const isOpen   = dropdown.classList.contains('open');
  closeFileMenu();
  if (!isOpen) {
    btn.classList.add('open');
    dropdown.classList.add('open');
  }
}

function closeFileMenu() {
  document.getElementById('btn-file').classList.remove('open');
  document.getElementById('file-dropdown').classList.remove('open');
}

document.addEventListener('click', () => { closeToolsMenu(); closeFileMenu(); closeColorPicker(); });

function openToolDialog(toolName) {
  closeToolsMenu();
  currentTool = toolName;
  const cfg = TOOL_CONFIGS[toolName];
  document.getElementById('modal-title').textContent = cfg.title;
  document.getElementById('modal-desc').textContent  = cfg.desc;

  // Populate tag selector with current tags
  const sel = document.getElementById('modal-tag-select');
  sel.innerHTML = '<option value="">All tags</option>';
  for (const tag of tags) {
    const opt       = document.createElement('option');
    opt.value       = tag.id;
    opt.textContent = tag.name;
    sel.appendChild(opt);
  }

  document.getElementById('tool-modal').classList.add('open');
}

function closeToolDialog() {
  document.getElementById('tool-modal').classList.remove('open');
  currentTool = null;
}

// Close modal on overlay click
document.getElementById('tool-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('tool-modal')) closeToolDialog();
});

// Escape closes modal/dropdown before the global shortcut handler sees it
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('tool-modal').classList.contains('open')) {
    e.stopImmediatePropagation();
    closeToolDialog();
    return;
  }
  if (document.getElementById('tools-dropdown').classList.contains('open')) {
    e.stopImmediatePropagation();
    closeToolsMenu();
    return;
  }
  if (document.getElementById('file-dropdown').classList.contains('open')) {
    e.stopImmediatePropagation();
    closeFileMenu();
  }
}, true); // capture phase – fires before other keydown listeners

function runCurrentTool() {
  if (!currentTool) return;
  const tagId  = document.getElementById('modal-tag-select').value;
  const result = TOOL_CONFIGS[currentTool].run(tagId);
  if (result.error) { alert(result.error); return; }
  downloadCSV(result.csv, result.filename);
  closeToolDialog();
}

function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvSanitize(s) {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── Extract (plot digitizer) ────────────────────────────────────────────────
// Replicates extract.py logic in-browser.
// Axis lines: named "NAME: val1 val2 [L]"  (L = log scale)
// Point annotations are projected onto every axis via dot-product.
function runExtract(tagId) {
  const axisRe = /^(\w+):\s*([\d.efg+\-]+)\s+([\d.efg+\-]+)\s*(L?)\s*/i;
  const axes   = [];

  for (const ann of annotations) {
    if (ann.type !== 'line') continue;
    const m = ann.name.match(axisRe);
    if (!m) continue;
    const rawA  = parseFloat(m[2]);
    const rawB  = parseFloat(m[3]);
    const islog = m[4].toUpperCase() === 'L';
    const r0    = ann.coords[0];
    const r1    = ann.coords[1];
    const dx    = r1[0] - r0[0], dy = r1[1] - r0[1];
    const l2    = dx * dx + dy * dy;
    if (l2 === 0) continue;
    axes.push({
      name:  m[1],
      r0,
      delta: [dx, dy],
      l2,
      a:     islog ? Math.log(rawA) : rawA,
      b:     islog ? Math.log(rawB) : rawB,
      islog,
    });
  }

  if (axes.length === 0) {
    return { error: 'No axes found.\nName line annotations as "X: 0 100" or "Y: 1e-3 1e3 L" to define axes.' };
  }

  const col = {};
  for (const ax of axes) col[ax.name] = [];
  const names = [];
  let count = 0;

  for (const ann of annotations) {
    if (ann.type !== 'point') continue;
    if (tagId && !annotationHasTag(ann, tagId)) continue;
    const c = ann.coords;
    for (const ax of axes) {
      let v = ax.a + (ax.b - ax.a) *
        ((c[0] - ax.r0[0]) * ax.delta[0] + (c[1] - ax.r0[1]) * ax.delta[1]) / ax.l2;
      if (ax.islog) v = Math.exp(v);
      col[ax.name].push(v);
    }
    names.push(ann.name);
    count++;
  }

  if (count === 0) {
    return { error: 'No points found' + (tagId ? ' with the selected tag.' : '.') };
  }

  const keys = Object.keys(col).sort();
  let csv = ['name', ...keys.map(csvSanitize)].join(',') + '\n';
  const n = col[keys[0]].length;
  for (let i = 0; i < n; i++) {
    csv += [csvSanitize(names[i]), ...keys.map(k => col[k][i])].join(',') + '\n';
  }
  return { csv, filename: `${imageBaseName}_extract.csv` };
}

// ── Measure (length measurement) ───────────────────────────────────────────
// Replicates measure.py logic in-browser.
// Scale lines: named "NAME: length"
// All line annotations (filtered by tag) are measured against every scale.
function runMeasure(tagId) {
  const scaleRe = /^(\w+):\s*([\d.efg+\-]+)\s*$/i;
  const scales  = [];

  for (const ann of annotations) {
    if (ann.type !== 'line') continue;
    const m = ann.name.match(scaleRe);
    if (!m) continue;
    const r0    = ann.coords[0];
    const r1    = ann.coords[1];
    const dx    = r1[0] - r0[0], dy = r1[1] - r0[1];
    const pxlen = Math.sqrt(dx * dx + dy * dy);
    if (pxlen === 0) continue;
    scales.push({ name: m[1], unitperpx: parseFloat(m[2]) / pxlen });
  }

  if (scales.length === 0) {
    return { error: 'No scale found.\nName a line annotation as "scale: 100" to define a scale of 100 units.' };
  }

  const col   = {};
  const names = [];
  for (const sc of scales) col[sc.name] = [];

  for (const ann of annotations) {
    if (ann.type !== 'line') continue;
    if (tagId && !annotationHasTag(ann, tagId)) continue;
    const c   = ann.coords;
    const dx  = c[1][0] - c[0][0], dy = c[1][1] - c[0][1];
    const pxl = Math.sqrt(dx * dx + dy * dy);
    names.push(ann.name);
    for (const sc of scales) col[sc.name].push(pxl * sc.unitperpx);
  }

  if (names.length === 0) {
    return { error: 'No lines found' + (tagId ? ' with the selected tag.' : '.') };
  }

  const keys = Object.keys(col).sort();
  let csv = 'name,' + keys.map(csvSanitize).join(',') + '\n';
  for (let i = 0; i < names.length; i++) {
    csv += csvSanitize(names[i]) + ',' + keys.map(k => col[k][i]).join(',') + '\n';
  }
  return { csv, filename: `${imageBaseName}_measure.csv` };
}

// ── Profile (intensity along a line) ───────────────────────────────────────
// Samples pixel RGB/luminance at evenly-spaced points along each line annotation.
function runProfile(tagId) {
  if (!sourceImage) return { error: 'No image loaded.' };

  const lines = annotations.filter(ann => {
    if (ann.type !== 'line') return false;
    if (tagId && !annotationHasTag(ann, tagId)) return false;
    return true;
  });

  if (lines.length === 0) {
    return { error: 'No lines found' + (tagId ? ' with the selected tag.' : '.') };
  }

  // Render source image at natural resolution into an offscreen canvas
  const offscreen = document.createElement('canvas');
  offscreen.width  = imgW;
  offscreen.height = imgH;
  const offCtx = offscreen.getContext('2d');
  offCtx.drawImage(sourceImage, 0, 0, imgW, imgH);

  let imageData;
  try {
    imageData = offCtx.getImageData(0, 0, imgW, imgH);
  } catch (err) {
    return { error: 'Cannot read pixel data: image may be cross-origin tainted.\n' + err.message };
  }

  const data = imageData.data;
  function sampleAt(x, y) {
    const xi  = Math.round(Math.max(0, Math.min(imgW - 1, x)));
    const yi  = Math.round(Math.max(0, Math.min(imgH - 1, y)));
    const idx = (yi * imgW + xi) * 4;
    return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
  }

  // Collect any defined scales (optional — pixel columns are always output)
  const scaleRe = /^(\w+):\s*([\d.efg+\-]+)\s*$/i;
  const scales  = [];
  for (const ann of annotations) {
    if (ann.type !== 'line') continue;
    const m = ann.name.match(scaleRe);
    if (!m) continue;
    const dx    = ann.coords[1][0] - ann.coords[0][0];
    const dy    = ann.coords[1][1] - ann.coords[0][1];
    const pxlen = Math.sqrt(dx * dx + dy * dy);
    if (pxlen === 0) continue;
    scales.push({ name: m[1], unitperpx: parseFloat(m[2]) / pxlen });
  }
  const scaleKeys  = scales.map(sc => sc.name).sort();
  const scaleMap   = Object.fromEntries(scales.map(sc => [sc.name, sc.unitperpx]));
  const scaleCols  = scaleKeys.flatMap(k => [`position_${k}`, `x_${k}`, `y_${k}`]);

  let csv = 'name,position_px,x_px,y_px' +
    (scaleCols.length ? ',' + scaleCols.map(csvSanitize).join(',') : '') +
    ',r,g,b,luminance\n';

  for (const ann of lines) {
    const [x1, y1] = ann.coords[0];
    const [x2, y2] = ann.coords[1];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    const nSamples = Math.max(1, Math.min(10000, Math.ceil(len)));
    for (let i = 0; i <= nSamples; i++) {
      const t   = i / nSamples;
      const x   = x1 + t * dx;
      const y   = y1 + t * dy;
      const pos = t * len;
      const { r, g, b } = sampleAt(x, y);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const scalePart = scaleKeys.length
        ? ',' + scaleKeys.flatMap(k => {
            const u = scaleMap[k];
            return [(pos * u).toFixed(6), (x * u).toFixed(6), (y * u).toFixed(6)];
          }).join(',')
        : '';
      csv += `${csvSanitize(ann.name)},${pos.toFixed(3)},${x.toFixed(3)},${y.toFixed(3)}${scalePart},${r},${g},${b},${lum.toFixed(3)}\n`;
    }
  }
  return { csv, filename: `${imageBaseName}_profile.csv` };
}

// ── Angle (line orientation) ────────────────────────────────────────────────
// Reports orientation in [0, 180) degrees (y-axis flipped to match standard math).
// Subtract two values to get the inter-line angle.
function runAngle(tagId) {
  const lines = annotations.filter(ann => {
    if (ann.type !== 'line') return false;
    if (tagId && !annotationHasTag(ann, tagId)) return false;
    return true;
  });

  if (lines.length === 0) {
    return { error: 'No lines found' + (tagId ? ' with the selected tag.' : '.') };
  }

  let csv = 'name,angle_deg\n';
  for (const ann of lines) {
    const dx = ann.coords[1][0] - ann.coords[0][0];
    const dy = ann.coords[1][1] - ann.coords[0][1];
    // Negate dy: image y increases downward, math y increases upward
    let angle = Math.atan2(-dy, dx) * 180 / Math.PI;
    // Normalise to [0, 180) — lines are undirected
    if (angle < 0)    angle += 180;
    if (angle >= 180) angle -= 180;
    csv += `${csvSanitize(ann.name)},${angle.toFixed(4)}\n`;
  }
  return { csv, filename: `${imageBaseName}_angle.csv` };
}

// ── Distances (pairwise point distances) ────────────────────────────────────
// Scale lines: named "NAME: length" — same convention as Measure.
function runDistances(tagId) {
  const scaleRe = /^(\w+):\s*([\d.efg+\-]+)\s*$/i;
  const scales  = [];

  for (const ann of annotations) {
    if (ann.type !== 'line') continue;
    const m = ann.name.match(scaleRe);
    if (!m) continue;
    const dx    = ann.coords[1][0] - ann.coords[0][0];
    const dy    = ann.coords[1][1] - ann.coords[0][1];
    const pxlen = Math.sqrt(dx * dx + dy * dy);
    if (pxlen === 0) continue;
    scales.push({ name: m[1], unitperpx: parseFloat(m[2]) / pxlen });
  }

  if (scales.length === 0) {
    return { error: 'No scale found.\nName a line annotation as "scale: 100" to define a scale of 100 units.' };
  }

  const points = annotations.filter(ann => {
    if (ann.type !== 'point') return false;
    if (tagId && !annotationHasTag(ann, tagId)) return false;
    return true;
  });

  if (points.length < 2) {
    return { error: 'Need at least 2 points' + (tagId ? ' with the selected tag.' : '.') };
  }

  const keys     = scales.map(sc => sc.name).sort();
  const scaleMap = Object.fromEntries(scales.map(sc => [sc.name, sc.unitperpx]));

  let csv = 'from,to,' + keys.map(k => csvSanitize(`dist_${k}`)).join(',') + '\n';
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const pi = points[i], pj = points[j];
      const dx = pj.coords[0] - pi.coords[0];
      const dy = pj.coords[1] - pi.coords[1];
      const pxDist = Math.sqrt(dx * dx + dy * dy);
      const row = keys.map(k => (pxDist * scaleMap[k]).toFixed(6)).join(',');
      csv += `${csvSanitize(pi.name)},${csvSanitize(pj.name)},${row}\n`;
    }
  }
  return { csv, filename: `${imageBaseName}_distances.csv` };
}

// ── Area (rectangle dimensions) ─────────────────────────────────────────────
// Scale lines: named "NAME: length" — same convention as Measure.
function runArea(tagId) {
  const scaleRe = /^(\w+):\s*([\d.efg+\-]+)\s*$/i;
  const scales  = [];

  for (const ann of annotations) {
    if (ann.type !== 'line') continue;
    const m = ann.name.match(scaleRe);
    if (!m) continue;
    const dx    = ann.coords[1][0] - ann.coords[0][0];
    const dy    = ann.coords[1][1] - ann.coords[0][1];
    const pxlen = Math.sqrt(dx * dx + dy * dy);
    if (pxlen === 0) continue;
    scales.push({ name: m[1], unitperpx: parseFloat(m[2]) / pxlen });
  }

  if (scales.length === 0) {
    return { error: 'No scale found.\nName a line annotation as "scale: 100" to define a scale of 100 units.' };
  }

  const rects = annotations.filter(ann => {
    if (ann.type !== 'rect') return false;
    if (tagId && !annotationHasTag(ann, tagId)) return false;
    return true;
  });

  if (rects.length === 0) {
    return { error: 'No rectangles found' + (tagId ? ' with the selected tag.' : '.') };
  }

  const keys     = scales.map(sc => sc.name).sort();
  const scaleMap = Object.fromEntries(scales.map(sc => [sc.name, sc.unitperpx]));

  const scaleCols = keys.flatMap(k => [`width_${k}`, `height_${k}`, `area_${k}`]);
  let csv = 'name,width_px,height_px,aspect_ratio,' + scaleCols.map(csvSanitize).join(',') + '\n';

  for (const ann of rects) {
    const wPx   = Math.abs(ann.coords[1][0] - ann.coords[0][0]);
    const hPx   = Math.abs(ann.coords[1][1] - ann.coords[0][1]);
    const aspect = hPx === 0 ? 0 : wPx / hPx;
    const scalePart = keys.flatMap(k => {
      const u = scaleMap[k];
      return [(wPx * u).toFixed(6), (hPx * u).toFixed(6), (wPx * hPx * u * u).toFixed(6)];
    }).join(',');
    csv += `${csvSanitize(ann.name)},${wPx.toFixed(3)},${hPx.toFixed(3)},${aspect.toFixed(6)},${scalePart}\n`;
  }
  return { csv, filename: `${imageBaseName}_area.csv` };
}

// ── Init ───────────────────────────────────────────────────────────────────
setMode('select');
refreshTagsList();
refreshList();
