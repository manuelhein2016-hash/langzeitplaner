// Ten fixed category tones (spec 4.5) — no free picker.
//
// Constraints each tone had to pass:
//   · distinguishable as a 6px bar lane and as 9px text tint
//   · ≥4.5:1 against #FFFFFF so note text stays legible at 9px
//   · print-safe on white (no neon, no pastel, nothing that dies at 6pt)
//   · readable on top of every ambient shade (#F2EEFC / #FAF8FE / #E6DEF8)
//
// The first five are the wireframe's own tones and keep their meaning.
// Hue is deliberately never the only channel: bars carry labels, notes carry
// their text, the legend carries names.

export const PALETTE = [
  { ref: 'blau',     hex: '#2A7CC0', de: 'Blau',     en: 'Blue' },
  { ref: 'gruen',    hex: '#5D9E33', de: 'Grün',     en: 'Green' },
  { ref: 'orange',   hex: '#D9820F', de: 'Orange',   en: 'Orange' },
  { ref: 'magenta',  hex: '#C41A6E', de: 'Magenta',  en: 'Magenta' },
  { ref: 'violett',  hex: '#6B45C9', de: 'Violett',  en: 'Violet' },
  { ref: 'tuerkis',  hex: '#0E8C8C', de: 'Türkis',   en: 'Teal' },
  { ref: 'rot',      hex: '#C6362B', de: 'Rot',      en: 'Red' },
  { ref: 'gold',     hex: '#A8801A', de: 'Gold',     en: 'Gold' },
  { ref: 'marine',   hex: '#1F3A73', de: 'Marine',   en: 'Navy' },
  { ref: 'schiefer', hex: '#5A6B7A', de: 'Schiefer', en: 'Slate' },
];

const byRef = new Map(PALETTE.map((p) => [p.ref, p]));

export const colorOf = (ref) => (byRef.get(ref) || PALETTE[0]).hex;
export const paletteName = (ref, lang) =>
  (byRef.get(ref) || PALETTE[0])[lang === 'en' ? 'en' : 'de'];

/** Next unused tone, so a new category never repeats a colour needlessly. */
export function nextFreeRef(usedRefs) {
  const used = new Set(usedRefs);
  return (PALETTE.find((p) => !used.has(p.ref)) || PALETTE[0]).ref;
}

/** 12%-alpha wash of a category tone, for popover rows and drag previews. */
export function tintOf(ref) {
  const hex = colorOf(ref);
  return hex + '1F';
}
