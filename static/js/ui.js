// DOM helpers, the shared tooltip, theme and colour utilities.
// Text only ever enters the DOM through text nodes: dataset strings are untrusted.

const SVG_NS = "http://www.w3.org/2000/svg";

/** h('div', {class:'x', onclick}, 'text', child...) ; 'svg:rect' makes SVG nodes. */
export function h(tag, props, ...kids) {
  const svg = tag.startsWith("svg:");
  const el = svg ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "style" && typeof v === "object") {
      // Custom properties (--x) only work through setProperty, not assignment.
      for (const [p, val] of Object.entries(v)) {
        if (val == null) continue;
        if (p.startsWith("--")) el.style.setProperty(p, val); else el.style[p] = val;
      }
    }
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------- theme

const THEME_KEY = "rt-theme";

export function resolvedTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage blocked: fine */ }
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!document.documentElement.dataset.theme) window.dispatchEvent(new Event("themechange"));
  });
}

export function toggleTheme() {
  const next = resolvedTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  window.dispatchEvent(new Event("themechange"));
}

// ---------------------------------------------------------------- colour
// Hexes are the documented blue ramp (steps 100..700), see the dataviz palette.

const BLUE = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5",
  "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];

// Ordinal ramps (validated with --ordinal in both modes). Light: more = darker.
// Dark flips the anchor: more = lighter, never darker than step 600.
const ORDINAL = {
  light: { 4: ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"], 5: ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"] },
  dark: { 4: ["#184f95", "#2a78d6", "#5598e7", "#9ec5f4"], 5: ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"] },
};

export const ordinalRamp = (n) => ORDINAL[resolvedTheme()][n];

const hex2rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgb2hex = (rgb) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** Sequential colour for t in 0..1 (0 recedes toward the surface, in either theme). */
export function seqColor(t) {
  const u = Math.min(1, Math.max(0, resolvedTheme() === "dark" ? 1 - t : t)) * (BLUE.length - 1);
  const i = Math.min(BLUE.length - 2, Math.floor(u)), f = u - i;
  const a = hex2rgb(BLUE[i]), b = hex2rgb(BLUE[i + 1]);
  return rgb2hex(a.map((v, k) => v + (b[k] - v) * f));
}

const luminance = (hex) => {
  const [r, g, b] = hex2rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Label ink for text set inside a fill: white or near-black, whichever contrasts more. */
export function inkOn(hex) {
  const L = luminance(hex);
  return (1.05) / (L + 0.05) >= (L + 0.05) / (luminance("#0b0b0b") + 0.05) ? "#ffffff" : "#0b0b0b";
}

/** Read a CSS custom property off the root (e.g. '--t0') as a concrete colour. */
export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------------------------------------------------------------- tooltip

let tipEl;

function tip() {
  if (!tipEl) {
    tipEl = h("div", { class: "tip", role: "tooltip", hidden: true });
    document.body.append(tipEl);
  }
  return tipEl;
}

/**
 * spec: {title?, rows?: [{color?, label, value}], note?}
 * Values lead, labels follow; series are keyed by a short line, not a box.
 */
function fill(spec) {
  const t = tip();
  t.replaceChildren();
  if (typeof spec === "string") spec = { title: spec };
  if (spec.title) t.append(h("div", { class: "tip-title" }, spec.title));
  for (const r of spec.rows || []) {
    t.append(h("div", { class: "tip-row" },
      r.color ? h("span", { class: "tip-key", style: { background: r.color } }) : h("span", { class: "tip-key none" }),
      h("span", { class: "tip-val" }, r.value),
      h("span", { class: "tip-lab" }, r.label)));
  }
  if (spec.note) t.append(h("div", { class: "tip-note" }, spec.note));
}

export function showTip(spec, x, y) {
  const t = tip();
  fill(spec);
  t.hidden = false;
  const pad = 12, { width, height } = t.getBoundingClientRect();
  let left = x + pad, top = y + pad;
  if (left + width > innerWidth - 8) left = Math.max(8, x - pad - width);
  if (top + height > innerHeight - 8) top = Math.max(8, y - pad - height);
  t.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

export const hideTip = () => { if (tipEl) tipEl.hidden = true; };

/** Hover and keyboard focus show the same tooltip. getSpec() may return null to suppress. */
export function bindTip(el, getSpec) {
  const at = (e) => {
    const spec = getSpec(e);
    if (!spec) return hideTip();
    showTip(spec, e.clientX, e.clientY);
  };
  el.addEventListener("pointerenter", at);
  el.addEventListener("pointermove", at);
  el.addEventListener("pointerleave", hideTip);
  el.addEventListener("focus", () => {
    const spec = getSpec();
    if (!spec) return;
    const r = el.getBoundingClientRect();
    showTip(spec, r.left + r.width / 2, r.bottom - 6);
  });
  el.addEventListener("blur", hideTip);
  return el;
}

// ---------------------------------------------------------------- misc

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Download a text blob. */
export function download(filename, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
