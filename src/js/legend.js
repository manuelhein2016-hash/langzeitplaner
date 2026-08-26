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
    //
    // ABSOLUTE, not a toggle (ops.js #17): the site reads the current value and emits the NEW
    // one, so two devices clicking the same category concurrently converge on one answer instead
    // of cancelling each other out. `x.visible === false` is v1's own expression verbatim
    // (`legend.js:37`), which is why a category with no `visible` field toggles to `false`
    // (ATT-91) — it renders as visible, so the first click must hide it. The lookup goes through
    // `store.state` exactly as v1's did, so a category that has gone away throws here, as it did
    // in v1, rather than emitting an op about an entity nobody has.
    item.addEventListener('click', () => {
      const x = store.state.categories.find((y) => y.id === c.id);
      store.apply('toggleCategory', { id: c.id, visible: x.visible === false });
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
        // `nextFreeRef` was read inside the v1 callback off `s.categories`; `store.state` IS that
        // same array, so reading it here is the same expression one line earlier (4.5 — a new
        // category takes a tone nobody else is using). `visible: true` is the constructor's, and
        // the new entry sorts LAST because it is the youngest — v1 pushed it there.
        store.apply('addCategory', {
          id: uid(),
          // Both language slots explicitly — creating a category while the
          // UI is English must not store the English label as the German name.
          name: 'Neue Kategorie',
          nameEn: 'New category',
          paletteRef: nextFreeRef(store.state.categories.map((x) => x.paletteRef)),
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
    // Per-language rename (ATT-10 / ATT-11). `lang` is the language the row was BUILT in, which
    // is what v1 closed over. The EN path writes `nameEn` and leaves the German name alone; the
    // DE path writes `name` and DROPS `nameEn` — v1 spelled that `delete x.nameEn`, and a
    // register log has no delete, so `renameCategory` emits `{nameEn: null}` explicitly. Omitting
    // it would leave the stale English label in a register with its old stamp and every sibling
    // device would keep rendering it.
    store.apply('renameCategory', { id: c.id, lang: lang === 'en' ? 'en' : 'de', name: v });
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
      // v1's `return false` when the tone is already the current one — clicking the active
      // swatch is not an edit and must not land on the undo stack. `recolorCategory` has no such
      // gate of its own (a recolor to the same value is a legal op), so the decline stays HERE,
      // where v1 put it. The redraw below runs either way, exactly as in v1.
      const x = store.state.categories.find((y) => y.id === c.id);
      if (x.paletteRef !== p.ref) store.apply('recolorCategory', { id: c.id, paletteRef: p.ref });
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
      // The empty-category path. v1 filtered the array and, ONLY if the doomed category was the
      // last-used one, repointed `settings.lastCategoryId` at the first SURVIVOR (4.2 — the
      // default a new entry gets must never dangle). The condition is v1's, verbatim: `null`
      // tells the constructor to omit the `[L]` pref op entirely, so a delete of a category
      // nobody was pointing at writes no pref at all, exactly as in v1.
      //
      // It rides INSIDE the op group rather than in a separate `setSettings` call, which is what
      // v1 did — one mutation, one emit, one label. `store.js:_commit()` reflects the `pref.set`
      // onto `state.settings` BEFORE `emit()`, so nothing that redraws on this delete can observe
      // the dangling id, and rule U6 keeps the pref out of the undo group as v1's settings were
      // out of `CONTENT_KEYS` (spec 5.4).
      const survivors = store.state.categories.filter((y) => y.id !== c.id);
      const repair = store.state.settings.lastCategoryId === c.id ? survivors[0].id : null;
      store.apply('deleteCategory', { id: c.id, lastCategoryId: repair });
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
          // 4.4 — THE FAN-OUT, AND IT MUST STAY ONE UNDO STEP.
          //
          // v1 did N note reassignments + M bar reassignments + the removal inside ONE mutate, so
          // one ⌘Z put every entry back in its old category AND restored the category at its
          // original position. `deleteCategoryReassign` builds the same N + M + 1 register writes
          // under ONE gid, so the store records one step; the category comes back at its old
          // index because the projection orders categories by birth, not by arrival.
          //
          // The ids are enumerated HERE rather than expressed as "everything pointing at cat" —
          // an op of that shape would not commute, its effect depending on which entities the
          // folding device had already seen. Each op names its target and carries an absolute
          // value, so a half-delivered group is a consistent half-reassigned board.
          //
          // `=== cat.id` is exact, never a prefix or a coercion (ATT-16).
          const noteIds = store.state.notes.filter((x) => x.categoryId === cat.id).map((x) => x.id);
          const barIds = store.state.bars.filter((x) => x.categoryId === cat.id).map((x) => x.id);
          // As at `legend.js:152`, the `lastCategoryId` repair rides inside the group. Here v1
          // repointed it at the REASSIGN TARGET, not at the first surviving category — the two
          // delete paths genuinely differ (if you reassign into "Reisen" you want the next entry
          // to land in Reisen) and both are kept verbatim, condition included.
          const repair = store.state.settings.lastCategoryId === cat.id ? targetId : null;
          store.apply('deleteCategoryReassign', {
            id: cat.id, targetId, noteIds, barIds, lastCategoryId: repair,
          });
          api.close();
          done();
        },
      },
    ],
  });
}
