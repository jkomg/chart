// In-app PDF viewer. iPad Safari shows only the first page of an embedded PDF, so pages are
// drawn with PDF.js instead. Opened via #doc/<file>/<page>; Back returns to where you were.
const viewer = document.querySelector('.viewer');
const pagesEl = viewer.querySelector('.viewer-pages');
const titleEl = viewer.querySelector('.viewer-title b');
const pageEl = viewer.querySelector('.viewer-page');
const original = viewer.querySelector('.viewer-original');
let pdfjs, current = null, zoom = 1, observer, openedInApp = false, returnFocus = null;

async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('/static/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/pdf.worker.min.mjs';
  }
  return pdfjs;
}

async function open({ file, page }) {
  if (chart.mode === 'provider' && !chart.preparation?.isSourceIncluded(file)) {
    close();
    chart.go(chart.lastTab || 'goals');
    return;
  }
  const sameDoc = current && current.file === file;
  viewer.hidden = false;
  document.body.classList.add('viewer-open');
  if (!sameDoc) {
    returnFocus = returnFocus || document.activeElement;
    titleEl.textContent = file.replace(/\.pdf$/i, '').replace(/_/g, ' ');
    original.href = `/documents/${encodeURIComponent(file)}`;
    pagesEl.replaceChildren(Object.assign(document.createElement('p'), { className: 'viewer-status', textContent: 'Loading document…' }));
    pageEl.textContent = '';
    const token = {};
    current = { file, token, doc: null };
    try {
      const lib = await loadPdfjs();
      const doc = await lib.getDocument({ url: `/documents/${encodeURIComponent(file)}`, withCredentials: true }).promise;
      if (current.token !== token) return;
      current.doc = doc;
      await layout();
    } catch (err) {
      if (current.token !== token) return;
      pagesEl.replaceChildren(Object.assign(document.createElement('p'), { className: 'viewer-status', textContent: 'This document couldn’t be opened. Try “Original ↗”.' }));
      return;
    }
  }
  scrollToPage(page);
  viewer.querySelector('.viewer-back').focus({ preventScroll: true });
}

function close() {
  if (viewer.hidden) return;
  viewer.hidden = true;
  document.body.classList.remove('viewer-open');
  observer?.disconnect();
  current?.doc?.destroy();
  current = null;
  pagesEl.replaceChildren();
  returnFocus?.focus?.({ preventScroll: true });
  returnFocus = null;
}

async function layout() {
  const { doc } = current;
  observer?.disconnect();
  pagesEl.replaceChildren();
  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const fit = Math.min((pagesEl.clientWidth - 24) / base.width, 1.6);
  current.scale = fit * zoom;
  observer = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) draw(e.target); }), { root: pagesEl, rootMargin: '600px 0px' });
  for (let n = 1; n <= doc.numPages; n++) {
    const holder = document.createElement('div');
    holder.className = 'viewer-sheet';
    holder.dataset.page = n;
    holder.style.width = `${base.width * current.scale}px`;
    holder.style.height = `${base.height * current.scale}px`;  // refined when drawn; pages can differ in size
    holder.setAttribute('aria-label', `Page ${n} of ${doc.numPages}`);
    pagesEl.append(holder);
    observer.observe(holder);
  }
  updatePageLabel();
}

async function draw(holder) {
  if (holder.dataset.drawn === String(current.scale)) return;
  holder.dataset.drawn = String(current.scale);
  const page = await current.doc.getPage(Number(holder.dataset.page));
  const viewport = page.getViewport({ scale: current.scale });
  // Keep each canvas under iOS Safari's ~16.7M pixel canvas limit.
  const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16e6 / (viewport.width * viewport.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  holder.style.width = `${viewport.width}px`;
  holder.style.height = `${viewport.height}px`;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
  holder.replaceChildren(canvas);
}

function scrollToPage(n) {
  const target = pagesEl.querySelector(`[data-page="${Math.min(n, current?.doc?.numPages || 1)}"]`);
  if (target) pagesEl.scrollTop = target.offsetTop - 12;
  updatePageLabel();
}

function updatePageLabel() {
  if (!current?.doc) return;
  const sheets = [...pagesEl.querySelectorAll('.viewer-sheet')];
  const mid = pagesEl.scrollTop + pagesEl.clientHeight / 3;
  const visible = sheets.findLast(s => s.offsetTop <= mid) || sheets[0];
  pageEl.textContent = `Page ${visible?.dataset.page || 1} of ${current.doc.numPages}`;
}

pagesEl.addEventListener('scroll', () => requestAnimationFrame(updatePageLabel), { passive: true });
viewer.querySelector('.viewer-back').addEventListener('click', () => {
  if (openedInApp) history.back(); else chart.go(chart.lastTab || 'documents');
});
viewer.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', async () => {
  if (!current?.doc) return;
  const keep = Number(pageEl.textContent.match(/\d+/)?.[0] || 1);
  zoom = Math.min(3, Math.max(0.6, zoom * (b.dataset.zoom > 0 ? 1.25 : 0.8)));
  await layout();
  scrollToPage(keep);
}));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !viewer.hidden) viewer.querySelector('.viewer-back').click(); });
window.addEventListener('hashchange', e => { if (e.newURL.includes('#doc/') && !e.oldURL.includes('#doc/')) openedInApp = true; });

document.addEventListener('chart:doc', e => {
  if (e.detail) open(e.detail); else { close(); openedInApp = false; zoom = 1; }
});
document.addEventListener('chart:mode', e => {
  if (e.detail === 'provider' && current && !chart.preparation?.isSourceIncluded(current.file)) {
    close(); chart.go(chart.lastTab || 'goals');
  }
});
// The router ran before this module loaded; pick up a #doc/ link opened directly.
if (location.hash.startsWith('#doc/')) {
  const [, file, page] = decodeURIComponent(location.hash.slice(1)).match(/^doc\/(.+?)(?:\/(\d+))?$/) || [];
  if (file) open({ file, page: Number(page) || 1 });
}
