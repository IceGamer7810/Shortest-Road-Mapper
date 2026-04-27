/* eslint-disable no-use-before-define */

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

const els = {
  stage1: $("#stage1"),
  stage2: $("#stage2"),
  fileInput: /** @type {HTMLInputElement} */ ($("#fileInput")),
  pipetteBtn: /** @type {HTMLButtonElement} */ ($("#pipetteBtn")),
  okBtn: /** @type {HTMLButtonElement} */ ($("#okBtn")),
  threshold: /** @type {HTMLInputElement} */ ($("#threshold")),
  thresholdVal: $("#thresholdVal"),
  swatch: $("#swatch"),
  pickedRgb: $("#pickedRgb"),
  stage1Hint: $("#stage1Hint"),
  stage2Hint: $("#stage2Hint"),
  statusText: $("#statusText"),
  resetBtn: /** @type {HTMLButtonElement} */ ($("#resetBtn")),
  backBtn: /** @type {HTMLButtonElement} */ ($("#backBtn")),
  diagToggle: /** @type {HTMLInputElement} */ ($("#diagToggle")),
  helpBtn: /** @type {HTMLAnchorElement} */ ($("#helpBtn")),
  helpDialog: /** @type {HTMLDialogElement} */ ($("#helpDialog")),
  helpCloseBtn: /** @type {HTMLButtonElement} */ ($("#helpCloseBtn")),

  origCanvas: /** @type {HTMLCanvasElement} */ ($("#origCanvas")),
  origOverlay: /** @type {HTMLCanvasElement} */ ($("#origOverlay")),
  previewCanvas: /** @type {HTMLCanvasElement} */ ($("#previewCanvas")),

  activeCanvas: /** @type {HTMLCanvasElement} */ ($("#activeCanvas")),
  pathCanvas: /** @type {HTMLCanvasElement} */ ($("#pathCanvas")),
};

const MAX_PREVIEW_DIM = 512;

/**
 * @typedef {{r:number,g:number,b:number}} RGB
 * @typedef {{x:number,y:number}} Point
 */

/** @type {AppState} */
const state = {
  phase: "stage1",
  pipetteOn: false,

  img: null,
  full: {
    w: 0,
    h: 0,
    imageData: null,
  },
  preview: {
    w: 0,
    h: 0,
    imageData: null,
  },
  chosen: {
    rgb: null,
    threshold: 0,
  },
  display: {
    origDrawRect: { dx: 0, dy: 0, dw: 0, dh: 0 },
    previewDrawRect: { dx: 0, dy: 0, dw: 0, dh: 0 },
  },
  active: {
    imageData: null,
    w: 0,
    h: 0,
  },
  selection: {
    start: null,
    end: null,
  },
  path: {
    running: false,
    cancelToken: 0,
  },
  pathfinder: null,
};

init();

function init() {
  wireUi();
  resizeStage1Canvases();
  renderEmptyStage1();
  setStatus("");
}

function wireUi() {
  window.addEventListener("resize", () => {
    if (state.phase === "stage1") {
      resizeStage1Canvases();
      if (state.img) renderStage1();
    }
  });

  els.fileInput.addEventListener("change", async () => {
    const file = els.fileInput.files?.[0];
    if (!file) return;

    try {
      await loadImageFromFile(file);
    } catch (err) {
      console.error(err);
      alert("A képet nem sikerült betölteni.");
    }
  });

  els.pipetteBtn.addEventListener("click", () => {
    if (!state.img) return;
    setPipette(!state.pipetteOn);
  });

  els.threshold.addEventListener("input", () => {
    state.chosen.threshold = clampInt(parseInt(els.threshold.value, 10), 0, 255);
    els.thresholdVal.textContent = String(state.chosen.threshold);
    if (state.chosen.rgb && state.preview.imageData) {
      renderPreviewFiltered();
    }
  });

  els.okBtn.addEventListener("click", async () => {
    if (!state.full.imageData || !state.chosen.rgb) return;
    await applyFilterAndEnterStage2();
  });

  els.origCanvas.addEventListener("click", (ev) => {
    if (!state.pipetteOn) return;
    if (!state.full.imageData) return;

    const pos = getCanvasClickPos(ev, els.origCanvas);
    const src = mapDisplayToSource(pos, els.origCanvas, state.display.origDrawRect, state.full.w, state.full.h);
    if (!src) return;

    const rgb = getRgbAt(state.full.imageData, src.x, src.y);
    setChosenColor(rgb);
    renderPreviewFiltered();
  });

  els.resetBtn.addEventListener("click", () => resetSelectionAndPath());
  els.backBtn.addEventListener("click", () => goBackToStage1());

  els.pathCanvas.addEventListener("click", async (ev) => {
    if (state.phase !== "stage2") return;
    if (!state.active.imageData) return;
    if (state.path.running) return;

    const p = getCanvasClickPos(ev, els.pathCanvas);
    const x = clampInt(Math.floor(p.x), 0, state.active.w - 1);
    const y = clampInt(Math.floor(p.y), 0, state.active.h - 1);
    if (!isWalkable(state.active.imageData, state.active.w, x, y)) {
      setStatus("Érvénytelen pont: csak nem átlátszó pixelen lehet kijelölni.");
      flashInvalidPoint(x, y);
      return;
    }

    setStatus("");
    if (!state.selection.start) {
      state.selection.start = { x, y };
      renderStage2Overlay();
      return;
    }

    if (!state.selection.end) {
      state.selection.end = { x, y };
      renderStage2Overlay();
      await runPathfinding();
      return;
    }

    // Third click: restart selection from this point
    state.selection.start = { x, y };
    state.selection.end = null;
    renderStage2Overlay(true);
  });

  els.diagToggle.addEventListener("change", () => {
    if (state.phase !== "stage2") return;
    if (state.selection.start && state.selection.end && !state.path.running) {
      runPathfinding();
    }
  });

  els.helpBtn.addEventListener("click", (e) => {
    e.preventDefault();
    els.helpDialog.showModal();
  });
  els.helpCloseBtn.addEventListener("click", () => els.helpDialog.close());
  els.helpDialog.addEventListener("click", (e) => {
    const rect = els.helpDialog.getBoundingClientRect();
    const isInDialog =
      rect.top <= e.clientY && e.clientY <= rect.top + rect.height && rect.left <= e.clientX && e.clientX <= rect.left + rect.width;
    if (!isInDialog) els.helpDialog.close();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.phase === "stage1" && state.pipetteOn) {
      setPipette(false);
    }
    if ((e.key === "p" || e.key === "P") && state.phase === "stage1" && state.img) {
      setPipette(!state.pipetteOn);
    }
    if ((e.key === "r" || e.key === "R") && state.phase === "stage2") {
      resetSelectionAndPath();
    }
  });
}

async function loadImageFromFile(file) {
  if (!isSupportedFile(file)) {
    alert("Nem támogatott fájlformátum. (PNG, JPG, JPEG, BMP)");
    els.fileInput.value = "";
    return;
  }

  resetAll();
  setStatus("");
  els.stage1Hint.textContent = "Betöltés...";

  const img = await fileToImage(file);
  state.img = img;

  // Full-res buffer
  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = img.naturalWidth || img.width;
  fullCanvas.height = img.naturalHeight || img.height;
  const fctx = must2d(fullCanvas);
  fctx.imageSmoothingEnabled = true;
  fctx.drawImage(img, 0, 0);
  const fullData = fctx.getImageData(0, 0, fullCanvas.width, fullCanvas.height);

  state.full.w = fullCanvas.width;
  state.full.h = fullCanvas.height;
  state.full.imageData = fullData;

  // Preview buffer (downscaled)
  const { w: pw, h: ph } = fitWithin(state.full.w, state.full.h, MAX_PREVIEW_DIM, MAX_PREVIEW_DIM);
  const pCanvas = document.createElement("canvas");
  pCanvas.width = pw;
  pCanvas.height = ph;
  const pctx = must2d(pCanvas);
  pctx.imageSmoothingEnabled = true;
  pctx.drawImage(img, 0, 0, pw, ph);
  state.preview.w = pw;
  state.preview.h = ph;
  state.preview.imageData = pctx.getImageData(0, 0, pw, ph);

  // UI enablement
  els.pipetteBtn.disabled = false;
  els.threshold.disabled = false;
  els.threshold.value = "0";
  state.chosen.threshold = 0;
  els.thresholdVal.textContent = "0";

  els.stage1Hint.textContent = "Pipetta módban kattints egy színre az eredeti képen.";
  resizeStage1Canvases();
  renderStage1();
}

function resetAll() {
  state.phase = "stage1";
  state.pipetteOn = false;
  state.img = null;
  state.full = { w: 0, h: 0, imageData: null };
  state.preview = { w: 0, h: 0, imageData: null };
  state.chosen = { rgb: null, threshold: 0 };
  state.active = { imageData: null, w: 0, h: 0 };
  state.selection = { start: null, end: null };
  state.path = { running: false, cancelToken: state.path.cancelToken + 1 };
  state.pathfinder = null;

  setPipette(false);
  els.pipetteBtn.disabled = true;
  els.okBtn.disabled = true;
  els.threshold.disabled = true;
  els.pickedRgb.textContent = "—";
  els.swatch.style.background = "";
  els.stage1Hint.textContent = "Tölts fel egy képet, majd Pipetta módban kattints egy színre.";
  showStage("stage1");
  renderEmptyStage1();
}

function setChosenColor(rgb) {
  state.chosen.rgb = rgb;
  els.pickedRgb.textContent = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  els.swatch.style.background = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  els.okBtn.disabled = false;
  els.stage1Hint.textContent = "Állíts toleranciát, ellenőrizd az előnézetet, majd OK.";
}

function setPipette(on) {
  state.pipetteOn = on;
  document.body.classList.toggle("pipette-mode", on);
  els.pipetteBtn.classList.toggle("primary", on);
  renderOrigOverlay();
}

function resizeStage1Canvases() {
  // Canvas squares use CSS aspect-ratio; compute actual pixel size from client rect.
  sizeCanvasToClient(els.origCanvas);
  sizeCanvasToClient(els.origOverlay);
  sizeCanvasToClient(els.previewCanvas);
}

function sizeCanvasToClient(canvas) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  // Keep CSS size; set internal bitmap to match for crisp drawing.
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function renderEmptyStage1() {
  const octx = must2d(els.origCanvas);
  const pctx = must2d(els.previewCanvas);
  clearCanvas(octx, els.origCanvas);
  clearCanvas(pctx, els.previewCanvas);
  renderOrigOverlay();
}

function renderStage1() {
  drawToSquareCanvas(els.origCanvas, state.img, state.full.w, state.full.h, (rect) => {
    state.display.origDrawRect = rect;
  });
  renderOrigOverlay();
  if (state.chosen.rgb && state.preview.imageData) {
    renderPreviewFiltered();
  } else {
    // If no chosen color yet, show the downscaled original as preview.
    drawToSquareCanvas(els.previewCanvas, state.img, state.full.w, state.full.h, (rect) => {
      state.display.previewDrawRect = rect;
    });
  }
}

function renderOrigOverlay() {
  const ctx = must2d(els.origOverlay);
  clearCanvas(ctx, els.origOverlay);
  if (!state.img) return;

  const { dx, dy, dw, dh } = state.display.origDrawRect;
  ctx.strokeStyle = "rgba(255,255,255,0.20)";
  ctx.lineWidth = 1;
  ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);

  if (state.pipetteOn) {
    ctx.fillStyle = "rgba(124,92,255,0.12)";
    ctx.fillRect(dx, dy, dw, dh);
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono','Courier New', monospace";
    ctx.fillText("Pipetta: kattints egy pixelre", dx + 10, dy + 18);
  }
}

function renderPreviewFiltered() {
  if (!state.preview.imageData || !state.chosen.rgb) return;

  const { imageData, w, h } = state.preview;
  const out = filterImageData(imageData, state.chosen.rgb, state.chosen.threshold);

  // Draw the filtered preview into a temporary canvas, then letterbox into the square preview canvas.
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = must2d(tmp);
  tctx.putImageData(out, 0, 0);

  drawToSquareCanvas(els.previewCanvas, tmp, w, h, (rect) => {
    state.display.previewDrawRect = rect;
  });
}

async function applyFilterAndEnterStage2() {
  if (!state.full.imageData || !state.chosen.rgb) return;

  setPipette(false);
  els.okBtn.disabled = true;
  els.pipetteBtn.disabled = true;
  els.threshold.disabled = true;
  setStatus("Szűrés folyamatban...");

  await nextFrame();

  const filtered = filterImageData(state.full.imageData, state.chosen.rgb, state.chosen.threshold);
  state.active.imageData = filtered;
  state.active.w = state.full.w;
  state.active.h = state.full.h;
  state.pathfinder = new Pathfinder(state.active.w, state.active.h, state.active.imageData);

  enterStage2();
  setStatus("");
}

function enterStage2() {
  state.phase = "stage2";
  showStage("stage2");

  // Size canvases to image size (1:1 pixels; scroll container if large).
  const w = state.active.w;
  const h = state.active.h;
  setCanvasPixelSize(els.activeCanvas, w, h);
  setCanvasPixelSize(els.pathCanvas, w, h);

  const act = must2d(els.activeCanvas);
  act.imageSmoothingEnabled = false;
  act.putImageData(state.active.imageData, 0, 0);

  renderStage2Overlay(true);
}

function goBackToStage1() {
  // Keep loaded image + chosen settings; allow quick adjustments.
  if (!state.full.imageData || !state.img) {
    resetAll();
    return;
  }

  state.phase = "stage1";
  state.selection = { start: null, end: null };
  state.active = { imageData: null, w: 0, h: 0 };
  state.path = { running: false, cancelToken: state.path.cancelToken + 1 };
  state.pathfinder = null;

  els.pipetteBtn.disabled = false;
  els.threshold.disabled = false;
  els.okBtn.disabled = !state.chosen.rgb;
  els.stage1Hint.textContent = state.chosen.rgb
    ? "Állíts toleranciát, ellenőrizd az előnézetet, majd OK."
    : "Pipetta módban kattints egy színre az eredeti képen.";

  showStage("stage1");
  resizeStage1Canvases();
  renderStage1();
}

function showStage(which) {
  els.stage1.classList.toggle("stage-visible", which === "stage1");
  els.stage2.classList.toggle("stage-visible", which === "stage2");
}

function resetSelectionAndPath() {
  if (state.phase !== "stage2") return;
  state.path.cancelToken++;
  state.path.running = false;
  state.selection.start = null;
  state.selection.end = null;
  setStatus("");
  renderStage2Overlay(true);
}

function renderStage2Overlay(clear = false) {
  const ctx = must2d(els.pathCanvas);
  clearCanvas(ctx, els.pathCanvas);

  const start = state.selection.start;
  const end = state.selection.end;
  if (start) drawMarker(ctx, start, "#22c55e", "S");
  if (end) drawMarker(ctx, end, "#ef4444", "E");
}

function drawMarker(ctx, p, color, label) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x + 0.5, p.y + 0.5, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(0,0,0,0.8)";
  ctx.font = "10px " + getComputedStyle(document.body).fontFamily;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, p.x + 0.5, p.y + 0.5);
  ctx.restore();
}

async function runPathfinding() {
  if (!state.pathfinder) return;
  if (!state.selection.start || !state.selection.end) return;

  const token = ++state.path.cancelToken;
  state.path.running = true;
  setStatus("Útvonal-keresés (A*)...");

  const allowDiagonal = !!els.diagToggle.checked;
  const start = state.selection.start;
  const end = state.selection.end;

  const result = await state.pathfinder.findPathAsync(start, end, allowDiagonal, token, (msg) => setStatus(msg));
  if (token !== state.path.cancelToken) return; // canceled

  state.path.running = false;
  if (!result) {
    setStatus("Nincs útvonal a két pont között ezen a szűrt képen.");
    renderStage2Overlay(true);
    return;
  }

  renderStage2Overlay(true);
  drawPathPolyline(result);
  setStatus(`Kész. Hossz: ${result.length} pixel`);
}

function drawPathPolyline(path) {
  const ctx = must2d(els.pathCanvas);
  ctx.save();
  ctx.strokeStyle = "rgba(255,0,255,0.95)";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(path[0].x + 0.5, path[0].y + 0.5);
  for (let i = 1; i < path.length; i++) {
    const p = path[i];
    ctx.lineTo(p.x + 0.5, p.y + 0.5);
  }
  ctx.stroke();
  ctx.restore();

  // redraw markers on top
  const start = state.selection.start;
  const end = state.selection.end;
  if (start) drawMarker(ctx, start, "#22c55e", "S");
  if (end) drawMarker(ctx, end, "#ef4444", "E");
}

function flashInvalidPoint(x, y) {
  const ctx = must2d(els.pathCanvas);
  ctx.save();
  ctx.strokeStyle = "rgba(239,68,68,0.95)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x + 0.5, y + 0.5, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  setTimeout(() => renderStage2Overlay(true), 250);
}

function setStatus(text) {
  els.statusText.textContent = text || "";
}

/**
 * Filter keeps pixels where max(|dr|,|dg|,|db|) <= threshold (0..255),
 * and makes every other pixel fully transparent.
 */
function filterImageData(imageData, rgb, threshold) {
  const src = imageData.data;
  const out = new ImageData(imageData.width, imageData.height);
  const dst = out.data;

  const tr = rgb.r | 0;
  const tg = rgb.g | 0;
  const tb = rgb.b | 0;
  const t = threshold | 0;

  for (let i = 0; i < src.length; i += 4) {
    const r = src[i];
    const g = src[i + 1];
    const b = src[i + 2];
    const a = src[i + 3];
    if (a === 0) {
      dst[i] = r;
      dst[i + 1] = g;
      dst[i + 2] = b;
      dst[i + 3] = 0;
      continue;
    }

    const dr = abs8(r - tr);
    const dg = abs8(g - tg);
    const db = abs8(b - tb);
    const d = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
    if (d <= t) {
      dst[i] = r;
      dst[i + 1] = g;
      dst[i + 2] = b;
      dst[i + 3] = 255;
    } else {
      dst[i] = r;
      dst[i + 1] = g;
      dst[i + 2] = b;
      dst[i + 3] = 0;
    }
  }

  return out;
}

function isWalkable(imageData, w, x, y) {
  const idx = (y * w + x) * 4 + 3;
  return imageData.data[idx] !== 0;
}

function getRgbAt(imageData, x, y) {
  const i = (y * imageData.width + x) * 4;
  const d = imageData.data;
  return { r: d[i], g: d[i + 1], b: d[i + 2] };
}

function getCanvasClickPos(ev, canvas) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (ev.clientX - rect.left) * sx,
    y: (ev.clientY - rect.top) * sy,
  };
}

function mapDisplayToSource(pos, displayCanvas, drawRect, srcW, srcH) {
  const { dx, dy, dw, dh } = drawRect;
  const x = pos.x;
  const y = pos.y;
  if (x < dx || y < dy || x >= dx + dw || y >= dy + dh) return null;
  const u = (x - dx) / dw;
  const v = (y - dy) / dh;
  const sx = clampInt(Math.floor(u * srcW), 0, srcW - 1);
  const sy = clampInt(Math.floor(v * srcH), 0, srcH - 1);
  return { x: sx, y: sy };
}

function drawToSquareCanvas(targetCanvas, source, srcW, srcH, onRect) {
  const ctx = must2d(targetCanvas);
  clearCanvas(ctx, targetCanvas);

  const cw = targetCanvas.width;
  const ch = targetCanvas.height;

  const { w: dw, h: dh } = fitWithin(srcW, srcH, cw, ch);
  const dx = Math.floor((cw - dw) / 2);
  const dy = Math.floor((ch - dh) / 2);

  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, 0, 0, srcW, srcH, dx, dy, dw, dh);
  onRect?.({ dx, dy, dw, dh });
}

function setCanvasPixelSize(canvas, w, h) {
  canvas.width = Math.max(1, Math.floor(w));
  canvas.height = Math.max(1, Math.floor(h));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}

function clearCanvas(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function must2d(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context not available");
  return ctx;
}

function fitWithin(w, h, maxW, maxH) {
  const scale = Math.min(maxW / w, maxH / h);
  return { w: Math.max(1, Math.floor(w * scale)), h: Math.max(1, Math.floor(h * scale)) };
}

function abs8(n) {
  return n < 0 ? -n : n;
}

function clampInt(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

function isSupportedFile(file) {
  const type = (file.type || "").toLowerCase();
  if (type === "image/png" || type === "image/jpeg" || type === "image/bmp") return true;
  const name = file.name.toLowerCase();
  return name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".bmp");
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image load failed"));
    };
    img.src = url;
  });
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * @typedef {{
 *  phase: "stage1"|"stage2",
 *  pipetteOn: boolean,
 *  img: HTMLImageElement|null,
 *  full: {w:number,h:number,imageData: ImageData|null},
 *  preview: {w:number,h:number,imageData: ImageData|null},
 *  chosen: {rgb: RGB|null, threshold: number},
 *  display: {origDrawRect: {dx:number,dy:number,dw:number,dh:number}, previewDrawRect: {dx:number,dy:number,dw:number,dh:number}},
 *  active: {imageData: ImageData|null, w:number, h:number},
 *  selection: {start: Point|null, end: Point|null},
 *  path: {running: boolean, cancelToken: number},
 *  pathfinder: Pathfinder|null,
 * }} AppState
 */

class MinHeap {
  /** @param {number} cap */
  constructor(cap) {
    this.idx = new Int32Array(Math.max(16, cap));
    this.f = new Float32Array(this.idx.length);
    this.size = 0;
    this.popF = 0;
  }

  /** @param {number} index @param {number} f */
  push(index, f) {
    if (this.size >= this.idx.length) this._grow();
    let i = this.size++;
    this.idx[i] = index;
    this.f[i] = f;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= f) break;
      this.idx[i] = this.idx[p];
      this.f[i] = this.f[p];
      i = p;
    }
    this.idx[i] = index;
    this.f[i] = f;
  }

  pop() {
    if (this.size === 0) return -1;
    const out = this.idx[0];
    this.popF = this.f[0];
    const lastI = --this.size;
    if (lastI === 0) return out;
    const li = this.idx[lastI];
    const lf = this.f[lastI];

    let i = 0;
    while (true) {
      const l = i * 2 + 1;
      if (l >= this.size) break;
      const r = l + 1;
      let c = l;
      if (r < this.size && this.f[r] < this.f[l]) c = r;
      if (this.f[c] >= lf) break;
      this.idx[i] = this.idx[c];
      this.f[i] = this.f[c];
      i = c;
    }
    this.idx[i] = li;
    this.f[i] = lf;
    return out;
  }

  _grow() {
    const n = this.idx.length * 2;
    const ni = new Int32Array(n);
    const nf = new Float32Array(n);
    ni.set(this.idx);
    nf.set(this.f);
    this.idx = ni;
    this.f = nf;
  }
}

class Pathfinder {
  /** @param {number} w @param {number} h @param {ImageData} imageData */
  constructor(w, h, imageData) {
    this.w = w;
    this.h = h;
    this.data = imageData.data;
    this.N = w * h;

    this.runId = 1;
    this.stamp = new Uint32Array(this.N);
    this.g = new Float32Array(this.N);
    this.prev = new Int32Array(this.N);
    this.heap = new MinHeap(Math.min(this.N, 1024));
  }

  /** @param {number} idx */
  _walkable(idx) {
    return this.data[idx * 4 + 3] !== 0;
  }

  /** @param {Point} start @param {Point} end @param {boolean} diag @param {number} token @param {(s:string)=>void} onStatus */
  async findPathAsync(start, end, diag, token, onStatus) {
    const w = this.w;
    const h = this.h;
    const startIdx = start.y * w + start.x;
    const goalIdx = end.y * w + end.x;
    if (startIdx === goalIdx) return [start];
    if (!this._walkable(startIdx) || !this._walkable(goalIdx)) return null;

    const run = ++this.runId;
    this.heap.size = 0;

    const stamp = this.stamp;
    const g = this.g;
    const prev = this.prev;

    stamp[startIdx] = run;
    g[startIdx] = 0;
    prev[startIdx] = -1;
    this.heap.push(startIdx, heuristic(start, end, diag));

    const neighbors4 = [
      { dx: 1, dy: 0, cost: 1 },
      { dx: -1, dy: 0, cost: 1 },
      { dx: 0, dy: 1, cost: 1 },
      { dx: 0, dy: -1, cost: 1 },
    ];
    const neighbors8 = [
      ...neighbors4,
      { dx: 1, dy: 1, cost: 1.41421356 },
      { dx: 1, dy: -1, cost: 1.41421356 },
      { dx: -1, dy: 1, cost: 1.41421356 },
      { dx: -1, dy: -1, cost: 1.41421356 },
    ];
    const nbs = diag ? neighbors8 : neighbors4;

    let expanded = 0;
    const YIELD_EVERY = 12000;
    const hardLimit = Math.max(250_000, Math.floor(this.N * 0.75));

    while (this.heap.size > 0) {
      if (token !== state.path.cancelToken) return null;
      const cur = this.heap.pop();
      if (cur === goalIdx) return reconstruct(prev, w, goalIdx);

      const cx = cur % w;
      const cy = (cur / w) | 0;
      const baseG = g[cur];
      {
        const dx = abs8(cx - end.x);
        const dy = abs8(cy - end.y);
        const bestF = baseG + (diag ? octile(dx, dy) : dx + dy);
        if (this.heap.popF > bestF + 1e-6) continue; // stale heap entry
      }

      for (let i = 0; i < nbs.length; i++) {
        const nb = nbs[i];
        const nx = cx + nb.dx;
        const ny = cy + nb.dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!this._walkable(ni)) continue;

        // Optional: disallow diagonal cutting corners through transparent pixels.
        if (diag && nb.dx !== 0 && nb.dy !== 0) {
          const a = cy * w + nx;
          const b = ny * w + cx;
          if (!this._walkable(a) || !this._walkable(b)) continue;
        }

        const tentative = baseG + nb.cost;
        if (stamp[ni] !== run || tentative < g[ni]) {
          stamp[ni] = run;
          g[ni] = tentative;
          prev[ni] = cur;
          const hx = abs8(nx - end.x);
          const hy = abs8(ny - end.y);
          const f = tentative + (diag ? octile(hx, hy) : hx + hy);
          this.heap.push(ni, f);
        }
      }

      expanded++;
      if (expanded % YIELD_EVERY === 0) {
        onStatus(`Keresés... vizsgált csomópontok: ${expanded.toLocaleString("hu-HU")}`);
        await nextFrame();
      }
      if (expanded > hardLimit) {
        onStatus("Megszakítva: túl sok csomópont (kép túl nagy / túl széles terület).");
        return null;
      }
    }

    return null;
  }
}

function reconstruct(prev, w, goalIdx) {
  const out = [];
  let cur = goalIdx;
  while (cur !== -1) {
    const x = cur % w;
    const y = (cur / w) | 0;
    out.push({ x, y });
    cur = prev[cur];
  }
  out.reverse();
  return out;
}

function heuristic(a, b, diag) {
  const dx = abs8(a.x - b.x);
  const dy = abs8(a.y - b.y);
  return diag ? octile(dx, dy) : dx + dy;
}

function octile(dx, dy) {
  const F = 1.41421356 - 1;
  return dx < dy ? F * dx + dy : F * dy + dx;
}
