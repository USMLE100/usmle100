import { Icon } from './icons';

/**
 * Homepage sections restored from the original V12 landing page (owner, 5 Nov 2026): the sliding "who we teach"
 * character cards and the two-row testimonial cards. Drawings, colors, card shapes and movement are V12's own.
 * Changes from V12, as the owner asked: her six labels; every figure drawn on the same frame so all six read the
 * same size; the heads pop above the card with room to spare, so nothing clips them; the loop moves by exactly
 * one set of cards, so it never jumps. With reduced motion the rows stop and scroll by hand instead.
 */

type Who = { label: string; tint: string; hair: 'short' | 'long' | 'curly' | 'wrap'; hairColor: string; skin: string; shade: string; body: string };
export const WHO: Who[] = [
  { label: 'US Medical Students', tint: 'mint', hair: 'short', hairColor: '#2E2A26', skin: '#E8C9A8', shade: '#D9B894', body: '#2E936F' },
  { label: 'IMGs & FMGs', tint: 'blue', hair: 'long', hairColor: '#1F1B18', skin: '#C79068', shade: '#B57F58', body: '#8CB0B2' },
  { label: 'Repeat Takers', tint: 'pink', hair: 'curly', hairColor: '#3A2A1E', skin: '#8D5B3C', shade: '#7C4E31', body: '#956BAD' },
  { label: 'CBSE & Comp Exam Students', tint: 'cream', hair: 'wrap', hairColor: '#4A3426', skin: '#EDD3B5', shade: '#DCC0A0', body: '#C6A673' },
  { label: 'Residency Applicants', tint: 'green', hair: 'short', hairColor: '#5A4632', skin: '#D9A880', shade: '#C7956D', body: '#1B6549' },
  { label: 'USMLE Step 1, 2 & 3 Students', tint: 'mint', hair: 'long', hairColor: '#232019', skin: '#A9714B', shade: '#96613E', body: '#EB8771' },
];

// V12's hair shapes, each held to the same outline as the head (x 44–106, top at y 34) so no figure looks bigger.
const HAIR: Record<Who['hair'], string> = {
  short: 'M46 68 c0-22 13-34 29-34 s29 12 29 34 c0-12-12-18-29-18 s-29 6-29 18Z',
  long: 'M44 70 c0-24 14-36 31-36 s31 12 31 36 v52 c-6 2-9-6-9-18 l-2-26 c-10 8-30 10-42 2 l-2 24 c0 12-3 20-9 18Z',
  curly: 'M46 68 c-2-17 8-34 29-34 s31 17 29 34 c-3-6-8-8-12-6 c-3-8-10-10-17-8 c-7-2-14 0-17 8 c-4-2-9 0-12 6Z',
  wrap: 'M44 72 c0-25 14-38 31-38 s31 13 31 38 c0 9-3 15-7 15 l-4-29 c-12 6-34 6-42-2 l-4 31 c-4 0-5-7-5-15Z',
};

const Figure = (p: { w: Who; id: string }) => (
  <svg viewBox="0 0 150 200" class="hw-fig" aria-hidden="true">
    <defs><clipPath id={p.id}><path d="M75 8 c34 0 58 24 58 56 v136 H17 V64 c0-32 24-56 58-56Z" /></clipPath></defs>
    <g clip-path={`url(#${p.id})`}>
      <path d="M75 118 c38 0 68 26 72 60 l4 30 H-1 l4-30 c4-34 34-60 72-60Z" fill={p.w.body} />
      <path d="M62 120 l13 20 13-20 c-8-4-18-4-26 0Z" fill="#FFFFFF" opacity=".85" />
      <path d="M63 96 h24 v30 c0 8-24 8-24 0Z" fill={p.w.shade} />
      <ellipse cx="75" cy="72" rx="29" ry="34" fill={p.w.skin} />
      <path d={HAIR[p.w.hair]} fill={p.w.hairColor} />
    </g>
  </svg>
);

const Tile = (p: { w: Who; i: number; copy?: boolean }) => (
  <a class="hw-tile" data-t={p.w.tint} href="/programs" data-copy={p.copy ? '' : undefined} aria-hidden={p.copy ? 'true' : undefined} tabindex={p.copy ? -1 : undefined}>
    <span class="hw-photo"><span class="hw-pop"><Figure w={p.w} id={`hw${p.i}`} /></span></span>
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

type Portrait = { tint: string; skin: string; shade: string; hairColor: string; body: string };
const PORTRAITS: Portrait[] = [
  { tint: 'sage', skin: '#E8C9A8', shade: '#D9B894', hairColor: '#2E2A26', body: '#2E936F' },
  { tint: 'olive', skin: '#C79068', shade: '#B57F58', hairColor: '#1F1B18', body: '#8CB0B2' },
  { tint: 'stone', skin: '#8D5B3C', shade: '#7C4E31', hairColor: '#3A2A1E', body: '#956BAD' },
  { tint: 'mist', skin: '#EDD3B5', shade: '#DCC0A0', hairColor: '#4A3426', body: '#C6A673' },
  { tint: 'sage', skin: '#D9A880', shade: '#C7956D', hairColor: '#5A4632', body: '#1B6549' },
  { tint: 'stone', skin: '#A9714B', shade: '#96613E', hairColor: '#232019', body: '#EB8771' },
];
const CARD_TINTS = ['mint', 'grey', 'cream', 'blue', 'pink', 'grey'];
const P_HAIR = [
  'M45 68 c0-23 13-36 30-36 s30 13 30 36 c-4-14-16-20-30-20 s-26 6-30 20Z',
  'M44 70 c0-24 14-36 31-36 s31 12 31 36 v48 c-6 2-9-6-9-18 l-2-24 c-10 8-30 10-42 2 l-2 22 c0 12-3 20-9 18Z',
];
const PortraitTile = (p: { pt: Portrait; long: boolean; copy?: boolean }) => (
  <div class="hv-photo" data-t={p.pt.tint} aria-hidden="true" data-copy={p.copy ? '' : undefined}>
    <svg viewBox="0 0 150 190" aria-hidden="true">
      <ellipse cx="75" cy="150" rx="62" ry="70" fill={p.pt.body} />
      <path d="M63 92 h24 v34 c0 9-24 9-24 0Z" fill={p.pt.shade} />
      <ellipse cx="75" cy="70" rx="30" ry="35" fill={p.pt.skin} />
      <path d={P_HAIR[p.long ? 1 : 0]} fill={p.pt.hairColor} />
    </svg>
  </div>
);
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
        const ph = <PortraitTile pt={PORTRAITS[k % PORTRAITS.length]} long={r === 1} copy={copy} />;
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
