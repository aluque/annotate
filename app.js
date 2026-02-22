'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const C_NORMAL   = '#f6e05e';   // yellow – default annotation color
const C_SELECTED = '#ffffff';   // white  – selected annotation
const C_PREVIEW  = '#68d391';   // green  – in-progress drawing
const ZOOM_FACTOR = 4;
const HIT_RADIUS  = 8;          // canvas px

// ── State ──────────────────────────────────────────────────────────────────
let annotations  = [];
let selectedId   = null;
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

let mouseCanvas = null;         // {x,y} in canvas coords, or null
let shiftHeld   = false;

// Panning state
let isPanning = false;
let panStart  = null;           // {mouseX, mouseY, scrollLeft, scrollTop}

// Name counters
const counters = { point: 0, line: 0, rect: 0 };

// ── Tags state ─────────────────────────────────────────────────────────────
const TAG_COLORS = [
  '#f87171', '#fb923c', '#facc15', '#4ade80',
  '#34d399', '#60a5fa', '#a78bfa', '#f472b6',
];
let tags               = [];   // [{id, name, color}]
let activeTags         = new Set(); // IDs of tags applied to the next new annotation
let tagAnchorId        = null;     // anchor for shift-click range selection
let expandedAnnotationId = null;   // annotation whose tag editor is open

// Undo stack
const undoStack = [];
const UNDO_LIMIT = 50;

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

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
}

function undo() {
  if (undoStack.length === 0) return;
  const state = undoStack.pop();
  annotations          = state.annotations;
  tags                 = state.tags;
  counters.point       = state.counters.point;
  counters.line        = state.counters.line;
  counters.rect        = state.counters.rect;
  selectedId           = null;
  expandedAnnotationId = null;
  // Drop any activeTags that no longer exist
  const tagIds = new Set(tags.map(t => t.id));
  for (const id of activeTags) if (!tagIds.has(id)) activeTags.delete(id);
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

// Update the coordinate / zoom HUD.  Call with (ix, iy) when the mouse is
// over the canvas, or (null, null) to show only the zoom level.
function updateCoordsHud(ix, iy) {
  if (!sourceImage) { coordsHud.textContent = '—'; return; }
  const z = `${Math.round(scale * 100)}%`;
  coordsHud.textContent = ix != null
    ? `x: ${ix.toFixed(2)}   y: ${iy.toFixed(2)}   ·   ${z}`
    : z;
}

// ── Annotation CRUD ────────────────────────────────────────────────────────
function addAnnotation(ann) {
  pushUndo();
  ann.tags = [...activeTags];
  annotations.push(ann);
  selectedId = ann.id;
  refreshList();
  redraw();
  scrollToSelected();
}

function deleteAnnotation(id) {
  pushUndo();
  annotations = annotations.filter(a => a.id !== id);
  if (selectedId === id) selectedId = null;
  if (expandedAnnotationId === id) expandedAnnotationId = null;
  refreshList();
  redraw();
}

function selectAnnotation(id) {
  selectedId = id;
  // Update classes in-place so a focused input isn't destroyed by a DOM rebuild
  annList.querySelectorAll('.ann-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  redraw();
  if (id) scrollToSelected();
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

// ── Canvas events ──────────────────────────────────────────────────────────
mainCanvas.addEventListener('mousedown', e => {
  if (!sourceImage) return;

  // Right-click → start pan
  if (e.button === 2) {
    isPanning = true;
    panStart  = { mouseX: e.clientX, mouseY: e.clientY,
                  scrollLeft: canvasArea.scrollLeft, scrollTop: canvasArea.scrollTop };
    mainCanvas.style.cursor = 'grabbing';
    return;
  }

  const cp = getCanvasPos(e);
  const ip = c2i(cp.x, cp.y);

  if (mode === 'select') {
    const hit = hitTest(cp.x, cp.y);
    selectAnnotation(hit ? hit.id : null);
    return;
  }

  if (mode === 'point') {
    addAnnotation({ id: uid(), type: 'point', name: nextName('point'), coords: [ip.x, ip.y] });
    return;
  }

  if (mode === 'line') {
    if (!lineP1) {
      lineP1 = ip;
      redraw();
    } else {
      const ip2 = e.shiftKey ? constrainAxis(lineP1, ip) : ip;
      addAnnotation({ id: uid(), type: 'line', name: nextName('line'),
        coords: [[lineP1.x, lineP1.y], [ip2.x, ip2.y]] });
      lineP1 = null;
    }
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

  if (sourceImage) {
    const ip = c2i(cp.x, cp.y);
    updateCoordsHud(ip.x, ip.y);
    updateZoom(cp.x, cp.y);
  }

  if (dragging || lineP1) redraw();
});

mainCanvas.addEventListener('mouseup', e => {
  if (e.button === 2 && isPanning) {
    isPanning = false;
    panStart  = null;
    mainCanvas.style.cursor = mode === 'select' ? 'default' : 'crosshair';
    return;
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
});

mainCanvas.addEventListener('contextmenu', e => e.preventDefault());

mainCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (!sourceImage) return;

  const factor   = e.deltaY < 0 ? 1.05 : 1 / 1.05;
  const newScale = Math.max(minScale, Math.min(32, scale * factor));
  if (newScale === scale) return;

  // Image point under the cursor (in image px)
  const canvasRect  = mainCanvas.getBoundingClientRect();
  const mouseCanvasX = e.clientX - canvasRect.left;
  const mouseCanvasY = e.clientY - canvasRect.top;
  const imgX = mouseCanvasX / scale;
  const imgY = mouseCanvasY / scale;

  scale = newScale;
  mainCanvas.width  = Math.round(imgW * scale);
  mainCanvas.height = Math.round(imgH * scale);
  updateCanvasPadding();
  redraw();

  // Scroll so the image point under the cursor stays fixed.
  // updateCanvasPadding() sets canvasWrap's margin, so offsetLeft/offsetTop
  // are the exact scroll-space offsets — no estimation needed.
  const areaRect = canvasArea.getBoundingClientRect();
  canvasArea.scrollLeft = canvasWrap.offsetLeft + imgX * scale - (e.clientX - areaRect.left);
  canvasArea.scrollTop  = canvasWrap.offsetTop  + imgY * scale - (e.clientY - areaRect.top);
  updateCoordsHud(imgX, imgY);
}, { passive: false });

// ── Main canvas render ─────────────────────────────────────────────────────
function redraw() {
  if (!sourceImage) return;
  mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
  mainCtx.drawImage(sourceImage, 0, 0, mainCanvas.width, mainCanvas.height);

  for (const ann of annotations) {
    drawAnnotation(mainCtx, ann, annotationColor(ann), true, ann.id === selectedId);
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
// Returns the display color for an annotation: selected red, first-tag color, or default yellow.
function annotationColor(ann) {
  if (ann.id === selectedId) return C_SELECTED;
  if (ann.tags && ann.tags.length > 0) {
    const tag = tags.find(t => t.id === ann.tags[0]);
    if (tag) return tag.color;
  }
  return C_NORMAL;
}

function drawAnnotation(ctx, ann, color, showLabel, selected = false) {
  ctx.save();
  const lw = selected ? 3 : 2;
  if (ann.type === 'point') {
    const p = i2c(ann.coords[0], ann.coords[1]);
    paintDot(ctx, p.x, p.y, color, selected ? 6 : 5);
    if (showLabel) paintLabel(ctx, ann.name, p.x + 9, p.y - 6, color);

  } else if (ann.type === 'line') {
    const p1 = i2c(ann.coords[0][0], ann.coords[0][1]);
    const p2 = i2c(ann.coords[1][0], ann.coords[1][1]);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    paintDot(ctx, p1.x, p1.y, color, selected ? 5 : 4);
    paintDot(ctx, p2.x, p2.y, color, selected ? 5 : 4);
    if (showLabel) paintLabel(ctx, ann.name, (p1.x+p2.x)/2 + 6, (p1.y+p2.y)/2 - 6, color);

  } else if (ann.type === 'rect') {
    const p1 = i2c(ann.coords[0][0], ann.coords[0][1]);
    const p2 = i2c(ann.coords[1][0], ann.coords[1][1]);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.strokeRect(p1.x, p1.y, p2.x-p1.x, p2.y-p1.y);
    paintDot(ctx, p1.x, p1.y, color, selected ? 5 : 4);
    paintDot(ctx, p2.x, p2.y, color, selected ? 5 : 4);
    if (showLabel) paintLabel(ctx, ann.name, p1.x + 5, p1.y - 6, color);
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

function paintLabel(ctx, text, x, y, color) {
  ctx.save();
  ctx.font = '11.5px -apple-system, system-ui, sans-serif';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x - 2, y - 11, w + 6, 14);
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
    const color = annotationColor(ann);
    const sel   = ann.id === selectedId;
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
  point: `<svg class="ann-type-icon" viewBox="0 0 24 24" fill="#f6e05e" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="6"/></svg>`,
  line: `<svg class="ann-type-icon" viewBox="0 0 24 24" fill="none" stroke="#f6e05e" stroke-width="2.5"
    stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><line x1="4" y1="20" x2="20" y2="4"/></svg>`,
  rect: `<svg class="ann-type-icon" viewBox="0 0 24 24" fill="none" stroke="#f6e05e" stroke-width="2"
    xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="14" rx="1.5"/></svg>`,
};

function getTagDots(annTagIds) {
  if (!annTagIds || annTagIds.length === 0) return '';
  const dots = annTagIds
    .map(id => tags.find(t => t.id === id))
    .filter(Boolean)
    .map(t => `<span class="ann-tag-dot" style="background:${t.color}" title="${esc(t.name)}"></span>`)
    .join('');
  return dots ? `<span class="ann-tag-dots">${dots}</span>` : '';
}

function refreshList() {
  document.getElementById('ann-count').textContent = annotations.length;
  annList.innerHTML = '';

  for (const ann of annotations) {
    const isExpanded = ann.id === expandedAnnotationId;
    const item = document.createElement('div');
    item.className = 'ann-item' + (ann.id === selectedId ? ' selected' : '');
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
          chip.innerHTML = `<span class="tag-editor-dot" style="background:${tag.color}"></span>${esc(tag.name)}`;
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
  annotations = [];
  selectedId  = null;
  expandedAnnotationId = null;
  refreshList();
  redraw();
}

// ── Tags ───────────────────────────────────────────────────────────────────
function refreshTagsList() {
  tagsList.innerHTML = '';
  for (const tag of tags) {
    const item = document.createElement('div');
    item.className = 'tag-item' + (activeTags.has(tag.id) ? ' active' : '');
    item.dataset.id = tag.id;
    item.innerHTML = `
      <span class="tag-dot" style="background:${tag.color}"></span>
      <span class="tag-name">${esc(tag.name)}</span>
      <button class="tag-del-btn" title="Delete tag">×</button>
    `;
    item.addEventListener('click', e => {
      if (e.target.classList.contains('tag-del-btn')) return;
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
  if (tagAnchorId === id) tagAnchorId = null;
  for (const ann of annotations) {
    if (ann.tags) ann.tags = ann.tags.filter(tid => tid !== id);
  }
  refreshTagsList();
  refreshList();
}

function startAddTag() {
  if (tagsList.querySelector('.tag-new-input')) return; // already adding
  const color   = TAG_COLORS[tags.length % TAG_COLORS.length];
  const wrapper = document.createElement('div');
  wrapper.className = 'tag-item';
  wrapper.innerHTML = `<span class="tag-dot" style="background:${color}"></span>`;
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

function importJSONFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      pushUndo();
      // Restore tags
      tags = (data.tags || []).map(t => ({ id: uid(), name: t.name, color: t.color || TAG_COLORS[0] }));
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

// ── Shift key tracking (for axis-constrained drawing) ──────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Shift' && lineP1) { shiftHeld = true; redraw(); }
});
document.addEventListener('keyup', e => {
  if (e.key === 'Shift' && lineP1) { shiftHeld = false; redraw(); }
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
  if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); undo(); return; }
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
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
    deleteAnnotation(selectedId);
    return;
  }
  if (e.key === 'Escape') {
    if (lineP1 || dragging) {
      lineP1 = null; rectP1 = null; dragging = false;
      redraw();
    } else if (selectedId) {
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
function toggleTheme(light) {
  document.body.classList.toggle('light', light);
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

document.addEventListener('click', () => closeToolsMenu());

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
  let count = 0;

  for (const ann of annotations) {
    if (ann.type !== 'point') continue;
    if (tagId && !ann.tags.includes(tagId)) continue;
    const c = ann.coords;
    for (const ax of axes) {
      let v = ax.a + (ax.b - ax.a) *
        ((c[0] - ax.r0[0]) * ax.delta[0] + (c[1] - ax.r0[1]) * ax.delta[1]) / ax.l2;
      if (ax.islog) v = Math.exp(v);
      col[ax.name].push(v);
    }
    count++;
  }

  if (count === 0) {
    return { error: 'No points found' + (tagId ? ' with the selected tag.' : '.') };
  }

  const keys = Object.keys(col).sort();
  let csv = keys.map(csvSanitize).join(',') + '\n';
  const n = col[keys[0]].length;
  for (let i = 0; i < n; i++) {
    csv += keys.map(k => col[k][i]).join(',') + '\n';
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
    if (tagId && !ann.tags.includes(tagId)) continue;
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

// ── Init ───────────────────────────────────────────────────────────────────
setMode('select');
refreshTagsList();
refreshList();
