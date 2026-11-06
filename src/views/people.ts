/**
 * Flat illustrations of people for the homepage (owner, 5 Nov 2026): a head with a face, ears, neck, sloping
 * shoulders and arms. Students wear a white coat over scrubs with a stethoscope; testimonial portraits wear a
 * sweater. Every figure shares one frame (viewBox 0 0 200 222), so all are the same size and sit at the same height.
 */
export type Look = {
  style: 'short' | 'side' | 'long' | 'bun' | 'curly' | 'hijab';
  hair: string; skin: string; shade: string; top: string;
  outfit: 'coat' | 'casual'; glasses?: boolean; lip?: string;
};

const CURLS: [number, number][] = [[68, 84], [66, 70], [72, 58], [82, 50], [94, 45], [106, 45], [118, 50], [128, 58], [134, 70], [132, 84], [80, 62], [100, 56], [120, 62]];
const BODY = 'M100 136 C82 136 64 141 50 148 C34 156 26 170 22 190 L17 222 H183 L178 190 C174 170 166 156 150 148 C136 141 118 136 100 136Z';

export function personSvg(o: Look, cls = ''): string {
  const { skin, shade, hair, top, style, outfit } = o;
  const lip = o.lip ?? '#B5654F';
  const s: string[] = [];
  if (style === 'long') s.push(`<path d="M62 92 C58 60 78 42 100 42 C122 42 142 60 138 92 C140 116 146 140 150 162 C136 168 122 166 114 158 L112 118 L88 118 L86 158 C78 166 64 168 50 162 C54 140 60 116 62 92Z" fill="${hair}"/>`);
  if (style === 'bun') s.push(`<circle cx="100" cy="42" r="13" fill="${hair}"/>`);
  if (outfit === 'coat') {
    s.push(`<path d="${BODY}" fill="#F7F6F2"/>`);
    s.push(`<path d="M82 140 C90 146 110 146 118 140 L130 222 H70Z" fill="${top}"/>`);
    s.push('<path d="M86 141 C92 152 108 152 114 141" fill="none" stroke="#000" stroke-opacity=".16" stroke-width="2.6" stroke-linecap="round"/>');
    s.push('<path d="M82 139 L70 150 L84 176 L70 222 H64 C64 190 66 166 70 150Z" fill="#ECEAE4"/><path d="M82 139 L92 160 L84 176 L70 150Z" fill="#F7F6F2"/>');
    s.push('<path d="M118 139 L130 150 L116 176 L130 222 H136 C136 190 134 166 130 150Z" fill="#ECEAE4"/><path d="M118 139 L108 160 L116 176 L130 150Z" fill="#F7F6F2"/>');
    s.push('<path d="M46 162 C42 182 40 202 40 222 M154 162 C158 182 160 202 160 222" fill="none" stroke="#DEDBD3" stroke-width="2.4" stroke-linecap="round"/>');
    s.push(`<path d="M134 186 H156 V200 C156 203 154 204 152 204 H138 C136 204 134 203 134 200Z" fill="#ECEAE4"/><rect x="139" y="178" width="3" height="12" rx="1.5" fill="${top}"/>`);
  } else {
    s.push(`<path d="${BODY}" fill="${top}"/>`);
    s.push('<path d="M46 162 C42 182 40 202 40 222 M154 162 C158 182 160 202 160 222" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="2.4" stroke-linecap="round"/>');
  }
  if (style !== 'hijab') {
    s.push(`<path d="M88 112 V138 C92 146 108 146 112 138 V112Z" fill="${shade}"/>`);
    if (outfit === 'casual') s.push('<path d="M84 140 C90 150 110 150 116 140" fill="none" stroke="#000" stroke-opacity=".14" stroke-width="3" stroke-linecap="round"/>');
  }
  if (outfit === 'coat') {
    s.push('<path d="M84 141 C76 156 78 172 92 182 M116 141 C124 156 122 172 108 182" fill="none" stroke="#3B4A55" stroke-width="3.2" stroke-linecap="round"/>');
    s.push('<path d="M92 182 C96 186 104 186 108 182" fill="none" stroke="#3B4A55" stroke-width="3.2" stroke-linecap="round"/><path d="M100 185 V190" stroke="#3B4A55" stroke-width="3"/><circle cx="100" cy="196" r="6.5" fill="#B9C3CA" stroke="#3B4A55" stroke-width="2.4"/>');
  }
  if (style === 'hijab') {
    s.push(`<path d="M100 40 C128 40 144 60 145 88 C146 108 142 124 140 136 C152 142 160 150 164 160 C150 168 128 172 100 172 C72 172 50 168 36 160 C40 150 48 142 60 136 C58 124 54 108 55 88 C56 60 72 40 100 40Z" fill="${hair}"/>`);
    s.push('<path d="M60 137 C74 150 92 156 112 154 M140 137 C134 146 126 151 116 154" fill="none" stroke="#000" stroke-opacity=".14" stroke-width="2.4" stroke-linecap="round"/>');
  } else {
    s.push(`<ellipse cx="67" cy="92" rx="6" ry="9" fill="${shade}"/><ellipse cx="133" cy="92" rx="6" ry="9" fill="${shade}"/>`);
  }
  s.push(`<path d="M100 50 C121 50 134 66 134 88 C134 112 120 128 100 128 C80 128 66 112 66 88 C66 66 79 50 100 50Z" fill="${skin}"/>`);
  if (style === 'hijab') {
    s.push(`<path d="M100 46 C124 46 138 64 138 90 C136 70 122 57 100 57 C78 57 64 70 62 90 C62 64 76 46 100 46Z" fill="${hair}"/>`);
    s.push(`<path d="M66 100 C70 120 84 132 100 132 C116 132 130 120 134 100 C134 124 120 138 100 138 C80 138 66 124 66 100Z" fill="${hair}"/>`);
  }
  if (style === 'short') s.push(`<path d="M66 90 C62 62 78 44 102 44 C126 44 140 62 134 90 C132 76 126 68 118 64 C108 72 86 72 74 66 C70 72 67 80 66 90Z" fill="${hair}"/>`);
  if (style === 'side') s.push(`<path d="M66 92 C60 62 80 42 104 44 C128 46 140 64 134 92 C130 74 120 64 106 62 C96 70 80 70 70 70 C68 76 67 84 66 92Z" fill="${hair}"/><path d="M106 62 C96 58 84 62 76 70" fill="none" stroke="#000" stroke-opacity=".18" stroke-width="2"/>`);
  if (style === 'long') s.push(`<path d="M64 96 C60 62 80 46 100 46 C122 46 140 62 136 96 C130 74 116 62 100 62 C90 70 76 78 64 96Z" fill="${hair}"/>`);
  if (style === 'bun') s.push(`<path d="M65 92 C62 62 80 46 100 46 C120 46 138 62 135 92 C130 72 116 62 100 62 C84 62 70 72 65 92Z" fill="${hair}"/>`);
  if (style === 'curly') s.push(CURLS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="12" fill="${hair}"/>`).join(''));
  s.push(`<path d="M80 84 Q87 80 94 84 M106 84 Q113 80 120 84" fill="none" stroke="${style === 'hijab' ? '#3A2A1E' : hair}" stroke-width="2.6" stroke-linecap="round"/>`);
  s.push('<ellipse cx="87" cy="93" rx="3.2" ry="3.8" fill="#2B211C"/><ellipse cx="113" cy="93" rx="3.2" ry="3.8" fill="#2B211C"/><circle cx="88.2" cy="91.8" r="1" fill="#fff"/><circle cx="114.2" cy="91.8" r="1" fill="#fff"/>');
  s.push(`<path d="M101 97 Q97 106 100 108" fill="none" stroke="${shade}" stroke-width="2.4" stroke-linecap="round"/>`);
  s.push(`<path d="M91 114 Q100 121 109 114" fill="none" stroke="${lip}" stroke-width="2.6" stroke-linecap="round"/>`);
  s.push('<circle cx="80" cy="106" r="5.5" fill="#E8826B" opacity=".18"/><circle cx="120" cy="106" r="5.5" fill="#E8826B" opacity=".18"/>');
  if (o.glasses) s.push('<g fill="none" stroke="#2B2B2B" stroke-width="2.4"><rect x="76" y="85" width="20" height="16" rx="6"/><rect x="104" y="85" width="20" height="16" rx="6"/><path d="M96 92 H104 M76 90 L68 88 M124 90 L132 88"/></g>');
  return `<svg viewBox="0 0 200 222" class="${cls}" aria-hidden="true" focusable="false">${s.join('')}</svg>`;
}
