(() => {
  /**
   * 衣柜面板、合法穿戴 ID 词表与成套穿搭智能建议控制器（UX-02b / P0-6）。
   */
  function initWardrobe(ctx) {
    const {
      api, t, say, setMarkContext, STATES,
      closeOtherOverlays, syncMotionPriority, syncPanelViewport,
      completeOutfit, planOutfit, bindPanelDrag
    } = ctx;

    let knownWear = new Set();
    let wearCandidates = [];

    function setKnownWear(ids) {
      knownWear = new Set(ids || []);
      wearCandidates = [...knownWear].map(id => 'wear:' + String(id).toLowerCase());
      setMarkContext({ STATES, knownWear, wearCandidates });
    }

    function wearIdsFrom(cat) {
      const itemIds = Object.keys(cat.items).flatMap(s => cat.items[s].map(i => i.id));
      const presetIds = Object.keys(cat.presets);
      const offIds = (cat.slots || [])
        .filter(s => !s.required)
        .map(s => 'off_' + String(s.id).toLowerCase());
      return itemIds.concat(presetIds, offIds);
    }

    /* ---------- 智能成套建议（v1.0 UX-02b / P0-6） ---------- */
    const wdSuggest = document.getElementById('wdSuggest');
    const wdSuggestText = document.getElementById('wdSuggestText');
    const wdSuggestBtn = document.getElementById('wdSuggestBtn');
    let wdAnchor = null;
    let wdPendingPlan = [];

    function wdCatalogLookup(cat) {
      const map = {};
      for (const [s, arr] of Object.entries((cat && cat.items) || {})) {
        for (const it of (arr || [])) map[it.id] = { slot: s, name: it.name };
      }
      return map;
    }

    function updateOutfitSuggest(cat) {
      if (!wdSuggest) return;
      wdPendingPlan = [];
      const hide = () => { wdSuggest.classList.add('hidden'); };
      if (!wdAnchor || !cat || !cat.equip) return hide();
      const lookup = wdCatalogLookup(cat);
      const desired = completeOutfit(cat.equip, lookup, wdAnchor);
      const plan = desired ? planOutfit(cat.equip, desired) : [];
      const names = plan
        .filter(p => !p.itemId.startsWith('off_'))
        .map(p => t('wardrobe.item.' + p.itemId, (lookup[p.itemId] && lookup[p.itemId].name) || p.itemId));
      if (!plan.length || !names.length) return hide();
      wdPendingPlan = plan;
      wdSuggestText.textContent = t('wardrobe.suggestPrefix') + names.join(' + ');
      wdSuggestBtn.textContent = t('wardrobe.applyComplete');
      wdSuggest.classList.remove('hidden');
    }

    if (wdSuggestBtn) wdSuggestBtn.addEventListener('click', async () => {
      const hint = document.getElementById('wdHint');
      let allOk = true;
      try {
        for (const op of wdPendingPlan) {
          const val = op.itemId.startsWith('off_') ? null : op.itemId;
          const r = await api.wardrobeSet(op.slot, val);
          if (!r || !r.ok) {
            if (hint) hint.textContent = t('wardrobe.completeFailed') + ((r && r.error) || '');
            allOk = false;
            break;
          }
        }
        if (allOk && hint) hint.textContent = t('wardrobe.completeSuccess');
      } catch (e) {
        if (hint) hint.textContent = t('wardrobe.completeFailed') + e.message;
      }
      wdAnchor = null;
      wdPendingPlan = [];
      if (wdSuggest) wdSuggest.classList.add('hidden');
      refreshWardrobe();
    });

    async function refreshWardrobe() {
      const presetBox = document.getElementById('wdPresets');
      const slotBox = document.getElementById('wdSlots');
      presetBox.textContent = '';
      slotBox.textContent = '';
      if (!api) {
        slotBox.textContent = t('wd.preview');
        return;
      }
      let st;
      try { st = await api.wardrobeState(); } catch { st = null; }
      const cat = st && st.catalog;
      if (!cat) { slotBox.textContent = t('wd.notInit'); return; }

      setKnownWear(wearIdsFrom(cat));

      const nowBox = document.getElementById('wdCurrent');
      if (nowBox) {
        nowBox.textContent = '';
        const head = document.createElement('span');
        head.className = 'wd-now-label';
        head.textContent = t('wd.now');
        nowBox.appendChild(head);
        const nameOf = {};
        for (const arr of Object.values(cat.items)) for (const i of arr) nameOf[i.id] = i.name;
        for (const s of cat.slots) {
          const id = cat.equip[s.id];
          if (!id) continue;
          const chip = document.createElement('span');
          chip.className = 'wd-now-chip';
          chip.textContent = t('wardrobe.item.' + id, (nameOf[id] || id));
          nowBox.appendChild(chip);
        }
      }

      for (const [pid, pname] of Object.entries(cat.presets)) {
        const b = document.createElement('button');
        const isWip = (pid === 'casual' || pid === 'gothic');
        const localizedPname = t('wardrobe.preset.' + pid, pname);
        b.textContent = isWip ? localizedPname + t('wardrobe.wipSuffix', ' (待制作)') : localizedPname;
        b.className = 'wd-preset' + (cat.preset === pid ? ' on' : '') + (isWip ? ' wd-wip' : '');
        if (isWip) {
          b.title = t('wardrobe.wipTitle', '点阵元素重构中，晚上台式机制作');
        }
        b.addEventListener('click', async () => {
          wdAnchor = null;
          if (isWip) {
            say(t('wardrobe.wipHint', '这两套衣服里面的点阵元素正在重做中，晚上换上~'));
            return;
          }
          const r = await api.wardrobePreset(pid);
          if (!r.ok) say(t('wardrobe.wearFailed', '这套我换不上：') + r.error);
          refreshWardrobe();
        });
        presetBox.appendChild(b);
      }

      for (const slot of cat.slots) {
        const items = cat.items[slot.id] || [];
        if (!items.length) continue;
        const row = document.createElement('div');
        row.className = 'wd-row';
        const label = document.createElement('span');
        label.className = 'wd-slot';
        label.textContent = t('wardrobe.slot.' + slot.id, slot.name);
        row.appendChild(label);

        const cur = cat.equip[slot.id];
        for (const it of items) {
          const b = document.createElement('button');
          b.className = 'wd-item' + (cur === it.id ? ' on' : '');
          const itemName = t('wardrobe.item.' + it.id, it.name);
          b.title = itemName + '（' + it.id + '）';
          if (it.file) {
            const im = document.createElement('img');
            im.src = 'assets/character/' + it.file;
            im.alt = '';
            b.appendChild(im);
          }
          const nm = document.createElement('span');
          nm.textContent = itemName;
          b.appendChild(nm);
          b.addEventListener('click', async () => {
            if (!slot.required && cur === it.id) {
              wdAnchor = null;
              const ro = await api.wardrobeSet(slot.id, null);
              if (!ro.ok) say(t('wardrobe.offFailed', '这件脱不掉：') + ro.error);
              refreshWardrobe();
              return;
            }
            wdAnchor = it.id;
            const target = { ...cat.equip, [slot.id]: it.id };
            if (slot.id === 'dress') { target.top = null; target.bottom = null; }
            if (slot.id === 'top' || slot.id === 'bottom') { target.dress = null; }
            const plan = planOutfit(cat.equip, target);
            let r = { ok: true };
            for (const op of plan) {
              r = await api.wardrobeSet(op.slot, op.itemId.startsWith('off_') ? null : op.itemId);
              if (!r.ok) break;
            }
            if (!r.ok) say(t('wardrobe.putOnFailed', '这件穿不上：') + r.error);
            refreshWardrobe();
          });
          row.appendChild(b);
        }
        if (!slot.required) {
          const off = document.createElement('button');
          off.textContent = t('wd.off');
          off.className = 'wd-off' + (cur ? '' : ' on');
          off.addEventListener('click', async () => {
            wdAnchor = null;
            const r = await api.wardrobeSet(slot.id, null);
            if (!r.ok) say(t('wardrobe.offFailed', '这件脱不掉：') + r.error);
            refreshWardrobe();
          });
          row.appendChild(off);
        }
        slotBox.appendChild(row);
      }

      updateOutfitSuggest(cat);
    }

    function toggleWardrobe(on) {
      const wd = document.getElementById('wardrobe');
      if (!wd) return;
      const showIt = on ?? wd.classList.contains('hidden');
      if (showIt) closeOtherOverlays('wardrobe');
      wd.classList.toggle('hidden', !showIt);
      if (showIt) refreshWardrobe();
      syncMotionPriority();
      syncPanelViewport();
    }

    const wdEl = document.getElementById('wardrobe');
    bindPanelDrag(wdEl);
    if (wdEl) {
      wdEl.addEventListener('contextmenu', (e) => { e.preventDefault(); toggleWardrobe(false); });
    }

    return {
      setKnownWear,
      wearIdsFrom,
      wdCatalogLookup,
      updateOutfitSuggest,
      refreshWardrobe,
      toggleWardrobe,
      getWearContext: () => ({ STATES, knownWear, wearCandidates })
    };
  }

  if (typeof window !== 'undefined') {
    window.LifeUiWardrobe = { initWardrobe };
  }
})();
