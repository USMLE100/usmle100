import { Icon } from './icons';
import { personSvg, type Look } from './people';
import { TESTIMONIALS, TESTIMONIAL_DISCLAIMER, type Testimonial } from './testimonials';
export { TESTIMONIALS };

/**
 * Homepage sections restored from the original V12 landing page (owner, 5 Nov 2026): the sliding "who we teach"
 * character cards and the two-row testimonial cards. Drawings, colors, card shapes and movement are V12's own.
 * Changes from V12, as the owner asked: her six labels; people redrawn with natural anatomy (see people.ts), all on
 * one frame so they match in size; each card holds its figure with only the head rising a little above the top
 * edge; the loop moves by exactly one set of cards, so it never jumps. With reduced motion the rows stop and
 * scroll by hand instead.
 */

type Who = { label: string; tint: string; look: Look };
export const WHO: Who[] = [
  { label: 'US Medical Students', tint: 'mint', look: { style: 'short', hair: '#2E2A26', skin: '#E8C9A8', shade: '#D4AE8B', top: '#2E936F', outfit: 'coat' } },
  { label: 'IMGs & FMGs', tint: 'blue', look: { style: 'long', hair: '#1F1B18', skin: '#C79068', shade: '#B07A55', top: '#8CB0B2', outfit: 'coat' } },
  { label: 'Repeat Takers', tint: 'pink', look: { style: 'side', hair: '#5A4632', skin: '#D9A880', shade: '#C08F67', top: '#956BAD', outfit: 'coat', glasses: true } },
  { label: 'CBSE & Comp Exam Students', tint: 'cream', look: { style: 'hijab', hair: '#4F6075', skin: '#EDD3B5', shade: '#D7B996', top: '#C6A673', outfit: 'coat' } },
  { label: 'Residency Applicants', tint: 'green', look: { style: 'curly', hair: '#2B1E15', skin: '#8D5B3C', shade: '#76492E', top: '#1B6549', outfit: 'coat', lip: '#5E3221' } },
  { label: 'USMLE Step 1, 2 & 3 Students', tint: 'mint', look: { style: 'bun', hair: '#232019', skin: '#A9714B', shade: '#93603D', top: '#EB8771', outfit: 'coat', lip: '#7A3E2A' } },
];
const FIG = WHO.map((w) => personSvg(w.look, 'hw-fig'));

const Tile = (p: { w: Who; i: number; copy?: boolean }) => (
  <a class="hw-tile" data-t={p.w.tint} href="/programs" data-copy={p.copy ? '' : undefined} aria-hidden={p.copy ? 'true' : undefined} tabindex={p.copy ? -1 : undefined}>
    <span class="hw-photo"><span class="hw-pop" dangerouslySetInnerHTML={{ __html: FIG[p.i % WHO.length] }} /></span>
    <span class="hw-cap"><span>{p.w.label}</span><Icon name="arrow_forward" class="gic" /></span>
  </a>
);

/** Sits across the bottom edge of the green hero, as in V12. */
export const WhoWeTeach = () => (
  <section class="hw-rail" aria-label="Who we teach">
    <div class="hw-track">
      {[0, 1, 2, 3].flatMap((r) => WHO.map((w, i) => <Tile w={w} i={r * WHO.length + i} copy={r > 0} />))}
    </div>
  </section>
);

// ---------- Testimonials ----------

// Testimonial portraits: the six students redrawn in everyday clothes, on V12's tile colors. They are illustrations,
// not likenesses of the students quoted.
const PORTRAITS: { tint: string; svg: string }[] = [
  { tint: 'sage', look: { style: 'short', hair: '#2E2A26', skin: '#E8C9A8', shade: '#D4AE8B', top: '#2E936F', outfit: 'casual' } },
  { tint: 'olive', look: { style: 'long', hair: '#1F1B18', skin: '#C79068', shade: '#B07A55', top: '#8CB0B2', outfit: 'casual' } },
  { tint: 'stone', look: { style: 'curly', hair: '#2B1E15', skin: '#8D5B3C', shade: '#76492E', top: '#956BAD', outfit: 'casual', lip: '#5E3221' } },
  { tint: 'mist', look: { style: 'hijab', hair: '#9C6B7A', skin: '#EDD3B5', shade: '#D7B996', top: '#C6A673', outfit: 'casual' } },
  { tint: 'sage', look: { style: 'side', hair: '#5A4632', skin: '#D9A880', shade: '#C08F67', top: '#1B6549', outfit: 'casual', glasses: true } },
  { tint: 'stone', look: { style: 'bun', hair: '#232019', skin: '#A9714B', shade: '#93603D', top: '#EB8771', outfit: 'casual', lip: '#7A3E2A' } },
].map((p) => ({ tint: p.tint, svg: personSvg(p.look as Look) }));
const CARD_TINTS = ['mint', 'grey', 'cream', 'blue', 'pink', 'grey'];

const PortraitTile = (p: { k: number; copy?: boolean }) => {
  const pt = PORTRAITS[p.k % PORTRAITS.length];
  return <div class="hv-photo" data-t={pt.tint} aria-hidden="true" data-copy={p.copy ? '' : undefined} dangerouslySetInnerHTML={{ __html: pt.svg }} />;
};

/** A card shows the start of the testimonial; "Read more" opens the whole of it. The full text is always in the page. */
const Quote = (p: { t: Testimonial; tint: string; id: string; copy?: boolean }) => (
  <figure class="hv-card" data-t={p.tint} aria-hidden={p.copy ? 'true' : undefined} data-copy={p.copy ? '' : undefined}>
    <figcaption class="hv-who"><span class="hv-name">{p.t.name}</span><span class="sr-only">, </span><span class="hv-school">{p.t.school}</span></figcaption>
    <blockquote class="hv-text" id={p.copy ? undefined : p.id}>“{p.t.quote}”</blockquote>
    <button type="button" class="hv-more" data-hv={p.id} tabindex={p.copy ? -1 : undefined}>Read more<span class="sr-only"> from {p.t.name}</span></button>
  </figure>
);

// One shared window for "Read more"; the moving rows pause while it is open.
const MORE_JS = `(function(){var d=document.getElementById('hv-dialog');if(!d||!d.showModal)return;var m=document.querySelector('.hv-marq');
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.hv-more');if(!b)return;var src=document.getElementById(b.getAttribute('data-hv'));if(!src)return;
var card=src.closest('.hv-card');d.querySelector('.hv-dname').textContent=card.querySelector('.hv-name').textContent;d.querySelector('.hv-dschool').textContent=card.querySelector('.hv-school').textContent;
d.querySelector('.hv-dtext').textContent=src.textContent;if(m)m.classList.add('hv-paused');d.showModal();});
d.addEventListener('close',function(){if(m)m.classList.remove('hv-paused')});d.addEventListener('click',function(e){if(e.target===d)d.close()});
document.documentElement.classList.add('hv-js')})();`;

/** Two rows moving in opposite directions, each quote beside its own portrait (row A quote first, row B portrait first, as in V12). */
export const Testimonials = (p: { items?: Testimonial[] }) => {
  const items = p.items ?? TESTIMONIALS;
  if (!items.length) return null;
  const half = Math.ceil(items.length / 2);
  const rows = [items.slice(0, half), items.slice(half).length ? items.slice(half) : items.slice(0, half)];
  // Each half of a row repeats these same testimonials until it is wider than any screen (~2100px), so the loop never shows a gap.
  const reps = (list: Testimonial[]) => Math.max(1, Math.ceil(2100 / (list.length * 720)));
  const row = (list: Testimonial[], r: number) =>
    Array.from({ length: reps(list) * 2 }, (_, rep) =>
      list.flatMap((t, i) => {
        const k = r * half + i;
        const copy = rep > 0;
        const q = <Quote t={t} tint={CARD_TINTS[k % CARD_TINTS.length]} id={`hv-q${k}`} copy={copy} />;
        const ph = <PortraitTile k={t.portrait} copy={copy} />;
        return r === 0 ? [q, ph] : [ph, q];
      }),
    ).flat();
  return (
    <section class="hv" aria-labelledby="hv-head">
      <p class="hv-kick">Student experiences</p>
      <h2 class="hv-head" id="hv-head">In Our <em>Students’ Words</em></h2>
      <div class="hv-marq">
        {rows.map((list, r) => <div class={`hv-row ${r ? 'b' : 'a'}`}>{row(list, r)}</div>)}
      </div>
      <p class="hv-note">{TESTIMONIAL_DISCLAIMER}</p>
      <dialog id="hv-dialog" class="hv-dialog" aria-labelledby="hv-dname">
        <form method="dialog"><button class="hv-close" aria-label="Close">×</button></form>
        <p class="hv-who"><span class="hv-name hv-dname" id="hv-dname"></span><span class="hv-school hv-dschool"></span></p>
        <p class="hv-dtext"></p>
      </dialog>
      <script dangerouslySetInnerHTML={{ __html: MORE_JS }} />
    </section>
  );
};
