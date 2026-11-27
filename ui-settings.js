(() => {
  const PANEL_SECTIONS = ['conn', 'memory', 'tickets', 'voice', 'timezone', 'danger'];
  const STT_PRESETS = {
    siliconflow: {
      endpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions',
      model: 'FunAudioLLM/SenseVoiceSmall'
    },
    groq: {
      endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
      model: 'whisper-large-v3-turbo'
    },
    openai: {
      endpoint: 'https://api.openai.com/v1/audio/transcriptions',
      model: 'whisper-1'
    },
    local: {
      endpoint: 'http://127.0.0.1:8080/v1/audio/transcriptions',
      model: 'whisper-1'
    }
  };

  /**
   * 设置面板控制器：连接管理、STT 语音设置、长期记忆/未完事项/梦境展示、
   * 声明式机制遥测渲染、时空罗盘与双语 i18n 渲染、危险区三次保险确认。
   */
  function initSettings(ctx) {
    const {
      panel, api, t, setLocale, getTimezone, formatDisplayTime,
      getPreset, detectProviderByKey,
      say, closeOtherOverlays, syncMotionPriority, syncPanelViewport,
      updateMenuI18n, getRefreshWardrobe
    } = ctx;

    const langSelect = document.getElementById('langSelect');
    const tzNote = document.getElementById('tzNote');
    const i18nTitle = document.getElementById('i18nTitle');
    const langLabel = document.getElementById('langLabel');
    const tzLabel = document.getElementById('tzLabel');
    const expandedObsGroups = new Set();
    let compassBirthAt = null;
    let connItems = [];
    let connSelectedId = null;
    let pendingDetect = null;
    let pendingQuickDetect = null;

    function formatObsValue(value, dash) {
      if (value === null || value === undefined) return dash;
      if (typeof value === 'boolean') return value ? t('obs.yes', '是') : t('obs.no', '否');
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return dash;
        return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
      }
      if (typeof value === 'string') return value || dash;
      if (Array.isArray(value)) return value.length ? value.join(', ') : dash;
      if (typeof value === 'object') {
        const parts = [];
        for (const k of Object.keys(value)) {
          const v = value[k];
          if (v === null || v === undefined) parts.push(k + '=' + dash);
          else if (typeof v === 'object') {
            if (Array.isArray(v)) parts.push(k + '=[' + v.length + ']');
            else {
              const sub = Object.keys(v).map((sk) => sk + ':' + ((v[sk] === null || v[sk] === undefined) ? dash : v[sk])).join(', ');
              parts.push(k + '={' + (sub || dash) + '}');
            }
          } else parts.push(k + '=' + v);
        }
        return parts.length ? parts.join(' · ') : dash;
      }
      return dash;
    }

    function formatObsRangeLabel(item) {
      if (item && Array.isArray(item.range) && item.range.length === 2) {
        const [lo, hi] = item.range;
        if (lo === 0 && hi === 1) return '0%–100%';
        return `${lo}..${hi}`;
      }
      return (item && item.unit) ? String(item.unit) : '';
    }

    function formatObsFieldDisplay(key, v, dash) {
      if (v === null || v === undefined) return { text: dash, kind: 'null' };
      if (typeof v === 'boolean') {
        const tone = v
          ? (key === 'tripped' ? 'danger' : (key === 'probeInFlight' ? 'warn' : 'info'))
          : 'muted';
        return { text: v ? t('obs.yes', '是') : t('obs.no', '否'), kind: 'pill', tone };
      }
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) return { text: dash, kind: 'null' };
        if (key === 'confidence' || key === 'revisionPressure' || key === 'promiseFidelity'
          || key === 'closureRatio' || key === 'plasticityMultiplier'
          || key === 'expectationFulfillRate' || key === 'selfNoteEngraveRate') {
          const pct = (v * 100).toFixed(1).replace(/\.0$/, '');
          return { text: pct + '%', kind: 'num' };
        }
        if (key === 'cooldownUntil' && v > 1e12 && typeof formatDisplayTime === 'function') {
          return { text: formatDisplayTime(v) || String(v), kind: 'time' };
        }
        if (key === 'bias') {
          return { text: Number(v.toFixed(2)) + 'x', kind: 'num' };
        }
        return { text: Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2))), kind: 'num' };
      }
      if (typeof v === 'string') {
        if (!v) return { text: dash, kind: 'null' };
        if (key === 'state') {
          const upper = v.toUpperCase();
          const tone = upper === 'CLOSED' ? 'ok' : (upper === 'OPEN' ? 'danger' : 'warn');
          return { text: t('obs.state.' + upper, v), kind: 'pill', tone };
        }
        return { text: v, kind: 'text' };
      }
      if (Array.isArray(v)) return { text: v.length ? v.join(', ') : dash, kind: v.length ? 'text' : 'null' };
      return { text: dash, kind: 'null' };
    }

    function resolveObsMeter(key, v, item, rootVal) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      if (key === 'dims' || key === 'min' || key === 'max' || key === 'windowNo' || key === 'archiveSeq' || key === 'cooldownUntil'
        || key === 'completedWindows' || key === 'verified' || key === 'rejected' || key === 'sampleSize') {
        return null;
      }
      if (item && Array.isArray(item.range) && item.range.length === 2) {
        const [lo, hi] = item.range;
        if (hi <= lo) return null;
        if (lo < 0 && hi > 0) {
          const maxAbs = Math.max(Math.abs(lo), Math.abs(hi));
          const pct = Math.min(50, (Math.abs(v) / maxAbs) * 50);
          return { mode: 'bipolar', neg: v < 0, pct };
        }
        if (lo === 0.5 && hi === 1.5 && key === 'bias') {
          const diff = v - 1.0;
          const pct = Math.min(50, (Math.abs(diff) / 0.5) * 50);
          return { mode: 'bipolar', neg: diff < 0, pct };
        }
        const pct = Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
        const warn = (key === 'restPressure' || key === 'cognitiveLoadProxy' || key === 'revisionPressure') && pct >= 70;
        return { mode: 'linear', pct, tone: warn ? 'warn' : 'ok' };
      }
      if (key === 'promiseFidelity') {
        const pct = Math.max(0, Math.min(100, v * 100));
        return { mode: 'linear', pct, tone: pct < 50 ? 'warn' : 'ok' };
      }
      if (rootVal && typeof rootVal === 'object') {
        if ((key === 'runtimeCached' || key === 'count') && Number.isFinite(rootVal.capacity) && rootVal.capacity > 0) {
          const pct = Math.max(0, Math.min(100, (v / rootVal.capacity) * 100));
          return { mode: 'linear', pct, tone: pct >= 85 ? 'warn' : 'ok' };
        }
        if ((key === 'ACTIVE' || key === 'FADING' || key === 'DORMANT') && Number.isFinite(rootVal.total) && rootVal.total > 0) {
          const pct = Math.max(0, Math.min(100, (v / rootVal.total) * 100));
          return { mode: 'linear', pct, tone: key === 'DORMANT' ? 'muted' : 'ok' };
        }
        if (key === 'actions' && Number.isFinite(rootVal.remainingActions) && (v + rootVal.remainingActions) > 0) {
          const pct = Math.max(0, Math.min(100, (v / (v + rootVal.remainingActions)) * 100));
          return { mode: 'linear', pct, tone: pct >= 80 ? 'warn' : 'ok' };
        }
        if (key === 'writes' && Number.isFinite(rootVal.remainingWrites) && (v + rootVal.remainingWrites) > 0) {
          const pct = Math.max(0, Math.min(100, (v / (v + rootVal.remainingWrites)) * 100));
          return { mode: 'linear', pct, tone: pct >= 80 ? 'warn' : 'ok' };
        }
      }
      return null;
    }

    function appendObsKvTile(gridEl, fieldKey, rawVal, item, rootVal, dash, isSub) {
      const tile = document.createElement('div');
      tile.className = 'obs-kv' + (isSub ? ' obs-kv-sub' : '');

      const kEl = document.createElement('span');
      kEl.className = 'obs-k';
      kEl.textContent = t('obs.field.' + fieldKey, fieldKey);
      kEl.title = fieldKey;

      const vEl = document.createElement('span');
      const fmt = formatObsFieldDisplay(fieldKey, rawVal, dash);
      vEl.className = 'obs-v';
      if (fmt.kind === 'pill') {
        const pill = document.createElement('span');
        pill.className = 'obs-pill is-' + (fmt.tone || 'muted');
        pill.textContent = fmt.text;
        vEl.appendChild(pill);
      } else {
        if (fmt.kind === 'null') vEl.classList.add('is-null');
        else if (fmt.kind === 'time') vEl.classList.add('is-time');
        vEl.textContent = fmt.text;
      }

      tile.append(kEl, vEl);

      const meterSpec = resolveObsMeter(fieldKey, rawVal, item, rootVal);
      if (meterSpec) {
        const meter = document.createElement('div');
        meter.className = 'obs-meter';
        const fill = document.createElement('div');
        if (meterSpec.mode === 'bipolar') {
          const mid = document.createElement('div');
          mid.className = 'obs-meter-mid';
          fill.className = 'obs-meter-fill ' + (meterSpec.neg ? 'neg' : 'pos');
          fill.style.left = meterSpec.neg ? (50 - meterSpec.pct) + '%' : '50%';
          fill.style.width = meterSpec.pct + '%';
          meter.append(mid, fill);
        } else {
          fill.className = 'obs-meter-fill linear is-' + (meterSpec.tone || 'ok');
          fill.style.width = meterSpec.pct + '%';
          meter.appendChild(fill);
        }
        tile.appendChild(meter);
      }

      gridEl.appendChild(tile);
    }

    function appendObsValueContent(valEl, item, dash) {
      const value = item ? item.value : null;
      if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
        const scalar = document.createElement('span');
        scalar.className = 'obs-scalar' + ((value === null || value === undefined) ? ' is-null' : '');
        scalar.textContent = formatObsValue(value, dash);
        valEl.appendChild(scalar);
        return;
      }

      const grid = document.createElement('div');
      grid.className = 'obs-kv-grid';
      const keys = Object.keys(value);
      if (!keys.length) {
        const scalar = document.createElement('span');
        scalar.className = 'obs-scalar is-null';
        scalar.textContent = dash;
        valEl.appendChild(scalar);
        return;
      }

      for (const k of keys) {
        const v = value[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const subKeys = Object.keys(v);
          if (!subKeys.length) {
            appendObsKvTile(grid, k, null, item, value, dash, true);
          } else {
            for (const sk of subKeys) {
              appendObsKvTile(grid, sk, v[sk], item, value, dash, true);
            }
          }
        } else {
          appendObsKvTile(grid, k, v, item, value, dash, false);
        }
      }
      valEl.appendChild(grid);
    }

    function syncObsToggleAllBtn() {
      const btn = document.getElementById('rObsToggleAllBtn');
      if (!btn) return;
      if (!btn.dataset.obsToggleBound) {
        btn.dataset.obsToggleBound = '1';
        btn.addEventListener('click', () => {
          const box = document.getElementById('rObsGroups');
          if (!box) return;
          const bodies = [...box.querySelectorAll('.obs-group-body')];
          if (!bodies.length) return;
          const anyCollapsed = bodies.some((b) => b.classList.contains('hidden'));
          for (const body of bodies) {
            const gName = body.dataset.obsGroup;
            const head = body.parentElement ? body.parentElement.querySelector('[data-obs-group-toggle]') : null;
            body.classList.toggle('hidden', !anyCollapsed);
            if (head) {
              head.classList.toggle('collapsed', !anyCollapsed);
              head.setAttribute('aria-expanded', anyCollapsed ? 'true' : 'false');
            }
            if (gName) {
              if (anyCollapsed) expandedObsGroups.add(gName);
              else expandedObsGroups.delete(gName);
            }
          }
          syncObsToggleAllBtn();
        });
      }
      const box = document.getElementById('rObsGroups');
      const bodies = box ? [...box.querySelectorAll('.obs-group-body')] : [];
      const allOpen = bodies.length > 0 && bodies.every((b) => !b.classList.contains('hidden'));
      btn.textContent = allOpen ? t('research.obs.collapseAll', '收起全部') : t('research.obs.expandAll', '展开全部');
    }

    function renderObsGroups(obs) {
      const box = document.getElementById('rObsGroups');
      if (!box) return;
      box.textContent = '';

      const dash = t('obs.dash', '—');
      const tsEl = document.getElementById('rObsTimestamp');
      if (tsEl) {
        if (obs && Number.isFinite(obs.generatedAt) && typeof formatDisplayTime === 'function') {
          tsEl.textContent = t('research.obs.updatedAt', '采集于 {time}', { time: formatDisplayTime(obs.generatedAt) });
          tsEl.classList.remove('hidden');
        } else {
          tsEl.textContent = '';
          tsEl.classList.add('hidden');
        }
      }

      if (!obs || !obs.groups || typeof obs.groups !== 'object') {
        const row = document.createElement('div');
        row.className = 'r-table-container';
        row.textContent = dash;
        box.appendChild(row);
        syncObsToggleAllBtn();
        return;
      }

      const groupLabel = (g) => t('obs.group.' + g, g);
      const order = Array.isArray(obs.order) && obs.order.length ? obs.order : Object.keys(obs.groups);

      for (const g of order) {
        const items = obs.groups[g];
        if (!Array.isArray(items) || !items.length) continue;

        const isExpanded = expandedObsGroups.has(g);
        const wrap = document.createElement('div');
        wrap.className = 'r-table-container obs-group';

        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'obs-group-head' + (isExpanded ? '' : ' collapsed');
        head.dataset.obsGroupToggle = g;
        head.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');

        const titleWrap = document.createElement('span');
        titleWrap.className = 'obs-group-title';
        const caret = document.createElement('span');
        caret.className = 'obs-group-caret';
        caret.textContent = '▾';
        const titleTxt = document.createElement('span');
        titleTxt.textContent = groupLabel(g);
        titleWrap.append(caret, titleTxt);

        const count = document.createElement('span');
        count.className = 'obs-group-count';
        count.textContent = t('obs.groupCount', '{n} 项', { n: items.length });

        head.append(titleWrap, count);

        const body = document.createElement('div');
        body.className = isExpanded ? 'r-table-container obs-group-body' : 'r-table-container obs-group-body hidden';
        body.dataset.obsGroup = g;

        for (const item of items) {
          const row = document.createElement('div');
          row.className = 'r-table-row obs-row';
          row.dataset.obsId = item.id;

          const top = document.createElement('div');
          top.className = 'obs-row-top';

          const kEl = document.createElement('span');
          kEl.className = 'obs-label';
          kEl.textContent = t(item.labelKey, item.id);
          top.appendChild(kEl);

          const rangeTxt = formatObsRangeLabel(item);
          if (rangeTxt) {
            const rangeEl = document.createElement('span');
            rangeEl.className = 'obs-range-chip';
            rangeEl.textContent = rangeTxt;
            top.appendChild(rangeEl);
          }

          const vEl = document.createElement('div');
          vEl.className = 'obs-value';
          appendObsValueContent(vEl, item, dash);

          row.append(top, vEl);
          body.appendChild(row);
        }

        wrap.append(head, body);
        box.appendChild(wrap);
      }

      if (!box.dataset.obsDelegate) {
        box.dataset.obsDelegate = '1';
        box.addEventListener('click', (ev) => {
          const head = ev.target && ev.target.closest
            ? ev.target.closest('[data-obs-group-toggle]') : null;
          if (!head || !box.contains(head)) return;
          const gName = head.dataset.obsGroupToggle;
          const wrap = head.parentElement;
          const body = wrap ? wrap.querySelector('.obs-group-body') : null;
          if (!body) return;
          const collapsed = body.classList.toggle('hidden');
          head.classList.toggle('collapsed', collapsed);
          head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
          if (gName) {
            if (collapsed) expandedObsGroups.delete(gName);
            else expandedObsGroups.add(gName);
          }
          syncObsToggleAllBtn();
        });
      }

      syncObsToggleAllBtn();
    }

    async function refreshLifeMechanisms() {
      if (!api || !api.lifeMechanisms) return;
      try {
        const r = await api.lifeMechanisms();
        if (!r || !r.ok) return;
        const lx = document.getElementById('rLexiconList');
        if (lx) {
          lx.textContent = '';
          (r.lexicon || []).forEach((x) => {
            const row = document.createElement('div');
            row.className = 'r-table-row r-ledger-item';

            const head = document.createElement('div');
            head.className = 'r-ledger-head';

            const left = document.createElement('div');
            left.className = 'r-ledger-left';
            const stKey = String(x.status || 'ACTIVE').toUpperCase();
            const badge = document.createElement('span');
            badge.className = 'r-badge ' + (stKey === 'ACTIVE' ? 'badge-active' : 'badge-dormant');
            badge.textContent = t('research.lexicon.status.' + stKey, String(x.status || stKey));
            const word = document.createElement('span');
            word.className = 'r-ledger-word';
            word.textContent = x.word || t('obs.dash', '—');
            left.append(badge, word);
            if (x.kind) {
              const kind = document.createElement('span');
              kind.className = 'r-chip-muted';
              kind.textContent = t('research.lexicon.kind.' + x.kind, String(x.kind));
              left.appendChild(kind);
            }

            const citeWrap = document.createElement('div');
            citeWrap.className = 'r-ledger-cite';
            if (Array.isArray(x.uses) && x.uses.length > 0) {
              const reused = document.createElement('span');
              reused.className = 'r-chip-muted';
              reused.textContent = t('research.lexicon.reusedChip', '复用 {n} 次', { n: x.uses.length });
              citeWrap.appendChild(reused);
            }
            const cite = document.createElement('span');
            cite.className = 'r-chip-cite';
            cite.textContent = t('research.lexicon.citeChip', '引证 {id}', { id: x.messageId || '—' });
            citeWrap.appendChild(cite);

            head.append(left, citeWrap);
            row.appendChild(head);
            if (x.gloss) {
              const sub = document.createElement('div');
              sub.className = 'r-ledger-sub';
              sub.textContent = x.gloss;
              row.appendChild(sub);
            }
            lx.appendChild(row);
          });
          if (!lx.children.length) lx.textContent = t('research.lexicon.empty', '（暂无 —— 词汇表零先验，等她自己长词）');
        }
        const ex = document.getElementById('rExpectList');
        if (ex) {
          ex.textContent = '';
          (r.expectations || []).forEach((x) => {
            const row = document.createElement('div');
            row.className = 'r-table-row r-ledger-item';

            const head = document.createElement('div');
            head.className = 'r-ledger-head';

            const left = document.createElement('div');
            left.className = 'r-ledger-left';
            const stLower = String(x.status || 'open').toLowerCase();
            const badgeCls = stLower === 'fulfilled' ? 'badge-certified'
              : (stLower === 'broken' ? 'badge-rejected' : (stLower === 'open' ? 'badge-open' : 'badge-dormant'));
            const badge = document.createElement('span');
            badge.className = 'r-badge ' + badgeCls;
            badge.textContent = t('research.expect.status.' + stLower, String(x.status || stLower));
            left.appendChild(badge);
            if (x.kind) {
              const kind = document.createElement('span');
              kind.className = 'r-chip-muted';
              kind.textContent = t('research.expect.kind.' + x.kind, String(x.kind));
              left.appendChild(kind);
            }
            if (x.dueHint) {
              const due = document.createElement('span');
              due.className = 'r-chip-muted';
              due.textContent = x.dueHint;
              left.appendChild(due);
            }

            const citeWrap = document.createElement('div');
            citeWrap.className = 'r-ledger-cite';
            const cite = document.createElement('span');
            cite.className = 'r-chip-cite';
            cite.textContent = t('research.lexicon.citeChip', '引证 {id}', { id: x.messageId || '—' });
            citeWrap.appendChild(cite);

            head.append(left, citeWrap);
            row.appendChild(head);

            const body = document.createElement('div');
            body.className = 'r-ledger-sub';
            body.textContent = x.text || t('obs.dash', '—');
            row.appendChild(body);

            ex.appendChild(row);
          });
          if (!ex.children.length) ex.textContent = t('research.expect.empty', '（暂无）');
        }
        renderObsGroups(r.obs);
      } catch (e) { /* 只读渲染失败不影响面板其余部分 */ }
    }

    function tzOffsetHours(tz) {
      try {
        const now = new Date();
        const lt = new Date(now.toLocaleString('en-US', { timeZone: tz }));
        const ut = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
        return Math.round((lt - ut) / 3600000 * 10) / 10;
      } catch (e) { return null; }
    }

    function fmtOff(h) {
      if (h === null || h === undefined) return '?';
      return (h >= 0 ? '+' : '') + h;
    }

    async function renderSandboxPanel() {
      const setV = (id, s) => { const el = document.getElementById(id); if (el) el.textContent = s; };
      if (!api || !api.agent || typeof api.agent.getStatus !== 'function') return;
      try {
        const res = await api.agent.getStatus();
        const roots = res && res.policy && res.policy.sandboxRoots;
        if (Array.isArray(roots) && roots.length > 0 && roots[0]) {
          setV('sandboxPath', roots[0]);
        } else {
          setV('sandboxPath', '—');
        }
      } catch {
        setV('sandboxPath', '—');
      }
    }

    async function refreshSttPanel() {
      if (!api || !api.stt || typeof api.stt.getConfig !== 'function') return;
      const statusEl = document.getElementById('sttStatus');
      let r = null;
      try { r = await api.stt.getConfig(); } catch (e) { r = null; }
      if (!r || !r.ok) {
        if (statusEl) statusEl.textContent = t('stt.statusNone', '未配置');
        return;
      }
      const el = (id) => document.getElementById(id);
      if (el('sttUrl')) el('sttUrl').value = r.endpoint || '';
      if (el('sttModel')) el('sttModel').value = r.model || '';
      if (el('sttLang')) el('sttLang').value = r.lang || '';
      if (el('sttKey')) el('sttKey').value = '';

      if (statusEl) {
        if (!r.hasKey) statusEl.textContent = t('stt.statusNone', '未配置');
        else if (r.encrypted) statusEl.textContent = t('stt.statusReadyEnc', '已配置（加密）');
        else statusEl.textContent = t('stt.statusReadyPlain', '已配置（明文降级）');
        statusEl.style.color = r.hasKey && !r.encrypted ? '#e09f3e' : '';
      }
    }

    function renderTimezonePanel() {
      const home = getTimezone();
      const host = (Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions().timeZone) || '';
      const setV = (id, s) => { const el = document.getElementById(id); if (el) el.textContent = s; };
      setV('tzZone', (home || '?') + ' (UTC' + fmtOff(tzOffsetHours(home)) + ') 🔒');
      setV('tzBirth', compassBirthAt ? formatDisplayTime(compassBirthAt) : '—');
      setV('tzUptime', compassBirthAt
        ? (t('tz.about', '约') + ' ' + ((Date.now() - compassBirthAt) / 3600000).toFixed(1) + ' ' + t('tz.hours'))
        : '—');
      if (host && home && host !== home) {
        const diff = Math.round((tzOffsetHours(home) - tzOffsetHours(host)) * 10) / 10;
        setV('tzSync', t('tz.travelA') + ' ' + host + '（UTC' + fmtOff(tzOffsetHours(host)) + '）· '
          + t('tz.travelC') + ' ' + Math.abs(diff) + ' ' + t('tz.hours') + ' · '
          + t('tz.travelD') + ' ' + new Date().toLocaleTimeString('en-GB', { timeZone: home, hour12: false }));
      } else {
        setV('tzSync', '● ' + t('tz.synced'));
      }
      renderSandboxPanel();
      refreshSttPanel();
    }

    function renderI18nPanel() {
      renderTimezonePanel();
      if (tzNote) tzNote.textContent = t('panel.tzLocked');
      if (i18nTitle) i18nTitle.textContent = t('panel.i18nTitle');
      if (langLabel) langLabel.textContent = t('panel.language');
      if (tzLabel) tzLabel.textContent = t('panel.timezone');
      const setText = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
      const setPlaceholder = (id, key) => { const el = document.getElementById(id); if (el) el.placeholder = t(key); };
      setText('panelTitle', 'panel.title');
      setText('secConn', 'sec.conn');
      setText('secMemory', 'sec.memory');
      setText('secTickets', 'sec.tickets');
      setText('secVoice', 'sec.voice');
      setText('secTimezone', 'sec.timezone');
      setText('secDanger', 'sec.danger');
      setText('wardrobeTitle', 'sec.wardrobe');
      setText('wdHint', 'wd.hint');
      setText('wdSuggestBtn', 'wardrobe.applyComplete');
      setText('wdCloseHint', 'panel.closeHint');
      setText('presetLabel', 'preset.section');

      setText('acLabelScope', 'agent.label.scope');
      setText('acLabelReason', 'agent.label.reason');
      setText('acLabelBudget', 'agent.label.budget');
      setText('acLabelContent', 'agent.label.content');
      setText('acExpandBtn', 'agent.content.expand');

      setText('connQuickTitle', 'conn.quick');
      setText('keySave', 'conn.quickSave');
      setText('connAdvTitle', 'conn.advanced');
      setText('connListLabel', 'conn.list');
      setText('connListHint', 'conn.listHint');
      setText('connNameLabel', 'conn.name');
      setText('optAnthropicNative', 'conn.anthropicNative');
      setText('connNew', 'conn.new');
      setText('connSave', 'conn.save');
      setText('connTest', 'conn.test');
      setText('connActivate', 'conn.activate');
      setText('openCfg', 'conn.openCfg');
      setText('statsTitle', 'sec.stats');

      setPlaceholder('connName', 'conn.namePlaceholder');
      setPlaceholder('connKey', 'conn.keyPlaceholder');
      setPlaceholder('connModel', 'conn.modelPlaceholder');

      setText('memTitle', 'mem.title');
      setText('ticketsTitle', 'tickets.title');
      setText('dangerHint', 'sec.dangerHint');
      setText('tzCompassTitle', 'tz.compass');
      setText('tzKBirth', 'tz.birth');
      setText('tzKZone', 'tz.zone');
      setText('tzKUptime', 'tz.uptime');
      setText('tzKSync', 'tz.sync');
      setText('sandboxTitle', 'panel.sandboxTitle');
      setText('sandboxPathLabel', 'panel.sandboxPathLabel');
      setText('sandboxWarning', 'panel.sandboxWarning');
      setText('sttTitle', 'stt.title');
      setText('sttPresetLabel', 'stt.presetLabel');
      setText('sttUrlLabel', 'stt.urlLabel');
      setText('sttModelLabel', 'stt.modelLabel');
      setText('sttKeyLabel', 'stt.keyLabel');
      setText('sttLangLabel', 'stt.langLabel');
      setText('sttHint', 'stt.hintBottom');
      setText('sttSave', 'stt.save');
      setText('sttClearKey', 'stt.clearKey');
      setText('panelCloseHint', 'panel.closeHint');
      setText('connDelete', 'conn.delete');
      setText('resetSelf', 'danger.resetSelf');

      updateMenuI18n();

      setText('researchTitle', 'research.title');
      setText('rRefreshBtn', 'research.refresh');
      const rTabMap = {
        state: 'research.tab.state',
        dreams: 'research.tab.dreams',
        provenance: 'research.tab.provenance',
        replay: 'research.tab.replay',
        windows: 'research.tab.windows',
        export: 'research.tab.export'
      };
      for (const [tab, key] of Object.entries(rTabMap)) {
        const el = document.querySelector(`.r-tab[data-rtab="${tab}"]`);
        if (el) el.textContent = t(key);
      }
      setText('rFooterStatus', 'research.footer.status');
      setText('rFooterHashes', 'research.footer.hashes');

      setText('rDreamsTitle', 'research.dreams.title');
      setText('rStateTitle', 'research.state.title');
      setText('rLexiconTitle', 'research.state.lexicon');
      setText('rExpectTitle', 'research.state.expect');
      setText('rHistoryTitle', 'research.state.history');
      setText('rObsTitle', 'research.obs.title');
      const subSubject = document.querySelector('#rStateSubtabs .r-subtab[data-subtab="subject"]');
      if (subSubject) subSubject.textContent = t('research.state.subtabSubject');
      const subObs = document.querySelector('#rStateSubtabs .r-subtab[data-subtab="obs"]');
      if (subObs) subObs.textContent = t('research.state.subtabObs');
      const subTraj = document.querySelector('#rStateSubtabs .r-subtab[data-subtab="trajectory"]');
      if (subTraj) subTraj.textContent = t('research.state.subtabTrajectory');
      setText('rTrajTitle', 'research.trajectory.title');
      syncObsToggleAllBtn();
      setText('rWindowSelectLabel', 'research.windows.selectLabel');
      document.querySelectorAll('.r-seg-btn').forEach(b => {
        const seg = b.dataset.seg;
        if (seg) b.textContent = t('research.windows.seg', '分段 ') + seg;
      });

      const subProv = document.querySelector('#rPaneProvenance .r-subtab[data-subtab="prov"]');
      if (subProv) subProv.textContent = t('research.prov.tabProv');
      const subEoi = document.querySelector('#rPaneProvenance .r-subtab[data-subtab="eoi"]');
      if (subEoi) subEoi.textContent = t('research.prov.tabEoi');
      const subRej = document.querySelector('#rPaneProvenance .r-subtab[data-subtab="rejected"]');
      if (subRej) subRej.textContent = t('research.prov.tabRejected');
      setPlaceholder('rScInput', 'research.prov.scPlaceholder');
      setText('rTraceBtn', 'research.prov.traceBtn');
      const rProvRes = document.getElementById('rProvResult');
      if (rProvRes && (!rProvRes.dataset.hasResult || rProvRes.dataset.hasResult === 'false') && rProvRes.children.length === 0) {
        rProvRes.textContent = t('research.prov.resultEmpty');
      }
      setPlaceholder('rEoiInput', 'research.prov.eoiPlaceholder');
      setText('rTraceEoiBtn', 'research.prov.traceEoiBtn');
      const rEoiRes = document.getElementById('rEoiResult');
      if (rEoiRes && (!rEoiRes.dataset.hasResult || rEoiRes.dataset.hasResult === 'false') && rEoiRes.children.length === 0) {
        rEoiRes.textContent = t('research.prov.eoiEmpty');
      }

      setText('rReplayTitle', 'research.replay.title');
      setText('rReplayAllBtn', 'research.replay.allBtn');
      setText('rReplayCancelBtn', 'research.replay.cancelBtn');
      setPlaceholder('rReplayUntilWin', 'research.replay.untilPlaceholder');
      setText('rReplayUntilBtn', 'research.replay.untilBtn');
      const rProgStage = document.getElementById('rProgressStage');
      if (rProgStage && (!rProgStage.dataset.running || rProgStage.dataset.running === 'false')) {
        rProgStage.textContent = t('research.replay.ready');
      }

      setText('rExportTitle', 'research.export.title');
      setText('rExpGroupState', 'research.export.groupState');
      setText('rExpTrajJson', 'research.export.trajJson');
      setText('rExpTrajCsv', 'research.export.trajCsv');
      setText('rExpScCsv', 'research.export.scCsv');
      setText('rExpGroupEvidence', 'research.export.groupEvidence');
      setText('rExpEvCsv', 'research.export.evCsv');
      setText('rExpFullBundle', 'research.export.fullBundle');
      const rExpMeta = document.getElementById('rExportMeta');
      if (rExpMeta && (!rExpMeta.dataset.generated || rExpMeta.dataset.generated === 'false')) {
        rExpMeta.textContent = t('research.export.metaEmpty');
      }
      setText('rExportCopy', 'research.export.copyBtn');
      setText('rExportSave', 'research.export.saveBtn');
      setPlaceholder('rExportOutput', 'research.export.previewPlaceholder');
    }

    const connPresetSelect = document.getElementById('connPresetSelect');
    const presetLabel = document.getElementById('presetLabel');
    const presetHint = document.getElementById('presetHint');
    const keyDetectHint = document.getElementById('keyDetectHint');

    function renderProviderPanel() {
      if (presetLabel) presetLabel.textContent = t('preset.section');
      if (connPresetSelect) {
        for (const opt of connPresetSelect.options) {
          const p = getPreset(opt.value);
          if (p) opt.textContent = t(p.nameKey);
        }
      }
    }

    function applyPreset(id) {
      const p = getPreset(id);
      if (!p) return;
      const set = (gid, v) => { const el = document.getElementById(gid); if (el) el.value = v == null ? '' : v; };
      set('connName', t(p.nameKey));
      set('connProvider', p.providerId);
      set('connProtocol', p.protocol);
      set('connUrl', p.baseURL);
      set('connModel', p.model);
    }

    if (connPresetSelect) connPresetSelect.addEventListener('change', () => applyPreset(connPresetSelect.value));

    function onKeyDetect(e) {
      const det = detectProviderByKey(e.target.value);
      pendingDetect = det;
      if (presetHint) {
        presetHint.textContent = det
          ? (t('detect.suggest') + ' ' + t(det.reasonKey) + ' [' + t('detect.apply') + ']')
          : '';
      }
    }
    const connKeyEl = document.getElementById('connKey');
    if (connKeyEl) {
      connKeyEl.addEventListener('input', onKeyDetect);
      connKeyEl.addEventListener('paste', () => setTimeout(() => onKeyDetect({ target: connKeyEl }), 0));
    }
    if (presetHint) presetHint.addEventListener('click', () => {
      if (pendingDetect) {
        applyPreset(pendingDetect.presetId);
        if (connPresetSelect) connPresetSelect.value = pendingDetect.presetId;
        pendingDetect = null;
        presetHint.textContent = '';
      }
    });

    function onQuickKeyDetect(e) {
      const det = detectProviderByKey(e.target.value);
      pendingQuickDetect = det;
      if (keyDetectHint) {
        keyDetectHint.textContent = det
          ? (t('detect.suggest') + ' ' + t(det.reasonKey) + ' [' + t('detect.apply') + ']')
          : '';
      }
    }
    const keyInputEl = document.getElementById('keyInput');
    if (keyInputEl) {
      keyInputEl.addEventListener('input', onQuickKeyDetect);
      keyInputEl.addEventListener('paste', () => setTimeout(() => onQuickKeyDetect({ target: keyInputEl }), 0));
    }
    if (keyDetectHint) keyDetectHint.addEventListener('click', () => {
      if (pendingQuickDetect) {
        applyPreset(pendingQuickDetect.presetId);
        if (connPresetSelect) connPresetSelect.value = pendingQuickDetect.presetId;
        if (connKeyEl && keyInputEl && keyInputEl.value) {
          connKeyEl.value = keyInputEl.value.trim();
          keyInputEl.value = '';
        }
        pendingQuickDetect = null;
        keyDetectHint.textContent = '';
      }
    });

    function splitMemorySegments(text) {
      const parts = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
      const her = [], you = [], other = [];
      for (const p of parts) {
        if (/^(?:用户事实|User facts?)[：:]/i.test(p)) you.push(p.replace(/^(?:用户事实|User facts?)[：:]\s*/i, ''));
        else if (/^(?:初澜经历|Chulan(?:'s)? experiences?)[：:]/i.test(p)) her.push(p.replace(/^(?:初澜经历|Chulan(?:'s)? experiences?)[：:]\s*/i, ''));
        else other.push(p);
      }
      return { her, you, other };
    }

    async function refreshMem() {
      const box = document.getElementById('memList');
      box.textContent = '';
      if (!api) {
        const p = document.createElement('div');
        p.className = 'empty';
        p.textContent = t('mem.preview');
        box.appendChild(p);
        return;
      }
      let list = [];
      try { list = await api.listMemory(); } catch { list = []; }
      if (!list.length) {
        const p = document.createElement('div');
        p.className = 'empty';
        p.textContent = t('mem.empty');
        box.appendChild(p);
        return;
      }
      let lastGroup = null, groupBody = null;
      list.forEach((m) => {
        const g = m.windowNo || (String(m.label).match(/窗口\s*#(\d+)/) || [])[1] || '';
        if (g !== lastGroup) {
          const card = document.createElement('div');
          card.className = 'fgroup';
          const head = document.createElement('div');
          head.className = 'fg-title';
          head.textContent = g ? (t('mem.window') + ' #' + g) : t('mem.other');
          groupBody = document.createElement('div');
          card.append(head, groupBody);
          box.appendChild(card);
          lastGroup = g;
        }
        const row = document.createElement('div');
        row.className = 'mem';

        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = String(m.label || '').replace(/^窗口\s*#/, t('mem.window') + ' #');

        const body = document.createElement('div');
        body.className = 'mem-body';
        const segs = splitMemorySegments(m.text);
        const pushSeg = (cls, headText, items) => {
          if (!items.length) return;
          const seg = document.createElement('div');
          seg.className = 'mem-seg ' + cls;
          const h = document.createElement('div');
          h.className = 'seg-head';
          h.textContent = headText;
          const b = document.createElement('div');
          b.className = 'seg-body';
          b.textContent = items.join('\n');
          seg.append(h, b);
          body.appendChild(seg);
        };
        pushSeg('her', t('mem.her'), segs.her);
        pushSeg('you', t('mem.you'), segs.you);
        pushSeg('other', t('mem.other'), segs.other);

        row.append(tag, body);
        groupBody.appendChild(row);
      });
    }

    function ticketStateTagText(state) {
      if (state === 'paused') return t('tickets.state.paused', '暂停');
      if (state === 'ended') return t('tickets.state.ended', '已结束');
      return t('tickets.state.open', '进行中');
    }

    function renderTicketRow(ticket) {
      const row = document.createElement('div');
      row.className = 'mem';

      const head = document.createElement('div');
      head.className = 'row';

      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = ticketStateTagText(ticket && ticket.state);

      const titleEl = document.createElement('span');
      titleEl.textContent = String((ticket && ticket.title) || '');
      head.append(tag, titleEl);
      row.appendChild(head);

      if (ticket && ticket.note) {
        const noteEl = document.createElement('div');
        noteEl.className = 'hint';
        noteEl.textContent = String(ticket.note);
        row.appendChild(noteEl);
      }

      return row;
    }

    function collapsedTicketGroup(endedTickets) {
      const details = document.createElement('details');
      details.className = 'fgroup';
      const summary = document.createElement('summary');
      summary.className = 'fg-title';
      summary.textContent = t('tickets.endedGroup', { n: endedTickets.length });
      details.appendChild(summary);
      for (const tkt of endedTickets) {
        details.appendChild(renderTicketRow(tkt));
      }
      return details;
    }

    async function refreshTickets() {
      const list = document.getElementById('ticketList');
      if (!list) return;
      const agentApi = api && api.agent;
      if (!agentApi || typeof agentApi.ticketList !== 'function') {
        const p = document.createElement('div');
        p.className = 'empty';
        p.textContent = t('tickets.preview', '当前预览模式不可用');
        list.replaceChildren(p);
        return;
      }
      try {
        const r = await agentApi.ticketList();
        const tickets = (r && r.ok && Array.isArray(r.tickets)) ? r.tickets : [];
        if (!tickets.length) {
          const p = document.createElement('div');
          p.className = 'empty';
          p.textContent = t('tickets.empty', '还没有记录任何事项');
          list.replaceChildren(p);
          return;
        }
        const active = tickets
          .filter((item) => item && item.state !== 'ended')
          .slice()
          .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
        const ended = tickets
          .filter((item) => item && item.state === 'ended')
          .slice()
          .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
        list.replaceChildren(
          ...active.map(renderTicketRow),
          ...(ended.length ? [collapsedTicketGroup(ended)] : [])
        );
      } catch {
        const p = document.createElement('div');
        p.className = 'empty';
        p.textContent = t('tickets.readFailed', '读取失败');
        list.replaceChildren(p);
      }
    }

    async function refreshStats() {
      const el = document.getElementById('stats');
      if (!api) { el.textContent = t('stats.preview'); return; }
      const r = await api.report();
      const g = await api.getConfig();
      if (!r) { el.textContent = '—'; return; }
      const low = r.requests > 3 && r.rate < 90;

      el.textContent = '';

      const b = (text) => {
        const bElem = document.createElement('b');
        bElem.textContent = String(text);
        return bElem;
      };
      const span = (text, cls, id) => {
        const spanElem = document.createElement('span');
        spanElem.textContent = String(text);
        if (cls) spanElem.className = cls;
        if (id) spanElem.id = id;
        return spanElem;
      };
      const br = () => document.createElement('br');

      el.append(t('stats.requests') + ' ', b(r.requests), (t('stats.times') ? ' ' + t('stats.times') : '') + '　' + t('stats.model') + ' ', span(r.model, '', 'stModel'));
      if (r.peak) el.append(' ', span(t('stats.peak'), 'warn'));
      el.appendChild(br());

      el.append(t('stats.rate') + ' ', b(r.rate + '%'));
      if (low) el.append(' ', span(t('stats.low'), 'warn'));
      el.appendChild(br());

      el.append(t('stats.last') + ' ', b(r.lastRate + '%'), '　' + t('stats.hit') + ' ' + r.hit + ' / ' + t('stats.miss') + ' ' + r.miss + ' tok');
      el.appendChild(br());

      el.append(t('stats.output') + ' ' + r.out + ' tok　' + t('stats.cost') + ' ', b('¥' + r.cost));
      el.appendChild(br());

      el.append(
        t('stats.window') + r.windowNo + t('stats.windowSeg') + '　',
        b(r.windowTurns + '/' + r.windowTarget),
        ' ' + t('stats.turns') + '　~' + r.historyTokens + ' tok　' + t('stats.context') + ' ~' + r.contextTokens + ' tok'
      );
      el.appendChild(br());

      el.append(
        t('stats.memSummary') + ' ' + r.segments + ' ' + t('stats.memSummariesCount') + '　',
        b(r.memoryTokens + '/' + r.memoryCap),
        ' tok　' + t('stats.compressions') + ' ' + r.compressions + ' ' + t('stats.times') + '　' + t('stats.merges') + ' ' + r.merges + ' ' + t('stats.times')
      );

      document.getElementById('keyState').textContent =
        g.hasKey
          ? (g.keyEncrypted ? t('conn.keyState.enc') : t('conn.keyState.plain'))
          : t('conn.keyState.none');
    }

    async function refreshDreams() {
      const box = document.getElementById('dreamList');
      if (!box) return;
      box.textContent = '';
      if (!api || !api.dreamList) { box.textContent = '—'; return; }
      try {
        const r = await api.dreamList();
        if (!r || !r.ok) { box.textContent = t('dreams.readFailed', '（读取失败）'); return; }
        const list = r.dreams || [];
        if (!list.length) { box.textContent = t('dreams.empty', '（暂无 —— 还没有做过梦）'); return; }
        list.forEach((d, i) => {
          const card = document.createElement('div');
          card.className = 'dream-card';
          const h = document.createElement('div');
          h.className = 'dream-no';
          const when = d.generatedAt ? new Date(d.generatedAt).toLocaleString() : '';
          h.textContent = t('dreams.count', '第 {count} 次', { count: i + 1 }) + (when ? ' · ' + when : '');
          const body = document.createElement('div');
          body.className = 'dream-body';
          body.textContent = d.text || t('dreams.noText', '（无文本）');
          const meta = document.createElement('div');
          meta.className = 'dream-meta';
          const statusPart = d.epistemicStatus ? d.epistemicStatus + ' · ' : '';
          meta.textContent = t('dreams.metaPattern', '窗口 #{win} · {status}{recon}', {
            win: d.windowNo || '?',
            status: statusPart,
            recon: t('dreams.reconstructed', '（离线重组，非亲历）')
          });
          card.append(h, body, meta);
          box.appendChild(card);
        });
      } catch (e) { box.textContent = t('dreams.readException', '（读取异常）'); }
    }

    function selectPanelSection(key) {
      const k = PANEL_SECTIONS.includes(key) ? key : 'conn';
      for (const it of document.querySelectorAll('.pnav-item')) it.classList.toggle('on', it.dataset.sec === k);
      for (const sec of document.querySelectorAll('#panel .psec')) sec.classList.toggle('on', sec.dataset.sec === k);
      try { localStorage.setItem('panelSection', k); } catch (e) { /* 存不下不致命 */ }
      if (k === 'tickets') refreshTickets();
    }

    for (const it of document.querySelectorAll('.pnav-item')) {
      it.addEventListener('click', () => selectPanelSection(it.dataset.sec));
    }
    selectPanelSection((() => { try { return localStorage.getItem('panelSection'); } catch (e) { return 'conn'; } })());

    function connSay(text) {
      const el = document.getElementById('connState');
      if (el) el.textContent = text;
    }

    function fillConnEditor(connectionId) {
      const c = connItems.find((x) => x.connectionId === connectionId);
      if (!c) return;
      connSelectedId = connectionId;
      const mappedProvider = ['deepseek', 'local', 'custom'].includes(c.providerId) ? c.providerId : 'custom';
      const mappedProtocol = c.protocol === 'anthropic-native' ? 'anthropic-native' : 'openai-compatible';
      document.getElementById('connName').value = c.displayName || '';
      document.getElementById('connProvider').value = mappedProvider;
      document.getElementById('connProtocol').value = mappedProtocol;
      document.getElementById('connUrl').value = c.baseURL || '';
      document.getElementById('connModel').value = c.activeModel || '';
      document.getElementById('connKey').value = '';
      if (connPresetSelect) {
        const normBase = String(c.baseURL || '').trim().replace(/\/+$/, '');
        const matched = Array.from(connPresetSelect.options)
          .map((opt) => getPreset(opt.value))
          .find((p) => p && p.id !== 'custom' && p.providerId === mappedProvider && p.baseURL &&
            p.baseURL.replace(/\/+$/, '') === normBase);
        connPresetSelect.value = matched ? matched.id : 'custom';
      }
      connSay(t('conn.credentialPrefix', '凭据：') + (c.hasCredential ? (c.keyEncrypted ? t('conn.encrypted', '已加密存储') : t('conn.plain', '明文降级存储')) : t('conn.unconfigured', '未配置')) +
        t('conn.testStatusPrefix', '；测试状态：') + ((c.testState && c.testState.status) || 'unverified'));
    }

    async function refreshConnections() {
      if (!api || !api.connections) return;
      const r = await api.connections.list();
      if (!r || r.ok === false) return connSay(t('conn.listReadFailed', '连接列表读取失败：') + ((r && r.error) || t('conn.unknownErr', '未知错误')));
      connItems = Array.isArray(r.items) ? r.items : [];
      const sel = document.getElementById('connList');
      sel.textContent = '';
      for (const c of connItems) {
        const opt = document.createElement('option');
        opt.value = c.connectionId;
        opt.textContent = c.displayName + '（' + c.providerId + ' / ' + c.protocol + '）' +
          (c.connectionId === r.activeConnectionId ? t('conn.activeMarker', ' ★当前') : '');
        sel.appendChild(opt);
      }
      const act = document.getElementById('connActive');
      if (act) act.textContent = '';
      if (connItems.length > 0) {
        const pick = connItems.some((c) => c.connectionId === connSelectedId) ? connSelectedId
          : (connItems.some((c) => c.connectionId === r.activeConnectionId) ? r.activeConnectionId : connItems[0].connectionId);
        sel.value = pick;
        fillConnEditor(pick);
      } else {
        connSay(t('conn.none', '尚无连接'));
      }
    }

    function connEditorFields() {
      return {
        displayName: document.getElementById('connName').value.trim(),
        providerId: document.getElementById('connProvider').value,
        protocol: document.getElementById('connProtocol').value,
        baseURL: document.getElementById('connUrl').value.trim(),
        model: document.getElementById('connModel').value.trim()
      };
    }

    document.getElementById('connList').addEventListener('change', (e) => fillConnEditor(e.target.value));

    document.getElementById('connNew').addEventListener('click', async () => {
      if (!api || !api.connections) return;
      const key = document.getElementById('connKey').value;
      const r = await api.connections.create({ ...connEditorFields(), credential: key || undefined });
      if (!r || r.ok === false) return connSay(t('conn.createFailedPrefix', '新建失败：') + ((r && r.error) || t('conn.unknownErr', '未知错误')));
      document.getElementById('connKey').value = '';
      connSay(t('conn.created', '已新建连接（credential 仅写入，不回显）'));
      await refreshConnections();
    });

    document.getElementById('connSave').addEventListener('click', async () => {
      if (!api || !api.connections || !connSelectedId) return;
      const key = document.getElementById('connKey').value;
      const cur = connItems.find((x) => x.connectionId === connSelectedId);
      if (key && cur && cur.hasCredential) {
        if (!window.confirm(t('conn.overwriteKeyConfirm', '这条连接已经有 Key 了。继续保存会用你刚才输入的 Key 覆盖它 —— 确认要覆盖吗？'))) {
          return;
        }
      }
      const r = await api.connections.update(connSelectedId, connEditorFields(), key || undefined);
      if (!r || r.ok === false) return connSay(t('conn.saveFailedPrefix', '保存失败：') + ((r && r.error) || t('conn.unknownErr', '未知错误')));
      document.getElementById('connKey').value = '';
      connSay(t('conn.saved', '已保存'));
      await refreshConnections();
    });

    document.getElementById('connTest').addEventListener('click', async () => {
      if (!api || !api.connections) return;
      const cur = connSelectedId ? connItems.find((x) => x.connectionId === connSelectedId) : null;
      if (!cur) {
        return connSay(t('conn.testNeedCreate', '当前配置尚未建档，请先点击「＋ 新建连接」保存后再测试'));
      }
      const f = connEditorFields();
      const keyDraft = document.getElementById('connKey').value;
      const curProvider = ['deepseek', 'local', 'custom'].includes(cur.providerId) ? cur.providerId : 'custom';
      const curProtocol = cur.protocol === 'anthropic-native' ? 'anthropic-native' : 'openai-compatible';
      const dirty = keyDraft.length > 0 ||
        f.displayName !== String(cur.displayName || '').trim() ||
        f.providerId !== curProvider ||
        f.protocol !== curProtocol ||
        f.baseURL !== String(cur.baseURL || '').trim() ||
        f.model !== String(cur.activeModel || '').trim();
      if (dirty) {
        return connSay(t('conn.testNeedSave', '表单有未保存改动，请先点击「💾 保存修改」或「＋ 新建连接」后再测试'));
      }
      connSay(t('conn.testing', '测试中…（可能发起一次极小计费请求）'));
      const r = await api.connections.test(connSelectedId);
      if (!r || r.ok === false) return connSay(t('conn.testFailedPrefix', '测试失败：') + ((r && r.error) || t('conn.unknownErr', '未知错误')));
      if (r.status === 'verified') connSay(t('conn.verifiedPrefix', '已验证成功（') + r.phase + '）');
      else if (r.status === 'failed') connSay(t('conn.verifiedFailed', '验证失败（{phase}）：{reason}', { phase: r.phase, reason: r.reason || '' }));
      else connSay(t('conn.unverified', '未验证（证据不足）：{detail}', { detail: r.reason || r.phase }));
      await refreshConnections();
    });

    document.getElementById('connActivate').addEventListener('click', async () => {
      if (!api || !api.connections || !connSelectedId) return;
      const r = await api.connections.activate(connSelectedId);
      if (!r || r.ok === false) return connSay(t('conn.switchFailedPrefix', '切换失败（保持原连接）：') + ((r && r.error) || t('conn.unknownErr', '未知错误')));
      connSay(r.swapped ? t('conn.switched', '已切换到该连接') : t('conn.alreadyActive', '该连接已是当前活动连接'));
      await refreshConnections();
      refreshStats();
    });

    function armDangerButton(btn, onFire) {
      if (!btn) return;
      let state = 'idle';
      let timer = null;
      let tick = null;
      let label = btn.textContent;
      const reset = () => {
        state = 'idle';
        if (timer) { clearTimeout(timer); timer = null; }
        if (tick) { clearInterval(tick); tick = null; }
        btn.classList.remove('armed', 'cooling');
        btn.disabled = false;
        btn.textContent = label;
      };
      btn.addEventListener('click', () => {
        if (state === 'cooling') return;
        if (state === 'idle') {
          state = 'cooling';
          label = btn.textContent;
          btn.classList.add('cooling');
          btn.disabled = true;
          let left = 5;
          btn.textContent = t('danger.cooling') + '（' + left + 's）';
          tick = setInterval(() => {
            left -= 1;
            if (left > 0) { btn.textContent = t('danger.cooling') + '（' + left + 's）'; return; }
            if (tick) { clearInterval(tick); tick = null; }
            state = 'armed';
            btn.disabled = false;
            btn.classList.remove('cooling');
            btn.classList.add('armed');
            btn.textContent = t('danger.armAgain');
            timer = setTimeout(reset, 8000);
          }, 1000);
          return;
        }
        reset();
        onFire();
      });
    }

    async function doDeleteConnection() {
      if (!api || !api.connections || !connSelectedId) return;
      const ok = window.confirm(t('conn.deleteConfirm', '此操作将删除该 Connection，并在该凭据属于 exclusive credential 时删除对应凭据（legacy-mapped 凭据只删除 Connection，不删除 legacy 凭据）。确定继续吗？'));
      if (!ok) return;
      const r = await api.connections.delete(connSelectedId, true);
      if (!r || r.ok === false) return connSay(t('conn.deleteFailedPrefix', '删除失败：') + ((r && r.error) || t('conn.unknownErr', '未知错误')));
      connSay(r.credentialDeleted ? t('conn.deletedExclusive', '连接及其独占凭据已删除') : t('conn.deletedKeepCred', '连接已删除（凭据保留：{note}）', { note: r.credentialNote || t('chat.wearUnexecuted', '未删除') }));
      await refreshConnections();
    }
    armDangerButton(document.getElementById('connDelete'), doDeleteConnection);

    async function saveSttConfig() {
      if (!api || !api.stt || typeof api.stt.setConfig !== 'function') return;
      const el = (id) => document.getElementById(id);
      const patch = {
        endpoint: el('sttUrl') ? el('sttUrl').value.trim() : '',
        model: el('sttModel') ? el('sttModel').value.trim() : '',
        lang: el('sttLang') ? el('sttLang').value : ''
      };
      const key = el('sttKey') ? el('sttKey').value.trim() : '';
      if (key) patch.credential = key;

      let r = null;
      try { r = await api.stt.setConfig(patch); } catch (e) { r = null; }
      const statusEl = document.getElementById('sttStatus');
      if (r && r.ok) {
        if (el('sttKey')) el('sttKey').value = '';
        if (statusEl) statusEl.textContent = t('stt.saved', '已保存');
        await refreshSttPanel();
      } else if (statusEl) {
        statusEl.textContent = r && r.errorType === 'config_write_failed'
          ? t('stt.configSaveFailed', '语音识别设置保存失败')
          : ((r && r.error) ? String(r.error) : t('stt.failed', '识别失败'));
      }
    }

    async function clearSttKey() {
      if (!api || !api.stt || typeof api.stt.clearKey !== 'function') return;
      try { await api.stt.clearKey(); } catch (e) { /* 清不掉就下次再清 */ }
      await refreshSttPanel();
    }

    {
      const presetEl = document.getElementById('sttPreset');
      if (presetEl) {
        presetEl.addEventListener('change', () => {
          const p = STT_PRESETS[presetEl.value];
          if (!p) return;
          const url = document.getElementById('sttUrl');
          const model = document.getElementById('sttModel');
          if (url) url.value = p.endpoint;
          if (model) model.value = p.model;
        });
      }
      const saveBtn = document.getElementById('sttSave');
      if (saveBtn) saveBtn.addEventListener('click', saveSttConfig);
      const clearBtn = document.getElementById('sttClearKey');
      if (clearBtn) clearBtn.addEventListener('click', clearSttKey);
      refreshSttPanel();
    }

    document.getElementById('keySave').addEventListener('click', async () => {
      const v = document.getElementById('keyInput').value.trim();
      if (!v) return;
      if (api) {
        const r = await api.setKey(v);
        if (r && r.ok === false) return say(t('say.saveKeyFailed', '保存 Key 失败：') + r.error);
        document.getElementById('keyInput').value = '';
        if (keyDetectHint) keyDetectHint.textContent = '';
        pendingQuickDetect = null;
      }
      refreshStats();
      say(t('say.nowCanTalk', '好啦，现在能跟我说话了~'));
    });

    document.getElementById('openCfg').addEventListener('click', () => api && api.openConfig());

    async function doResetSelf() {
      if (!api || !api.resetSelfLedger) return;
      const ok = window.confirm(t('danger.resetConfirm', '这会删除初澜出生以来的成长档案，并把她视为一次新的出生。确定继续吗？'));
      if (!ok) return;
      const res = await api.resetSelfLedger(true);
      if (!res || !res.ok) return say(t('say.resetFailed', '成长档案重置失败：') + ((res && res.error) || t('conn.unknownErr', '未知错误')));
      refreshStats();
      say(t('say.reacquaint', '好，我们从现在重新认识。'));
    }
    armDangerButton(document.getElementById('resetSelf'), doResetSelf);

    function openPanel() {
      closeOtherOverlays('panel');
      panel.classList.remove('hidden');
      syncMotionPriority();
      syncPanelViewport();
      refreshStats();
      refreshMem();
      refreshTickets();
      const refreshWardrobeFn = getRefreshWardrobe();
      if (typeof refreshWardrobeFn === 'function') refreshWardrobeFn();
      renderSandboxPanel();
      refreshSttPanel();
    }

    function closePanel() {
      panel.classList.add('hidden');
      syncMotionPriority();
      syncPanelViewport();
    }
    if (panel) panel.addEventListener('contextmenu', (e) => { e.preventDefault(); closePanel(); });

    if (langSelect) {
      if (typeof UI_LOCALE !== 'undefined' && UI_LOCALE) langSelect.value = UI_LOCALE;
      langSelect.addEventListener('change', () => {
        setLocale(langSelect.value);
        renderI18nPanel();
        renderProviderPanel();
        const chatTitleEl = document.getElementById('chatTitle');
        if (chatTitleEl) chatTitleEl.textContent = t('chat.title');
        refreshMem();
        refreshTickets();
        const refreshWardrobeFn = getRefreshWardrobe();
        if (typeof refreshWardrobeFn === 'function') refreshWardrobeFn();
        refreshStats();
      });
    }
    renderI18nPanel();
    renderProviderPanel();
    refreshConnections();

    return {
      openPanel,
      closePanel,
      selectPanelSection,
      renderI18nPanel,
      renderProviderPanel,
      renderTimezonePanel,
      renderSandboxPanel,
      refreshStats,
      refreshMem,
      refreshTickets,
      refreshConnections,
      refreshSttPanel,
      refreshLifeMechanisms,
      renderObsGroups,
      refreshDreams,
      setCompassBirthAt: (v) => { compassBirthAt = v; }
    };
  }

  if (typeof window !== 'undefined') {
    window.LifeUiSettings = { initSettings, PANEL_SECTIONS, STT_PRESETS };
  }
})();
