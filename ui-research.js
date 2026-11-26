(() => {
  /**
   * 实验观测与可复盘工具面板控制器 (v0.9.5)：
   * 主体状态、窗口/轮次、EOI 与被拒证据溯源、Replay 串行轮询与取消、SHA-256 只读完整性校验及数据导出。
   */
  function initResearch(ctx) {
    const {
      researchPanel, api, t, formatDisplayTime,
      closeOtherOverlays, syncMotionPriority, syncPanelViewport,
      refreshLifeMechanisms, refreshDreams
    } = ctx;

    let currentResearchHashes = null;
    let activeReplayPollingTimer = null;
    let currentSelectedTrait = null;
    let currentSelectedWindowNo = 1;
    let currentSelectedSegIndex = 1;

    function stopReplayPolling() {
      if (activeReplayPollingTimer) {
        clearTimeout(activeReplayPollingTimer);
        activeReplayPollingTimer = null;
      }
    }

    function switchResearchTab(tabName) {
      document.querySelectorAll('.r-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.rtab === tabName);
      });
      document.querySelectorAll('.r-pane').forEach(p => p.classList.add('hidden'));

      const paneMap = {
        state: document.getElementById('rPaneState'),
        windows: document.getElementById('rPaneWindows'),
        provenance: document.getElementById('rPaneProvenance'),
        replay: document.getElementById('rPaneReplay'),
        export: document.getElementById('rPaneExport'),
        dreams: document.getElementById('rPaneDreams')
      };

      if (paneMap[tabName]) paneMap[tabName].classList.remove('hidden');
    }

    function switchStateSubtab(which) {
      const name = which === 'obs' ? 'obs' : 'subject';
      document.querySelectorAll('#rStateSubtabs .r-subtab').forEach((b) => {
        b.classList.toggle('active', b.dataset.subtab === name);
      });
      const sub = document.getElementById('rSubPaneSubject');
      const obs = document.getElementById('rSubPaneObs');
      if (sub) sub.classList.toggle('hidden', name !== 'subject');
      if (obs) obs.classList.toggle('hidden', name !== 'obs');
    }

    async function loadTraitHistory(trait) {
      const box = document.getElementById('rTraitHistory');
      if (!box) return;
      box.textContent = '';

      if (!api || !api.research) {
        box.textContent = t('research.state.previewHistory', '[{trait}] 预览历史：Window #1: 0 → +15 (Δ+15)', { trait });
        return;
      }

      try {
        const res = await api.research.getStateChanges({ trait, limit: 100 });
        const items = (res && res.items) || [];
        if (!items.length) {
          box.textContent = t('research.state.noHistory', '特质 [{trait}] 暂无状态跃迁历史', { trait });
          return;
        }

        for (const sc of items) {
          const row = document.createElement('div');
          row.className = 'r-table-row r-history-row';

          const left = document.createElement('div');
          left.className = 'r-hist-left';
          const winBadge = document.createElement('span');
          winBadge.className = 'r-badge badge-recorded';
          winBadge.textContent = `W#${sc.windowNo || 1}`;
          const trans = document.createElement('span');
          trans.className = 'r-hist-trans';
          trans.textContent = `${sc.previousValue ?? 0} → ${sc.newValue ?? 0}`;
          left.append(winBadge, trans);

          const right = document.createElement('div');
          right.className = 'r-hist-right';
          const d = sc.delta ?? 0;
          const dPill = document.createElement('span');
          dPill.className = 'r-trait-delta ' + (d > 0 ? 'r-delta-pos' : (d < 0 ? 'r-delta-neg' : 'r-delta-zero'));
          dPill.textContent = d > 0 ? `+${d}` : String(d);
          const idSpan = document.createElement('span');
          idSpan.className = 'r-chip-cite';
          idSpan.textContent = sc.stateChangeId || '';
          const traceHint = document.createElement('span');
          traceHint.className = 'r-chip-trace';
          traceHint.textContent = t('research.state.traceBtn', '溯源 ↗');
          right.append(dPill, idSpan, traceHint);

          row.append(left, right);
          row.style.cursor = 'pointer';
          row.title = t('research.state.clickToTrace', '点击跳转至溯源');
          row.addEventListener('click', () => {
            switchResearchTab('provenance');
            const scInput = document.getElementById('rScInput');
            if (scInput) scInput.value = sc.stateChangeId || sc.changeId || '';
            runTraceProvenance(sc.stateChangeId || sc.changeId);
          });

          box.appendChild(row);
        }
      } catch (e) {
        box.textContent = t('research.state.loadHistoryFailedPrefix', '加载历史失败: ') + e.message;
      }
    }

    function renderSubjectStateTab(state) {
      const container = document.getElementById('rTraitsList');
      if (!container) return;
      container.textContent = '';

      const traits = (state && state.traits) || {};
      const TRAIT_LABELS = {
        quiet_preference: '安静偏好',
        social_initiative: '社交主动',
        attachment_need: '依恋渴望',
        vitality: '生命活力',
        philosophical_curiosity: '哲学好奇',
        self_continuity: '自我同一',
        meaning_presence: '生命意义',
        self_clarity: '自我清晰'
      };
      const traitNames = [
        'quiet_preference',
        'social_initiative',
        'attachment_need',
        'vitality',
        'philosophical_curiosity',
        'self_continuity',
        'meaning_presence',
        'self_clarity'
      ];

      for (const tName of traitNames) {
        const info = traits[tName] || { current: 0, previous: 0, latestDelta: 0 };
        const card = document.createElement('div');
        card.className = 'r-trait-card' + (currentSelectedTrait === tName ? ' selected' : '');
        card.dataset.trait = tName;

        const titleWrap = document.createElement('div');
        titleWrap.className = 'r-trait-title-wrap';
        const titleEl = document.createElement('div');
        titleEl.className = 'r-trait-name';
        titleEl.textContent = t('trait.' + tName, TRAIT_LABELS[tName] || tName);
        const keyEl = document.createElement('div');
        keyEl.className = 'r-trait-key';
        keyEl.textContent = tName;
        titleWrap.append(titleEl, keyEl);

        const delta = info.latestDelta ?? 0;
        const deltaStr = delta > 0 ? `+${delta}` : String(delta);
        const deltaCls = delta > 0 ? 'r-delta-pos' : (delta < 0 ? 'r-delta-neg' : 'r-delta-zero');

        const numGroup = document.createElement('div');
        numGroup.className = 'r-trait-val-wrap';
        const valEl = document.createElement('div');
        valEl.className = 'r-trait-val';
        valEl.textContent = String(info.current ?? 0);
        const deltaEl = document.createElement('span');
        deltaEl.className = 'r-trait-delta ' + deltaCls;
        deltaEl.textContent = deltaStr;
        numGroup.append(valEl, deltaEl);

        const headEl = document.createElement('div');
        headEl.className = 'r-trait-head';
        headEl.append(titleWrap, numGroup);

        const metaEl = document.createElement('div');
        metaEl.className = 'r-trait-meta';
        const prevSpan = document.createElement('span');
        prevSpan.className = 'r-trait-prev';
        prevSpan.textContent = t('research.state.prevShort', '前值 {prev}', { prev: info.previous ?? 0 });
        const hintSpan = document.createElement('span');
        hintSpan.className = 'r-trait-hint';
        hintSpan.textContent = t('research.state.traitClickHint', '查看演化 ▸');
        metaEl.append(prevSpan, hintSpan);

        const barWrap = document.createElement('div');
        barWrap.className = 'r-trait-bar-wrap';
        const barMid = document.createElement('div');
        barMid.className = 'r-trait-bar-mid';
        const barFill = document.createElement('div');
        const curVal = Math.max(-999, Math.min(999, Number(info.current) || 0));
        if (curVal >= 0) {
          const pct = Math.min(50, (curVal / 999) * 50);
          barFill.style.left = '50%';
          barFill.style.width = pct + '%';
          barFill.className = 'r-trait-bar-fill pos';
        } else {
          const pct = Math.min(50, (Math.abs(curVal) / 999) * 50);
          barFill.style.left = (50 - pct) + '%';
          barFill.style.width = pct + '%';
          barFill.className = 'r-trait-bar-fill neg';
        }
        barWrap.append(barMid, barFill);

        const scaleEl = document.createElement('div');
        scaleEl.className = 'r-trait-scale';
        for (const mark of ['-999', '0', '+999']) {
          const m = document.createElement('span');
          m.textContent = mark;
          scaleEl.appendChild(m);
        }

        card.append(headEl, barWrap, scaleEl, metaEl);
        card.addEventListener('click', () => {
          document.querySelectorAll('.r-trait-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          currentSelectedTrait = tName;
          loadTraitHistory(tName);
        });

        container.appendChild(card);
      }

      if (!currentSelectedTrait) {
        currentSelectedTrait = traitNames[0];
      }
      loadTraitHistory(currentSelectedTrait);
    }

    function renderRoundsDemo(segIdx) {
      const box = document.getElementById('rRoundsList');
      if (!box) return;
      box.textContent = '';
      for (let r = (segIdx - 1) * 20 + 1; r <= segIdx * 20; r++) {
        const item = document.createElement('div');
        item.className = 'r-round-item';
        item.textContent = t('research.rounds.demoRound', '第 {r} 轮 (UNRESOLVED): [演示环境未连接后端]', { r });
        box.appendChild(item);
      }
    }

    function renderWindowDetailDemo(wNo) {
      const card = document.getElementById('rWindowSummaryCard');
      if (card) {
        card.textContent = t('research.windows.demoSummary', '[演示] Window #{win} | 100 轮 | 200 条消息 | 5 分段 | 状态完整认证', { win: wNo });
      }
      renderRoundsDemo(1);
    }

    function renderStateDemo() {
      renderSubjectStateTab({
        traits: {
          quiet_preference: { current: 347, previous: 320, latestDelta: 27 },
          social_initiative: { current: 118, previous: 110, latestDelta: 8 },
          attachment_need: { current: 205, previous: 205, latestDelta: 0 },
          vitality: { current: 421, previous: 400, latestDelta: 21 },
          philosophical_curiosity: { current: 286, previous: 270, latestDelta: 16 },
          self_continuity: { current: 152, previous: 150, latestDelta: 2 },
          meaning_presence: { current: 96, previous: 96, latestDelta: 0 },
          self_clarity: { current: 131, previous: 122, latestDelta: 9 }
        }
      });
    }

    async function loadRounds(windowNo, segmentIndex) {
      const box = document.getElementById('rRoundsList');
      if (!box) return;
      box.textContent = '';

      if (!api || !api.research) {
        renderRoundsDemo(segmentIndex);
        return;
      }

      try {
        const rounds = await api.research.getWindowRounds({ windowNo, segmentIndex });
        if (!Array.isArray(rounds) || !rounds.length) {
          box.textContent = t('research.windows.noSegRounds', '分段 {seg} 暂无消息轮次', { seg: segmentIndex });
          return;
        }

        for (const rd of rounds) {
          const item = document.createElement('div');
          const hasU = !!(rd.userMessage && rd.userMessage.content != null);
          const hasA = !!(rd.assistantMessage && rd.assistantMessage.content != null);

          let badgeClass = 'badge-active';
          const status = String(rd.status || rd.tag || '').toUpperCase();
          if (rd.bridge === true || status === 'BRIDGE') badgeClass = 'badge-bridge';
          else if (status === 'RECORDED') badgeClass = 'badge-recorded';
          else if (status === 'NOT_RECORDED') badgeClass = 'badge-not-recorded';
          else if (status === 'UNRESOLVED') badgeClass = 'badge-unresolved';
          else if (status === 'CORRUPTED') badgeClass = 'badge-corrupted';
          else if (status === 'MISSING') badgeClass = 'badge-missing';
          else if (status === 'ACTIVE') badgeClass = 'badge-active';
          const badge = document.createElement('span');
          badge.className = 'r-badge ' + badgeClass;
          badge.textContent = rd.tag || rd.status || (rd.bridge ? 'BRIDGE' : (rd.bridge === false ? 'ACTIVE' : 'UNRESOLVED'));

          const statusDesc = rd.status === 'NOT_RECORDED' ? t('research.rounds.notRecorded', '未记录交互')
            : (rd.status === 'UNRESOLVED' ? t('research.rounds.unresolved', '无法确定：证据不完整')
            : (rd.status === 'CORRUPTED' ? t('research.rounds.corrupted', '记录损坏')
            : (rd.status === 'MISSING' ? t('research.rounds.missing', '记录缺失') : (rd.status || t('research.rounds.notRecorded', '未记录交互')))));

          if (!hasU && !hasA) {
            item.className = 'r-round-item compact';
            const left = document.createElement('span');
            left.textContent = (typeof rd.roundNo === 'number' ? t('research.rounds.roundNum', '第 {num} 轮', { num: rd.roundNo }) : t('research.rounds.roundUndetermined', '[未确定轮次]'))
              + ' · ' + statusDesc;
            item.append(left, badge);
            box.appendChild(item);
            continue;
          }

          item.className = 'r-round-item';
          const head = document.createElement('div');
          head.className = 'r-round-head';
          const rTitle = document.createElement('span');
          rTitle.className = 'r-round-no';
          rTitle.textContent = typeof rd.roundNo === 'number' ? t('research.rounds.roundNum', '第 {num} 轮', { num: rd.roundNo }) : t('research.rounds.roundUndetermined', '[未确定轮次]');
          head.append(rTitle, badge);

          const mkMsg = (msg, label, cls) => {
            const wrap = document.createElement('div');
            if (msg && msg.content != null) {
              wrap.className = 'r-msg';
              const idc = document.createElement('span');
              idc.className = 'r-msg-id';
              idc.textContent = msg.messageId ? `[${msg.messageId}]` : '';
              const rl = document.createElement('span');
              rl.className = 'r-msg-role ' + cls;
              rl.textContent = label;
              const tx = document.createElement('span');
              tx.className = 'r-msg-text';
              tx.textContent = msg.content;
              wrap.append(idc, rl, tx);
            } else {
              wrap.className = 'r-msg r-msg-empty';
              wrap.textContent = label + ': [' + statusDesc + ']';
            }
            return wrap;
          };

          item.append(head, mkMsg(rd.userMessage, t('research.rounds.roleUser', '用户'), 'u'), mkMsg(rd.assistantMessage, t('research.rounds.roleChulan', '初澜'), 'a'));
          box.appendChild(item);
        }
      } catch (e) {
        box.textContent = t('research.rounds.loadFailedPrefix', '加载轮次失败: ') + e.message;
      }
    }

    async function loadWindowDetail(windowNo) {
      const card = document.getElementById('rWindowSummaryCard');
      if (!card) return;
      card.textContent = t('research.windows.readingData', '正在读取窗口数据...');

      if (!api || !api.research) {
        renderWindowDetailDemo(windowNo);
        return;
      }

      try {
        const detail = await api.research.getWindow({ windowNo });
        if (!detail) {
          card.textContent = t('research.windows.noArchiveData', 'Window #{win} 尚无经历归档数据', { win: windowNo });
          return;
        }

        card.textContent = '';
        const b = (txt) => { const el = document.createElement('b'); el.textContent = String(txt); return el; };
        const br = () => document.createElement('br');

        const turnsDisplay = (detail.turns !== null && detail.turns !== undefined) ? detail.turns : t('research.windows.valUnknown', '未知');
        const msgCountDisplay = (detail.messageCount !== null && detail.messageCount !== undefined) ? detail.messageCount : t('research.windows.valUnknown', '未知');

        card.append(
          t('research.windows.detailWinNo', '窗口 No: '), b(detail.windowNo), t('research.windows.detailTurns', ' | 轮次: '), b(turnsDisplay),
          t('research.windows.detailMsgCount', ' | 消息总计: '), b(msgCountDisplay),
          br(),
          'Events: ', b(detail.events ? detail.events.length : 0),
          ' | Observations: ', b(detail.observations ? detail.observations.length : 0),
          ' | Interpretations: ', b(detail.interpretations ? detail.interpretations.length : 0),
          br(),
          t('research.windows.detailAccepted', '接受证据: '), b(detail.verifiedEvidence ? detail.verifiedEvidence.length : 0),
          t('research.windows.detailRejected', ' | 拒绝证据: '), b(detail.rejectedEvidence ? detail.rejectedEvidence.length : 0),
          t('research.windows.detailStateChanges', ' | 状态变动: '), b(detail.stateChanges ? detail.stateChanges.length : 0)
        );

        const ib = document.getElementById('rWindowIntegrityBadge');
        if (ib) {
          ib.textContent = detail.archiveIntegrity || 'CERTIFIED';
          ib.className = 'r-badge ' + (detail.archiveIntegrity === 'CERTIFIED' ? 'badge-certified' : 'badge-uncertified');
        }
        const rb = document.getElementById('rWindowReplayBadge');
        if (rb) {
          rb.textContent = detail.replayStatus || 'COMPLETE';
          rb.className = 'r-badge ' + (detail.replayStatus === 'COMPLETE' ? 'badge-certified' : 'badge-uncertified');
        }

        await loadRounds(windowNo, currentSelectedSegIndex);
      } catch (e) {
        card.textContent = t('research.windows.readDetailFailedPrefix', '读取窗口详情失败: ') + e.message;
      }
    }

    async function loadWindowsTab() {
      const sel = document.getElementById('rWindowSelect');
      if (!sel) return;
      sel.textContent = '';

      if (!api || !api.research) {
        const opt = document.createElement('option');
        opt.value = '1';
        opt.textContent = 'Window #1';
        sel.appendChild(opt);
        renderWindowDetailDemo(1);
        return;
      }

      try {
        const res = await api.research.getWindows({ limit: 100 });
        const windows = (res && res.items) || [];
        if (!windows.length) {
          const opt = document.createElement('option');
          opt.value = '1';
          opt.textContent = t('research.windows.initialOpt', 'Window #1 (初始)');
          sel.appendChild(opt);
        } else {
          for (const w of windows) {
            const opt = document.createElement('option');
            opt.value = String(w.windowNo);
            const turnStr = (w.turns !== null && w.turns !== undefined) ? t('research.windows.turnsCount', '{turns} 轮', { turns: w.turns }) : t('research.windows.turnsUnknown', '轮次未知');
            const msgStr = (w.messageCount !== null && w.messageCount !== undefined) ? t('research.windows.msgsCount', '{count} 条', { count: w.messageCount }) : t('research.windows.msgsUnknown', '条数未知');
            opt.textContent = `Window #${w.windowNo} (${turnStr} / ${msgStr})`;
            sel.appendChild(opt);
          }
        }
        currentSelectedWindowNo = Number(sel.value || 1);
        await loadWindowDetail(currentSelectedWindowNo);
      } catch (e) {
        console.warn('[Research] 加载窗口列表失败:', e.message);
      }
    }

    async function loadResearchData() {
      const statusEl = document.getElementById('rFooterStatus');
      if (statusEl) statusEl.textContent = t('research.snapshot.loading', 'Snapshot: 正在加载数据...');

      if (!api || !api.research) {
        if (statusEl) statusEl.textContent = t('research.snapshot.preview', 'Snapshot: 预览模式 (降级演示)');
        renderStateDemo();
        return;
      }

      try {
        const snap = await api.research.refresh();
        if (statusEl) {
          const d = snap && snap.snapshotTimestamp ? new Date(snap.snapshotTimestamp).toLocaleTimeString() : '';
          statusEl.textContent = t('research.snapshot.status', 'Snapshot: {time} | 观察层只读受控', { time: d });
        }
        const state = (snap && snap.state) || (await api.research.getState());
        renderSubjectStateTab(state);
        await loadWindowsTab();
      } catch (err) {
        if (statusEl) statusEl.textContent = t('research.snapshot.loadFailedPrefix', 'Snapshot 加载失败: ') + err.message;
      }
    }

    async function runTraceProvenance(stateChangeId) {
      const box = document.getElementById('rProvResult');
      if (!box) return;
      box.textContent = t('research.prov.tracing', '正在反查溯源链...');

      if (!stateChangeId) {
        box.textContent = t('research.prov.enterScId', '请输入或选择 StateChange ID');
        return;
      }

      if (!api || !api.research) {
        box.textContent = t('research.prov.demoTrace', '[演示] {id} -> EV-000001 (quiet_preference +1) -> M-000101 -> “今天看了一本关于数字生命的书”', { id: stateChangeId });
        return;
      }

      try {
        const res = await api.research.getProvenance(stateChangeId);
        if (!res || !res.found) {
          box.textContent = t('research.prov.notFound', '未找到状态跃迁记录: {id}', { id: stateChangeId });
          return;
        }

        box.textContent = '';
        const sc = res.stateChange;
        const title = document.createElement('div');
        title.style.color = '#70a1ff';
        title.style.fontWeight = 'bold';
        title.textContent = t('research.prov.scTitle', 'StateChange [{id}] | Window #{win} | 特质: {trait} ({prev} → {newVal}, Δ{delta})', {
          id: sc.stateChangeId,
          win: sc.windowNo,
          trait: sc.trait,
          prev: sc.previousValue,
          newVal: sc.newValue,
          delta: sc.delta
        });
        box.appendChild(title);

        if (!res.chain || !res.chain.length) {
          const emptyTip = document.createElement('div');
          emptyTip.style.color = '#7d8aa8';
          emptyTip.textContent = t('research.prov.noEvidence', '  └─ 无关联的 Evidence 记录');
          box.appendChild(emptyTip);
          return;
        }

        for (const c of res.chain) {
          const evNode = document.createElement('div');
          evNode.style.margin = '4px 0 2px 10px';
          evNode.style.color = '#a4b6df';

          const evBadge = document.createElement('span');
          evBadge.className = 'r-badge ' + (c.status === 'verified' ? 'badge-accepted' : 'badge-rejected');
          evBadge.textContent = c.status ? c.status.toUpperCase() : 'VERIFIED';

          evNode.append(
            '  ├─ Evidence: ', evBadge, ` [${c.evidenceId}]` + t('research.prov.directionStrength', ' (方向: {dir}, 强度: {strength})', { dir: c.direction > 0 ? '+1' : '-1', strength: c.strength })
          );

          const msgNode = document.createElement('div');
          msgNode.style.margin = '2px 0 4px 24px';
          msgNode.style.color = '#d0daf2';
          msgNode.append(
            t('research.prov.messageOriginal', '  └─ Message: [{id}] ({role}) 原文: “{content}”\n', { id: c.messageId, role: c.messageRole, content: c.messageContent }),
            (() => {
              const q = document.createElement('span');
              q.style.color = '#8fe0a8';
              q.textContent = t('research.prov.quoteVerified', '     引用摘录: “{quote}” (完全匹配核验证实)', { quote: c.quote });
              return q;
            })()
          );

          box.append(evNode, msgNode);
        }
      } catch (e) {
        box.textContent = t('research.prov.traceFailedPrefix', '溯源失败: ') + e.message;
      }
    }

    async function runTraceEOI(id) {
      const box = document.getElementById('rEoiResult');
      if (!box) return;
      box.textContent = t('research.eoi.tracing', '正在追溯 EOI 三层事实...');

      if (!id) {
        box.textContent = t('research.eoi.enterId', '请输入 Event/Observation/Interpretation ID');
        return;
      }

      if (!api || !api.research) {
        box.textContent = t('research.eoi.demoTrace', '[演示] {id} 包含完整的 Interpretation -> Observation -> Event -> Message 链接', { id });
        return;
      }

      try {
        const res = await api.research.getEOI(id);
        if (!res || res.found === false) {
          box.textContent = t('research.eoi.notFound', '未检索到实体: {id}', { id });
          return;
        }

        box.textContent = '';
        const root = document.createElement('div');
        root.style.fontWeight = 'bold';
        root.style.color = '#f0e6ff';
        root.textContent = t('research.eoi.rootNode', 'EOI 根节点 [{type}]: {id}', { type: res.type, id });
        box.appendChild(root);

        if (res.observations) {
          for (const o of res.observations) {
            const obsEl = document.createElement('div');
            obsEl.style.marginLeft = '10px';
            obsEl.style.color = '#82cbff';
            obsEl.textContent = t('research.eoi.obsNode', '  ├─ Observation [{id}]: {content} (置信度: {conf})', { id: o.observationId, content: o.content, conf: o.confidence });
            box.appendChild(obsEl);
          }
        }

        if (res.events) {
          for (const e of res.events) {
            const evtEl = document.createElement('div');
            evtEl.style.marginLeft = '20px';
            evtEl.style.color = '#8fe0a8';
            evtEl.textContent = t('research.eoi.evtNode', '  └─ Event [{id}] (type: {type}, msg: {msg}): {payload}', { id: e.eventId, type: e.type, msg: e.messageId, payload: e.payload ? (e.payload.content || '') : '' });
            box.appendChild(evtEl);
          }
        }
      } catch (e) {
        box.textContent = t('research.eoi.traceFailedPrefix', 'EOI 追溯失败: ') + e.message;
      }
    }

    async function loadRejectedEvidence() {
      const box = document.getElementById('rRejectedList');
      if (!box) return;
      box.textContent = t('research.rejected.reading', '正在读取被拒绝证据...');

      if (!api || !api.research) {
        box.textContent = t('research.rejected.preview', '预览模式：暂无被拒证据');
        return;
      }

      try {
        const res = await api.research.getEvidence({ status: 'rejected', limit: 100 });
        const items = (res && res.items) || [];
        if (!items.length) {
          box.textContent = t('research.rejected.none', '暂无被拒绝证据记录 (所有模型提案证据均合法证实或未有非法请求)');
          return;
        }

        box.textContent = '';
        for (const ev of items) {
          const row = document.createElement('div');
          row.className = 'r-ev-card';

          const head = document.createElement('div');
          head.className = 'r-ev-head';
          const idEl = document.createElement('span');
          idEl.className = 'r-ev-id';
          idEl.textContent = ev.evidenceId || '—';
          const badge = document.createElement('span');
          badge.className = 'r-badge badge-rejected';
          badge.textContent = ev.reason || 'REJECTED';
          head.append(idEl, badge);

          const traitRow = document.createElement('div');
          traitRow.className = 'r-ev-row';
          const traitK = document.createElement('span');
          traitK.className = 'r-ev-k';
          traitK.textContent = t('research.rejected.traitKey', '特质');
          const traitV = document.createElement('span');
          traitV.className = 'r-ev-v';
          traitV.textContent = ev.trait || 'UNKNOWN';
          traitRow.append(traitK, traitV);

          const msgRow = document.createElement('div');
          msgRow.className = 'r-ev-row';
          const msgK = document.createElement('span');
          msgK.className = 'r-ev-k';
          msgK.textContent = t('research.rejected.msgKey', '消息');
          const msgV = document.createElement('span');
          msgV.className = 'r-ev-v';
          msgV.textContent = ev.messageId || 'N/A';
          msgRow.append(msgK, msgV);

          row.append(head, traitRow, msgRow);
          box.appendChild(row);
        }
      } catch (e) {
        box.textContent = t('research.rejected.readFailedPrefix', '读取被拒证据失败: ') + e.message;
      }
    }

    async function startReplay(opts = {}) {
      if (!api || !api.research) {
        alert(t('research.replay.previewAlert', '预览模式不支持真实 Replay 推演'));
        return;
      }
      const fill = document.getElementById('rProgressBarFill');
      const stageEl = document.getElementById('rProgressStage');
      const pctEl = document.getElementById('rProgressPercent');
      const cancelBtn = document.getElementById('rReplayCancelBtn');
      const card = document.getElementById('rReplayResultCard');

      if (cancelBtn) cancelBtn.disabled = false;
      if (fill) fill.style.width = '0%';
      if (card) card.textContent = t('research.replay.starting', '正在启动 Replay 任务...');

      try {
        const startRes = await api.research.replayStart(opts);
        const taskId = startRes && startRes.taskId;
        if (!taskId) {
          if (card) card.textContent = t('research.replay.startFailed', '启动 Replay 失败');
          if (cancelBtn) cancelBtn.disabled = true;
          return;
        }

        stopReplayPolling();
        let replayPollingStopped = false;
        const pollReplay = async () => {
          try {
            const st = await api.research.replayStatus(taskId);
            if (!st || replayPollingStopped) return;
            if (fill) fill.style.width = (st.percent || 0) + '%';
            if (pctEl) pctEl.textContent = (st.percent || 0) + '%';
            if (stageEl) stageEl.textContent = `${st.stage} (${st.currentWindow}/${st.totalWindows} Windows)`;

            if (st.status === 'completed' || st.status === 'cancelled' || st.status === 'failed') {
              replayPollingStopped = true;
              stopReplayPolling();
              if (cancelBtn) cancelBtn.disabled = true;

              if (st.status === 'cancelled') {
                if (card) card.textContent = t('research.replay.cancelled', 'Replay 已由用户取消。');
                return;
              }
              if (st.status === 'failed') {
                if (card) card.textContent = t('research.replay.failedPrefix', 'Replay 异常失败: ') + st.error;
                return;
              }

              const res = st.result || {};
              card.textContent = '';
              const b = (txt) => { const el = document.createElement('b'); el.textContent = String(txt); return el; };
              const br = () => document.createElement('br');

              card.append(
                t('research.replay.resultLabel', '推演结果: '), b(res.replayStatus ? res.replayStatus.toUpperCase() : 'COMPLETE'),
                t('research.replay.integrityLabel', ' | 完整性认证: '), b(res.integrity ? res.integrity.toUpperCase() : 'CERTIFIED'),
                br(),
                t('research.replay.scCountLabel', '状态跃迁总计: '), b(res.stateChanges ? res.stateChanges.length : 0), t('research.replay.scTimes', ' 次'),
                t('research.replay.acceptedEvLabel', ' | 接受证据: '), b(res.acceptedEvidenceCount || 0), t('research.replay.evCount', ' 条'),
                br()
              );

              if (res.failure) {
                const failSpan = document.createElement('div');
                failSpan.style.color = '#ff6b81';
                failSpan.style.marginTop = '4px';
                failSpan.textContent = t('research.replay.fuseBlown', 'Fail-Stop 熔断: 第 {line} 行数据损坏 ({reason})，推演已冻结在第 {last} 行', { line: res.failure.line, reason: res.failure.reason, last: res.lastValidRecord });
                card.appendChild(failSpan);
              } else {
                const okSpan = document.createElement('div');
                okSpan.style.color = '#2ecc71';
                okSpan.style.marginTop = '4px';
                okSpan.textContent = t('research.replay.certifiedOk', 'Replay 推演与当前主体状态完全一致 (Certified)');
                card.appendChild(okSpan);
              }
              return;
            }
            if (!replayPollingStopped) {
              activeReplayPollingTimer = setTimeout(pollReplay, 150);
            }
          } catch (pollErr) {
            replayPollingStopped = true;
            stopReplayPolling();
            if (cancelBtn) cancelBtn.disabled = true;
            if (card) card.textContent = t('research.replay.exceptionPrefix', 'Replay 异常: ') + (pollErr && pollErr.message ? pollErr.message : String(pollErr));
          }
        };
        activeReplayPollingTimer = setTimeout(pollReplay, 150);

        if (cancelBtn) {
          cancelBtn.onclick = async () => {
            await api.research.replayCancel(taskId);
          };
        }
      } catch (err) {
        if (card) card.textContent = t('research.replay.exceptionPrefix', 'Replay 异常: ') + err.message;
        if (cancelBtn) cancelBtn.disabled = true;
      }
    }

    function updateExportMeta() {
      const meta = document.getElementById('rExportMeta');
      const out = document.getElementById('rExportOutput');
      if (!meta || !out) return;
      const v = String(out.value || '');
      const head = v.trimStart();
      if (!head) { meta.textContent = t('research.export.metaEmpty', '尚未生成'); return; }
      if (head === t('research.export.generating', '正在生成导出数据...')) { meta.textContent = t('research.export.generatingShort', '生成中…'); return; }
      const kind = (head.startsWith('{') || head.startsWith('[')) ? 'JSON' : t('research.export.kindCsvText', 'CSV / 文本');
      meta.textContent = t('research.export.metaPattern', '{kind} · {lines} 行 · {time}', { kind, lines: v.split('\n').length, time: formatDisplayTime(Date.now()) });
    }

    async function handleExport(opts) {
      const out = document.getElementById('rExportOutput');
      if (!out) return;
      const setOut = (v) => {
        let text = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
        const head = text.trimStart();
        if (head.startsWith('{') || head.startsWith('[')) {
          try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* 非法 JSON 原样展示 */ }
        } else {
          text = text.split(/\r?\n/).filter((l) => l.trim() !== '').join('\n\n');
        }
        out.value = text;
        updateExportMeta();
      };
      setOut(t('research.export.generating', '正在生成导出数据...'));
      if (!api || !api.research) {
        setOut(JSON.stringify({ note: t('research.export.previewSim', '预览模式模拟导出'), opts }, null, 2));
        return;
      }
      try {
        const res = await api.research.exportData(opts);
        if (typeof res === 'string') setOut(res);
        else setOut(JSON.stringify(res, null, 2));
      } catch (err) {
        setOut(t('research.export.failedPrefix', '导出失败: ') + err.message);
      }
    }

    async function openResearchPanel() {
      if (!researchPanel) return;
      closeOtherOverlays('research');
      researchPanel.classList.remove('hidden');
      refreshLifeMechanisms();
      refreshDreams();
      syncPanelViewport();
      syncMotionPriority();

      if (api && api.research && api.research.getHashes) {
        try {
          currentResearchHashes = await api.research.getHashes();
          const hEl = document.getElementById('rFooterHashes');
          if (hEl && currentResearchHashes) {
            hEl.textContent = 'Archive SHA: ' + (currentResearchHashes.archiveSha256 ? currentResearchHashes.archiveSha256.slice(0, 8) : 'none')
              + ' | State SHA: ' + (currentResearchHashes.stateSha256 ? currentResearchHashes.stateSha256.slice(0, 8) : 'none');
          }
        } catch (e) {
          console.warn('[Research] 读取哈希失败:', e.message);
        }
      }

      await loadResearchData();
    }

    async function closeResearchPanel() {
      if (!researchPanel) return;
      stopReplayPolling();
      researchPanel.classList.add('hidden');
      syncMotionPriority();
      syncPanelViewport();

      if (api && api.research && api.research.verifyIntegrity && currentResearchHashes) {
        try {
          const chk = await api.research.verifyIntegrity(currentResearchHashes);
          if (!chk.ok) {
            console.error('[Research] 违规写操作检测:', chk.error);
            alert(t('research.integrityAlert', '警告：检测到实验数据发生变更！\n') + chk.error);
          }
        } catch (e) {
          console.error('[Research] 完整性校验异常:', e.message);
        }
      }
    }

    document.getElementById('rCloseBtn')?.addEventListener('click', closeResearchPanel);
    if (researchPanel) researchPanel.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      closeResearchPanel();
    });
    document.getElementById('rRefreshBtn')?.addEventListener('click', loadResearchData);

    document.querySelectorAll('.r-tab').forEach(btn => {
      btn.addEventListener('click', () => switchResearchTab(btn.dataset.rtab));
    });

    document.querySelectorAll('#rStateSubtabs .r-subtab').forEach(btn => {
      btn.addEventListener('click', () => switchStateSubtab(btn.dataset.subtab));
    });

    document.querySelectorAll('.r-seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.r-seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentSelectedSegIndex = Number(btn.dataset.seg || 1);
        loadRounds(currentSelectedWindowNo, currentSelectedSegIndex);
      });
    });

    document.getElementById('rWindowSelect')?.addEventListener('change', (e) => {
      currentSelectedWindowNo = Number(e.target.value || 1);
      loadWindowDetail(currentSelectedWindowNo);
    });

    document.querySelectorAll('#rPaneProvenance .r-subtab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#rPaneProvenance .r-subtab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const sub = btn.dataset.subtab;
        const provPane = document.getElementById('rSubPaneProv');
        const eoiPane = document.getElementById('rSubPaneEoi');
        const rejPane = document.getElementById('rSubPaneRejected');
        if (provPane) provPane.classList.toggle('hidden', sub !== 'prov');
        if (eoiPane) eoiPane.classList.toggle('hidden', sub !== 'eoi');
        if (rejPane) rejPane.classList.toggle('hidden', sub !== 'rejected');
        if (sub === 'rejected') loadRejectedEvidence();
      });
    });

    document.getElementById('rTraceBtn')?.addEventListener('click', () => {
      const v = document.getElementById('rScInput')?.value?.trim();
      runTraceProvenance(v);
    });

    document.getElementById('rTraceEoiBtn')?.addEventListener('click', () => {
      const v = document.getElementById('rEoiInput')?.value?.trim();
      runTraceEOI(v);
    });

    document.getElementById('rReplayAllBtn')?.addEventListener('click', () => startReplay({}));
    document.getElementById('rReplayUntilBtn')?.addEventListener('click', () => {
      const w = Number(document.getElementById('rReplayUntilWin')?.value);
      if (w > 0) startReplay({ untilWindow: w });
      else alert(t('research.replay.validWinPrompt', '请输入有效的目标窗口号'));
    });

    document.getElementById('rExportSave')?.addEventListener('click', () => {
      const out = document.getElementById('rExportOutput');
      const btn = document.getElementById('rExportSave');
      if (!out || !btn) return;
      const v = String(out.value || '');
      if (!v) return;
      const head = v.trimStart();
      const ext = (head.startsWith('{') || head.startsWith('[')) ? 'json' : 'csv';
      const fname = 'life-export-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + ext;
      try {
        const blob = new Blob([v], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fname;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        btn.textContent = t('status.savedCheck', '已保存 ✓');
      } catch (e) {
        btn.textContent = t('status.saveFailed', '保存失败');
      }
    });

    document.getElementById('rExportCopy')?.addEventListener('click', async () => {
      const out = document.getElementById('rExportOutput');
      const btn = document.getElementById('rExportCopy');
      if (!out || !btn) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(out.value || '');
        }
        btn.textContent = t('status.copiedCheck', '已复制 ✓');
      } catch (e) {
        btn.textContent = t('status.copyFailed', '复制失败');
      }
    });

    document.getElementById('rExpTrajJson')?.addEventListener('click', () => handleExport({ type: 'trajectory', format: 'json' }));
    document.getElementById('rExpTrajCsv')?.addEventListener('click', () => handleExport({ type: 'trajectory', format: 'csv' }));
    document.getElementById('rExpScCsv')?.addEventListener('click', () => handleExport({ type: 'state_changes', format: 'csv' }));
    document.getElementById('rExpEvCsv')?.addEventListener('click', () => handleExport({ type: 'evidence', format: 'csv' }));
    document.getElementById('rExpFullBundle')?.addEventListener('click', () => handleExport({ type: 'full', format: 'json' }));

    return {
      openResearchPanel,
      closeResearchPanel,
      loadResearchData,
      renderSubjectStateTab,
      loadTraitHistory,
      loadWindowsTab,
      loadWindowDetail,
      loadRounds,
      runTraceProvenance,
      runTraceEOI,
      loadRejectedEvidence,
      switchResearchTab,
      switchStateSubtab,
      startReplay,
      stopReplayPolling
    };
  }

  if (typeof window !== 'undefined') {
    window.LifeUiResearch = { initResearch };
  }
})();
