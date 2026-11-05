// Tooltips. Any element with a `title` (or `data-tip`) gets a styled one that appears after a
// short hover: the first line is its heading, the rest is plain text (\n starts a new line).
// `title` attributes are moved to `data-tip` as they appear, so the browser's own tooltip does
// not show on top. The editor canvas calls `showAt` / `hide` itself.

const DELAY_MS = 450;
let box = null, timer = 0, owner = null;

function ensureBox() {
  if (box) return box;
  box = document.createElement("div");
  box.className = "tip";
  box.setAttribute("role", "tooltip");
  box.hidden = true;
  document.body.append(box);
  return box;
}

function fill(text) {
  const b = ensureBox();
  b.innerHTML = "";
  const lines = String(text).split("\n");
  if (lines.length > 1) {
    const h = document.createElement("b");
    h.textContent = lines.shift();
    b.append(h);
  }
  const body = document.createElement("div");
  body.textContent = lines.join("\n");
  b.append(body);
}

function place(x, y, below = 14) {
  const b = ensureBox();
  b.hidden = false;
  const r = b.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  let left = Math.min(Math.max(8, x - 12), vw - r.width - 8);
  let top = y + below;
  if (top + r.height > vh - 8) top = Math.max(8, y - r.height - 10);
  b.style.left = `${left}px`;
  b.style.top = `${top}px`;
}

/** Show `text` near client point (x, y) after the hover delay; `key` dedupes repeated calls. */
export function showAt(x, y, text, key = text) {
  if (!text) return hide();
  if (owner === key && box && !box.hidden) return;
  clearTimeout(timer);
  owner = key;
  timer = setTimeout(() => { fill(text); place(x, y); }, DELAY_MS);
}

export function hide() {
  clearTimeout(timer);
  owner = null;
  if (box) box.hidden = true;
}

function adopt(el) {
  if (el.hasAttribute && el.hasAttribute("title")) {
    const t = el.getAttribute("title");
    if (t) el.dataset.tip = t;
    el.removeAttribute("title");
  }
}

/** Set an element's tooltip text. */
export function tip(el, text) {
  if (el) el.dataset.tip = text;
  return el;
}

export function install(root = document.body) {
  root.querySelectorAll("[title]").forEach(adopt);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "attributes") adopt(m.target);
      for (const n of m.addedNodes || []) {
        if (n.nodeType !== 1) continue;
        adopt(n);
        n.querySelectorAll && n.querySelectorAll("[title]").forEach(adopt);
      }
    }
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });

  document.addEventListener("pointerover", (e) => {
    const el = e.target.closest && e.target.closest("[data-tip]");
    if (!el || el === owner) return;
    if (!el.dataset.tip) return;
    const r = el.getBoundingClientRect();
    clearTimeout(timer);
    if (box) box.hidden = true;
    owner = el;
    timer = setTimeout(() => {
      if (owner !== el || !el.isConnected) return;
      fill(el.dataset.tip);
      place(r.left + Math.min(r.width / 2, 40), r.bottom - 6, 10);
    }, DELAY_MS);
  });
  document.addEventListener("pointerout", (e) => {
    if (!(owner instanceof Element)) return;
    const to = e.relatedTarget;
    if (to && owner.contains(to)) return;
    if (owner.contains(e.target)) hide();
  });
  for (const ev of ["pointerdown", "keydown", "wheel"]) document.addEventListener(ev, hide, { capture: true, passive: true });
  window.addEventListener("blur", hide);
}
