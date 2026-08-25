// The legend is both display and control (F4 design note): it names the
// categories, toggles their visibility, and is the way into managing them.

import { store, uid } from './store.js';
import { PALETTE, colorOf, nextFreeRef } from './palette.js';
import { t, getLang } from './i18n.js';
import { el, openSheet, field } from './ui.js';

let legendEl = null;
let notify = () => {};

export function initLegend(container, onChange) {
  legendEl = container;
  notify = onChange || (() => {});
  renderLegend();
}

export function renderLegend() {
  if (!legendEl) return;
  legendEl.textContent = '';
  const lang = getLang();
  for (const c of store.state.categories) {
    const item = el('button', 'legend-item');
    item.dataset.catId = c.id;
    item.dataset.visible = String(c.visible !== false);
    item.setAttribute('aria-pressed', String(c.visible !== false));
    const sw = el('span', 'sw');
    sw.style.background = colorOf(c.paletteRef);
    sw.style.color = colorOf(c.paletteRef);
    item.appendChild(sw);
    item.appendChild(document.createTextNode(catName(c, lang)));
    item.title = `${catName(c, lang)} · ${store.countEntriesIn(c.id)}`;
    // 4.3 — isolate a category by clicking it in the legend.
    item.addEventListener('click', () => {
      store.mutate('toggle-category', (s) => {
        const x = s.categories.find((y) => y.id === c.id);
        x.visible = x.visible === false;
      });
      notify('legend');
    });
    legendEl.appendChild(item);
  }
  const edit = el('button', 'legend-edit', t('edit'));
  edit.addEventListener('click', openCategoryManager);
  legendEl.appendChild(edit);
}

export const catName = (c, lang) =>
  lang === 'en' && c.nameEn ? c.nameEn : c.name;

/** 4.6 — a new entry auto-unhides its category with a brief flash. */
export function flashCategory(catId) {
  renderLegend();
  const node = legendEl?.querySelector(`.legend-item[data-cat-id="${catId}"]`);
  if (!node) return;
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 600);
}

// ── management (4.1, 4.4, 4.5) ───────────────────────────────────────────────

export function openCategoryManager() {
  openSheet({
    title: t('categories'),
    build: (body, api) => {
      const lang = getLang();
      const list = el('div', 'cat-list');
      for (const c of store.state.categories) list.appendChild(catRow(c, lang, api));
      body.appendChild(list);

      const add = el('button', 'btn-ghost', `＋ ${t('newCategory')}`);
      add.style.marginTop = '12px';
      add.addEventListener('click', () => {
        store.mutate('add-category', (s) => {
          s.categories.push({
            id: uid(),
            // Both language slots explicitly — creating a category while the
            // UI is English must not store the English label as the German name.
            name: 'Neue Kategorie',
            nameEn: 'New category',
            paletteRef: nextFreeRef(s.categories.map((x) => x.paletteRef)),
            visible: true,
          });
        });
        notify('legend');
        api.rebuild();
      });
      body.appendChild(add);

      const note = el('p', 'hint');
      note.style.margin = '14px 0 0';
      note.textContent =
        getLang() === 'en'
          ? 'Ten fixed tones, no free picker — the legend has to stay readable at 6 px bar width and on paper.'
          : 'Zehn feste Töne, kein freier Farbwähler — die Legende muss bei 6 px Balkenbreite und auf Papier lesbar bleiben.';
      body.appendChild(note);
    },
    actions: [{ label: t('done'), kind: 'primary', run: (api) => api.close() }],
  });
}

function catRow(c, lang, api) {
  const row = el('div', 'cat-row');

  const name = document.createElement('input');
  name.className = 'name';
  name.type = 'text';
  name.value = catName(c, lang);
  name.addEventListener('change', () => {
    const v = name.value.trim();
    if (!v) { name.value = catName(c, lang); return; }
    store.mutate('rename-category', (s) => {
      const x = s.categories.find((y) => y.id === c.id);
      if (lang === 'en') x.nameEn = v; else { x.name = v; delete x.nameEn; }
    });
    notify('legend');
  });
  row.appendChild(name);

  const sws = el('div', 'swatches');
  for (const p of PALETTE) {
    const sw = el('button', 'sw');
    sw.style.background = p.hex;
    sw.title = p[lang === 'en' ? 'en' : 'de'];
    sw.setAttribute('aria-pressed', String(p.ref === c.paletteRef));
    sw.addEventListener('click', () => {
      store.mutate('recolor-category', (s) => {
        const x = s.categories.find((y) => y.id === c.id);
        if (x.paletteRef === p.ref) return false;
        x.paletteRef = p.ref;
      });
      notify('legend');
      api.rebuild();
    });
    sws.appendChild(sw);
  }
  row.appendChild(sws);

  const n = store.countEntriesIn(c.id);
  row.appendChild(el('span', 'count', String(n)));

  const del = el('button', 'btn-ghost btn-danger', '✕');
  del.style.cssText = 'height:22px;padding:0 7px';
  del.title = t('deleteCategory');
  del.disabled = store.state.categories.length <= 1;
  if (del.disabled) del.style.opacity = '.35';
  del.addEventListener('click', () => {
    if (store.state.categories.length <= 1) return;
    if (n === 0) {
      store.mutate('delete-category', (s) => {
        s.categories = s.categories.filter((y) => y.id !== c.id);
        if (s.settings.lastCategoryId === c.id) s.settings.lastCategoryId = s.categories[0].id;
      });
      notify('legend');
      api.rebuild();
      return;
    }
    openReassign(c, n, () => { notify('legend'); api.rebuild(); });
  });
  row.appendChild(del);
  return row;
}

/** 4.4 — deleting a category with entries never silently drops them. */
function openReassign(cat, count, done) {
  const lang = getLang();
  const others = store.state.categories.filter((c) => c.id !== cat.id);
  let targetId = others[0].id;

  openSheet({
    title: t('reassignTitle'),
    narrow: true,
    build: (body) => {
      const p = el('p', null, t('reassignBody', count, catName(cat, lang)));
      p.style.cssText = 'margin:0 0 14px;font:400 12.5px/1.6 var(--font);color:var(--ink-2)';
      body.appendChild(p);

      const sel = document.createElement('select');
      for (const c of others) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = catName(c, lang);
        sel.appendChild(o);
      }
      sel.value = targetId;
      sel.addEventListener('change', () => { targetId = sel.value; });
      body.appendChild(field(t('reassignTo'), sel));
    },
    actions: [
      { label: t('cancel'), run: (api) => api.close() },
      {
        label: t('delete'),
        kind: 'danger',
        run: (api) => {
          store.mutate('delete-category', (s) => {
            for (const n of s.notes) if (n.categoryId === cat.id) n.categoryId = targetId;
            for (const b of s.bars) if (b.categoryId === cat.id) b.categoryId = targetId;
            s.categories = s.categories.filter((y) => y.id !== cat.id);
            if (s.settings.lastCategoryId === cat.id) s.settings.lastCategoryId = targetId;
          });
          api.close();
          done();
        },
      },
    ],
  });
}
