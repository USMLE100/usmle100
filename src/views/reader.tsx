/**
 * View-only Course Book reader (R005–R007). Pages are drawn on canvases with the student's name and account
 * number across every page and the reading-session code in the corner, so a screenshot or photo carries them.
 * There is no text layer (no copying), no download or print, and the chapter arrives scrambled for this one session.
 */
export const BookReader = (p: { chapterId: number; session: string; secret: string; name: string; account: number; title: string }) => (
  <div class="book-reader" id="reader" data-chapter={String(p.chapterId)} data-session={p.session} data-key={p.secret} data-name={p.name} data-account={String(p.account)}>
    <div class="br-bar">
      <span class="br-status" role="status">Opening the chapter…</span>
      <span style="flex:1"></span>
      <button type="button" class="btn btn-outline btn-sm" data-zoom="-1" aria-label="Smaller">−</button>
      <span class="br-zoom">100%</span>
      <button type="button" class="btn btn-outline btn-sm" data-zoom="1" aria-label="Larger">+</button>
    </div>
    <div class="br-pages" aria-label={p.title}></div>
    <script type="module" dangerouslySetInnerHTML={{ __html: READER_JS }} />
  </div>
);

const READER_JS = `
import * as pdfjs from '/vendor/pdfjs-5.7.284/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-5.7.284/pdf.worker.min.mjs';
const root = document.getElementById('reader');
const { chapter, session, key, name, account } = root.dataset;
const status = root.querySelector('.br-status'), pagesEl = root.querySelector('.br-pages'), zoomEl = root.querySelector('.br-zoom');
const mark = name + ' · ID ' + account;
let zoom = 1, pdf = null;
const k = new Uint8Array(key.match(/../g).map((h) => parseInt(h, 16)));
try {
  const res = await fetch('/course-book/' + chapter + '/data?s=' + encodeURIComponent(session), { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 410 ? 'expired' : 'failed');
  const buf = new Uint8Array(await res.arrayBuffer());
  for (let i = 0; i < buf.length; i++) buf[i] ^= k[i & 31] ^ ((i * 7) & 255);
  pdf = await pdfjs.getDocument({ data: buf, isEvalSupported: false, enableXfa: false }).promise;
  status.textContent = pdf.numPages + ' page' + (pdf.numPages === 1 ? '' : 's') + ' · for ' + name + ' only';
  await layout();
} catch (e) {
  status.textContent = e && e.message === 'expired' ? 'This reading session has ended. Reload the page to open the chapter again.' : 'The chapter could not be opened. Reload the page to try again.';
}
async function layout() {
  pagesEl.innerHTML = '';
  const width = Math.min(pagesEl.clientWidth || 800, 1000) * zoom;
  const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting && !en.target.dataset.done) { en.target.dataset.done = '1'; draw(en.target); } }), { rootMargin: '600px 0px' });
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const box = document.createElement('div');
    box.className = 'br-page';
    box.dataset.n = n;
    box.style.width = width + 'px';
    box.style.height = Math.round((width * vp.height) / vp.width) + 'px';
    pagesEl.appendChild(box);
    io.observe(box);
  }
}
async function draw(box) {
  const n = +box.dataset.n;
  const page = await pdf.getPage(n);
  const cssW = parseFloat(box.style.width);
  const vp0 = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: (cssW / vp0.width) * dpr });
  const cv = document.createElement('canvas');
  cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
  cv.style.width = '100%'; cv.style.height = '100%';
  const ctx = cv.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  // Watermark drawn into the page image itself.
  const W = cv.width, H = cv.height, fs = Math.max(14, Math.round(W / 34));
  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.rotate(-Math.PI / 6);
  ctx.font = '600 ' + fs + 'px system-ui, sans-serif'; ctx.fillStyle = 'rgba(40, 40, 40, 0.09)'; ctx.textAlign = 'center';
  const stepY = fs * 5, stepX = ctx.measureText(mark).width + fs * 3;
  for (let y = -H; y < H; y += stepY) for (let x = -W; x < W; x += stepX) ctx.fillText(mark, x + ((y / stepY) % 2 ? stepX / 2 : 0), y);
  ctx.restore();
  ctx.font = '500 ' + Math.round(fs * 0.55) + 'px system-ui, sans-serif'; ctx.fillStyle = 'rgba(40, 40, 40, 0.45)'; ctx.textAlign = 'right';
  ctx.fillText(mark + ' · Session ' + session + ' · p. ' + n, W - fs * 0.6, H - fs * 0.6);
  box.appendChild(cv);
}
root.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
  if (!pdf) return;
  zoom = Math.max(0.6, Math.min(2.5, zoom + 0.25 * +b.dataset.zoom));
  zoomEl.textContent = Math.round(zoom * 100) + '%';
  layout();
}));
root.addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && /^[spc]$/i.test(e.key)) e.preventDefault(); });
`;
