import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../web/style.css', import.meta.url), 'utf8');

/**
 * The custom properties declared inside one `[attr=value] { … }` rule. The
 * stylesheet is the single source of every hex in the palette — duplicating
 * the tables here would let the two drift and the test would still pass.
 */
function block(selector: string): Record<string, string> {
  const m = css.match(new RegExp(`\\[${selector}\\]\\s*\\{([^}]*)\\}`));
  assert.ok(m, `no rule for [${selector}] in web/style.css`);
  return Object.fromEntries(
    [...m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]),
  );
}

/** WCAG 2.x relative luminance of a `#rrggbb` string. */
function luminance(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The canvas blocks alias two accent names rather than restating the hexes. */
const deref = (value: string, accent: Record<string, string>): string =>
  value.startsWith('var(') ? accent[value.slice(4, -1)] : value;

const ACCENTS = ['clay', 'coral', 'ochre', 'moss', 'fern', 'teal', 'slate', 'indigo', 'plum', 'mulberry'];
const CANVASES = [
  'cream', 'linen', 'shell', 'mist', 'porcelain', 'bone',
  'obsidian', 'umber', 'ember', 'pine', 'midnight', 'graphite',
];
// Every floor text can land on. On the light canvases --surface is *darker*
// than --canvas (cards sit down, menus float up), so checking --canvas alone
// checks the one surface almost no text is drawn on.
const SURFACES = ['--canvas', '--surface', '--surface-2', '--well'];

// --accent itself — the raw identity colour, read only by .swatch — is never
// measured against anything here; only --accent-deep and --accent-lift are,
// via --accent-text/--accent-line below. Against --surface-2 on Cream, fern
// measures 2.95. Acceptable by design: WCAG 1.4.11 exempts graphics whose
// specific presentation is essential to the information, and a colour swatch
// is the canonical example — you cannot darken fern to pass a contrast check
// and still have it be fern. The part that *is* a state indicator — which
// swatch is selected — is the .swatch-btn.on ring painted in --accent-line,
// and that is measured at >=3:1 below.
test('every accent stays legible on every canvas', () => {
  for (const a of ACCENTS) {
    const accent = block(`data-accent=${a}`);
    const white = ratio(accent['--accent-deep'], '#ffffff');
    assert.ok(white >= 4.5, `${a}: white button label on --accent-deep is ${white.toFixed(2)}`);
    for (const c of CANVASES) {
      const canvas = block(`data-canvas=${c}`);
      const text = deref(canvas['--accent-text'], accent);
      const line = deref(canvas['--accent-line'], accent);
      for (const s of SURFACES) {
        const t = ratio(text, canvas[s]);
        assert.ok(t >= 4.5, `${a} link on ${c} ${s} is ${t.toFixed(2)}`);
        const l = ratio(line, canvas[s]);
        assert.ok(l >= 3, `${a} ring on ${c} ${s} is ${l.toFixed(2)}`);
      }
    }
  }
});

test('every canvas keeps its own text and status colours legible', () => {
  const TEXT = ['--ink', '--body', '--muted', '--working', '--needs', '--done', '--stopped', '--error'];
  // .ref pills paint --canvas on a fill of the lane's colour (see .ref > span).
  const FILLS = ['--lane-a', '--lane-b', '--working', '--needs', '--done', '--stopped', '--error'];
  for (const c of CANVASES) {
    const canvas = block(`data-canvas=${c}`);
    for (const t of TEXT) {
      for (const s of SURFACES) {
        const r = ratio(canvas[t], canvas[s]);
        assert.ok(r >= 4.5, `${c}: ${t} on ${s} is ${r.toFixed(2)}`);
      }
    }
    for (const f of FILLS) {
      const r = ratio(canvas['--canvas'], canvas[f]);
      assert.ok(r >= 4.5, `${c}: ref pill label on ${f} is ${r.toFixed(2)}`);
    }
    // --hover itself is never measured as the floor it is — only as this one
    // background. It is also what [aria-selected=true] rows and .menu
    // button:hover paint over, and across all four canvases it measures 1.085
    // to 1.361 against the surface beneath it there — nowhere near the 3:1
    // WCAG 1.4.11 asks of a component state. Known and deliberate: closing it
    // means retuning --hover per canvas, considered and declined as larger
    // than this branch should carry.
    for (const [fg, bg] of [['--needs', '--warn-bg'], ['--error', '--error-bg'], ['--body', '--hover']]) {
      const r = ratio(canvas[fg], canvas[bg]);
      assert.ok(r >= 4.5, `${c}: ${fg} on ${bg} is ${r.toFixed(2)}`);
    }
  }
});

// A color-mix() would collapse the accent table from 24 values to 8, but
// nothing in Node can resolve one, so every assertion above would silently
// have nothing to measure and this file would pass while the app was
// illegible. The 8-digit form is allowed for --shadow, which carries alpha and
// is not measured.
test('the palette is literal hexes, so this test has something to measure', () => {
  for (const a of ACCENTS) {
    for (const [k, v] of Object.entries(block(`data-accent=${a}`))) {
      assert.match(v, /^#[0-9a-f]{6}$/, `${a} ${k} is not a literal hex`);
    }
  }
  for (const c of CANVASES) {
    for (const [k, v] of Object.entries(block(`data-canvas=${c}`))) {
      assert.match(v, /^(#[0-9a-f]{6}|#[0-9a-f]{8}|var\(--accent(?:-deep|-lift)?\))$/, `${c} ${k} is not a literal hex`);
    }
  }
});
