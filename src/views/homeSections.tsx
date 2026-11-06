import { Icon } from './icons';
import { personSvg, type Look } from './people';

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

/** Real testimonials only, each approved by the owner with the student's consent. Empty = the section is not shown. */
export type Testimonial = { name: string; quote: string };
export const TESTIMONIALS: Testimonial[] = [];

// Testimonial portraits: the same people drawn in everyday clothes, on V12's tile colors.
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
const Quote = (p: { t: Testimonial; tint: string; copy?: boolean }) => (
  <figure class="hv-card" data-t={p.tint} aria-hidden={p.copy ? 'true' : undefined} data-copy={p.copy ? '' : undefined}>
    <figcaption class="hv-name">{p.t.name}</figcaption>
    <blockquote>“{p.t.quote}”</blockquote>
  </figure>
);

/** Two rows moving in opposite directions: quote, portrait, quote, portrait… (V12 row A starts with a quote, row B with a portrait). */
export const Testimonials = (p: { items?: Testimonial[] }) => {
  const items = p.items ?? TESTIMONIALS;
  if (!items.length) return null;
  const half = Math.ceil(items.length / 2);
  const rows = [items.slice(0, half), items.slice(half).length ? items.slice(half) : items.slice(0, half)];
  // Each half of a row is repeated until it is wider than any screen (~2100px), so the loop never shows a gap.
  const reps = (list: Testimonial[]) => Math.max(1, Math.ceil(2100 / (list.length * 700)));
  const row = (list: Testimonial[], r: number) => {
    const n = reps(list) * 2;
    return Array.from({ length: n }, (_, rep) =>
      list.flatMap((t, i) => {
        const k = r * half + i;
        const copy = rep > 0;
        const q = <Quote t={t} tint={CARD_TINTS[k % CARD_TINTS.length]} copy={copy} />;
        const ph = <PortraitTile k={k} copy={copy} />;
        return r === 0 ? [q, ph] : [ph, q];
      }),
    ).flat();
  };
  return (
    <section class="hv" aria-labelledby="hv-head">
      <p class="hv-kick">Those who chose USMLE100</p>
      <h2 class="hv-head" id="hv-head">There’s a reason students are <em>raving about us</em>.</h2>
      <div class="hv-marq">
        {rows.map((list, r) => (
          <div class={`hv-row ${r ? 'b' : 'a'}`}>
            {row(list, r)}
          </div>
        ))}
      </div>
    </section>
  );
};
