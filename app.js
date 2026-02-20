'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const C_NORMAL   = '#f6e05e';   // yellow – default annotation color
const C_SELECTED = '#fc8181';   // red    – selected annotation
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

// Panning state
let isPanning = false;
let panStart  = null;           // {mouseX, mouseY, scrollLeft, scrollTop}

// Name counters
const counters = { point: 0, line: 0, rect: 0 };

// ── DOM refs ───────────────────────────────────────────────────────────────
const mainCanvas = document.getElementById('main-canvas');
const mainCtx    = mainCanvas.getContext('2d');
const zoomCanvas = document.getElementById('zoom-canvas');
const zoomCtx    = zoomCanvas.getContext('2d');
const annList    = document.getElementById('annotation-list');
const coordsHud  = document.getElementById('coords-hud');
const dropZone   = document.getElementById('drop-zone');
const canvasWrap = document.getElementById('canvas-wrapper');
const canvasArea = document.getElementById('canvas-area');

// ── Utilities ──────────────────────────────────────────────────────────────
function uid() { return crypto.randomUUID(); }

function nextName(type) {
  counters[type]++;
  const n     = String(counters[type]).padStart(3, '0');
  const label = type === 'rect' ? 'Rectangle' : type.charAt(0).toUpperCase() + type.slice(1);
  return `${label}${n}`;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Coordinate helpers
function c2i(cx, cy) { return { x: cx / scale, y: cy / scale }; }
function i2c(ix, iy) { return { x: ix * scale, y: iy * scale }; }

function getCanvasPos(e) {
  const r = mainCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
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
    fitCanvas();
    dropZone.style.display   = 'none';
    canvasWrap.style.display = 'inline-block';
    redraw();
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
}

// ── Annotation CRUD ────────────────────────────────────────────────────────
function addAnnotation(ann) {
  annotations.push(ann);
  selectedId = ann.id;
  refreshList();
  redraw();
  scrollToSelected();
}

function deleteAnnotation(id) {
  annotations = annotations.filter(a => a.id !== id);
  if (selectedId === id) selectedId = null;
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
      addAnnotation({ id: uid(), type: 'line', name: nextName('line'),
        coords: [[lineP1.x, lineP1.y], [ip.x, ip.y]] });
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

  if (sourceImage) {
    const ip = c2i(cp.x, cp.y);
    coordsHud.textContent = `x: ${ip.x.toFixed(2)}   y: ${ip.y.toFixed(2)}`;
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
  coordsHud.textContent = '—';
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
  redraw();

  // Scroll so the image point under the cursor stays fixed.
  // When the canvas is smaller than the area, flexbox centres it,
  // adding an implicit offset that must be accounted for.
  const areaRect   = canvasArea.getBoundingClientRect();
  const wrapOffsetX = Math.max(0, (canvasArea.clientWidth  - mainCanvas.width)  / 2);
  const wrapOffsetY = Math.max(0, (canvasArea.clientHeight - mainCanvas.height) / 2);
  canvasArea.scrollLeft = wrapOffsetX + imgX * scale - (e.clientX - areaRect.left);
  canvasArea.scrollTop  = wrapOffsetY + imgY * scale - (e.clientY - areaRect.top);
}, { passive: false });

// ── Main canvas render ─────────────────────────────────────────────────────
function redraw() {
  if (!sourceImage) return;
  mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
  mainCtx.drawImage(sourceImage, 0, 0, mainCanvas.width, mainCanvas.height);

  for (const ann of annotations) {
    const sel = ann.id === selectedId;
    drawAnnotation(mainCtx, ann, sel ? C_SELECTED : C_NORMAL, true);
  }

  // In-progress previews
  const mp = mouseCanvas;

  if (mode === 'line' && lineP1 && mp) {
    const p1 = i2c(lineP1.x, lineP1.y);
    mainCtx.save();
    mainCtx.setLineDash([5, 4]);
    mainCtx.strokeStyle = C_PREVIEW;
    mainCtx.lineWidth = 1.5;
    mainCtx.beginPath();
    mainCtx.moveTo(p1.x, p1.y);
    mainCtx.lineTo(mp.x, mp.y);
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
function drawAnnotation(ctx, ann, color, showLabel) {
  ctx.save();
  if (ann.type === 'point') {
    const p = i2c(ann.coords[0], ann.coords[1]);
    paintDot(ctx, p.x, p.y, color, 5);
    if (showLabel) paintLabel(ctx, ann.name, p.x + 9, p.y - 6, color);

  } else if (ann.type === 'line') {
    const p1 = i2c(ann.coords[0][0], ann.coords[0][1]);
    const p2 = i2c(ann.coords[1][0], ann.coords[1][1]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    paintDot(ctx, p1.x, p1.y, color, 4);
    paintDot(ctx, p2.x, p2.y, color, 4);
    if (showLabel) paintLabel(ctx, ann.name, (p1.x+p2.x)/2 + 6, (p1.y+p2.y)/2 - 6, color);

  } else if (ann.type === 'rect') {
    const p1 = i2c(ann.coords[0][0], ann.coords[0][1]);
    const p2 = i2c(ann.coords[1][0], ann.coords[1][1]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(p1.x, p1.y, p2.x-p1.x, p2.y-p1.y);
    paintDot(ctx, p1.x, p1.y, color, 4);
    paintDot(ctx, p2.x, p2.y, color, 4);
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
    const color = ann.id === selectedId ? C_SELECTED : C_NORMAL;
    zoomCtx.save();

    if (ann.type === 'point') {
      const p = z2c(ann.coords[0], ann.coords[1]);
      paintDot(zoomCtx, p.x, p.y, color, 4);
    } else if (ann.type === 'line') {
      const p1 = z2c(ann.coords[0][0], ann.coords[0][1]);
      const p2 = z2c(ann.coords[1][0], ann.coords[1][1]);
      zoomCtx.strokeStyle = color; zoomCtx.lineWidth = 2;
      zoomCtx.beginPath(); zoomCtx.moveTo(p1.x, p1.y); zoomCtx.lineTo(p2.x, p2.y); zoomCtx.stroke();
      paintDot(zoomCtx, p1.x, p1.y, color, 3);
      paintDot(zoomCtx, p2.x, p2.y, color, 3);
    } else if (ann.type === 'rect') {
      const p1 = z2c(ann.coords[0][0], ann.coords[0][1]);
      const p2 = z2c(ann.coords[1][0], ann.coords[1][1]);
      zoomCtx.strokeStyle = color; zoomCtx.lineWidth = 2;
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

function refreshList() {
  document.getElementById('ann-count').textContent = annotations.length;
  annList.innerHTML = '';

  for (const ann of annotations) {
    const item = document.createElement('div');
    item.className = 'ann-item' + (ann.id === selectedId ? ' selected' : '');
    item.dataset.id = ann.id;
    item.innerHTML = `
      ${TYPE_ICONS[ann.type] || ''}
      <input class="ann-name-input" type="text" value="${esc(ann.name)}"
        data-id="${ann.id}" spellcheck="false">
      <button class="ann-del-btn" data-id="${ann.id}" title="Delete">×</button>
    `;

    item.addEventListener('mousedown', e => {
      if (!e.target.classList.contains('ann-name-input') &&
          !e.target.classList.contains('ann-del-btn')) {
        selectAnnotation(ann.id);
      }
    });

    const inp = item.querySelector('.ann-name-input');
    inp.addEventListener('focus', e => {
      selectAnnotation(ann.id);
      setTimeout(() => e.target.select(), 0); // deferred so Safari's mouseup doesn't clear the selection
    });
    inp.addEventListener('change', e => {
      const a = annotations.find(x => x.id === e.target.dataset.id);
      if (a) { a.name = e.target.value || a.name; redraw(); }
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

// ── JSON export / import ───────────────────────────────────────────────────
function downloadJSON() {
  const payload = {
    metadata: {
      image:    imageFileName,
      exported: new Date().toISOString(),
    },
    annotations: annotations.map(a => ({
      type:   a.type,
      name:   a.name,
      coords: a.coords,
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
      const list = data.annotations || (Array.isArray(data) ? data : []);
      annotations = list.map(a => ({ id: uid(), type: a.type, name: a.name, coords: a.coords }));
      // Sync name counters so new annotations don't collide
      const prefixMap = { point: 'point', line: 'line', rect: 'rect', rectangle: 'rect' };
      for (const a of annotations) {
        const m = a.name.match(/^([A-Za-z]+?)(\d+)$/);
        if (m) {
          const key = prefixMap[m[1].toLowerCase()];
          if (key) counters[key] = Math.max(counters[key] || 0, parseInt(m[2], 10));
        }
      }
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

// ── Keyboard shortcuts ─────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const k = e.key.toLowerCase();
  if (k === 's') { setMode('select'); return; }
  if (k === 'p') { setMode('point');  return; }
  if (k === 'l') { setMode('line');   return; }
  if (k === 'r') { setMode('rect');   return; }
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
  if (sourceImage) fitCanvas(), redraw();
});

// ── Theme ──────────────────────────────────────────────────────────────────
function toggleTheme(light) {
  document.body.classList.toggle('light', light);
}

// ── Init ───────────────────────────────────────────────────────────────────
setMode('select');
refreshList();
