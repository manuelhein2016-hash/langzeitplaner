// Small shared UI primitives. Dialogs exist only for destructive or rare
// actions (principle 2) — everything else happens on the board itself.

import { t } from './i18n.js';

export const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

let openScrims = [];

export function closeTopSheet() {
  const s = openScrims.pop();
  if (!s) return false;
  s.remove();
  return true;
}
export const anySheetOpen = () => openScrims.length > 0;

/**
 * @param {{title:string, build:(body:HTMLElement, api:object)=>void,
 *          actions?:Array<{label:string, kind?:string, run?:Function}>,
 *          narrow?:boolean, onClose?:Function}} spec
 */
export function openSheet(spec) {
  const scrim = el('div', 'scrim');
  const sheet = el('div', 'sheet' + (spec.narrow ? ' narrow' : ''));

  const head = el('div', 'sheet-head');
  head.appendChild(el('h2', null, spec.title));
  const x = el('button', 'pop-x', '✕');
  x.title = t('close');
  head.appendChild(x);
  sheet.appendChild(head);

  const body = el('div', 'sheet-body');
  sheet.appendChild(body);

  const api = {
    close: () => {
      scrim.remove();
      openScrims = openScrims.filter((s) => s !== scrim);
      spec.onClose?.();
    },
    rebuild: () => { body.textContent = ''; spec.build(body, api); },
    body,
  };

  spec.build(body, api);

  if (spec.actions?.length) {
    const foot = el('div', 'sheet-foot');
    for (const a of spec.actions) {
      const b = el('button', a.kind === 'primary' ? 'btn-primary' : 'btn-ghost' + (a.kind === 'danger' ? ' btn-danger' : ''), a.label);
      b.addEventListener('click', () => a.run?.(api));
      foot.appendChild(b);
    }
    sheet.appendChild(foot);
  }

  x.addEventListener('click', api.close);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) api.close(); });
  scrim.appendChild(sheet);
  document.body.appendChild(scrim);
  openScrims.push(scrim);
  return api;
}

/** Confirmation for the handful of things undo cannot cover. */
export function confirmSheet({ title, body, confirmLabel, danger, onConfirm }) {
  return openSheet({
    title,
    narrow: true,
    build: (b) => {
      const p = el('p', null, body);
      p.style.cssText = 'margin:0;font:400 12.5px/1.6 var(--font);color:var(--ink-2)';
      b.appendChild(p);
    },
    actions: [
      { label: t('cancel'), run: (api) => api.close() },
      {
        label: confirmLabel,
        kind: danger ? 'danger' : 'primary',
        run: (api) => { api.close(); onConfirm(); },
      },
    ],
  });
}

let toastTimer = null;
export function toast(msg) {
  let n = document.querySelector('.toast');
  if (!n) { n = el('div', 'toast'); document.body.appendChild(n); }
  n.textContent = msg;
  requestAnimationFrame(() => n.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    n.classList.remove('show');
    setTimeout(() => n.remove(), 250);
  }, 2200);
}

export function field(label, ctlNodes) {
  const f = el('div', 'field');
  f.appendChild(el('label', null, label));
  const c = el('div', 'ctl');
  for (const n of [].concat(ctlNodes)) c.appendChild(n);
  f.appendChild(c);
  return f;
}

export function switchBox(label, checked, onChange) {
  const l = el('label', 'switch');
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.checked = !!checked;
  i.addEventListener('change', () => onChange(i.checked));
  l.appendChild(i);
  l.appendChild(document.createTextNode(label));
  return l;
}
