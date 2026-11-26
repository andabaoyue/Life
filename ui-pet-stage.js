(() => {
  const CHIBI_FRAMES = {
    idle: [
      'assets/character/anim/idle/idle_0.png',
      'assets/character/anim/idle/idle_1.png',
      'assets/character/anim/idle/idle_2.png',
      'assets/character/anim/idle/idle_3.png'
    ],
    walking: [
      'assets/character/anim/walk/walk_0.png',
      'assets/character/anim/walk/walk_1.png',
      'assets/character/anim/walk/walk_2.png',
      'assets/character/anim/walk/walk_3.png'
    ]
  };
  const CHIBI_BASE_FRAMES = {
    idle: [
      'assets/character/anim/idle_base/idle_base_0.png',
      'assets/character/anim/idle_base/idle_base_1.png',
      'assets/character/anim/idle_base/idle_base_2.png',
      'assets/character/anim/idle_base/idle_base_3.png'
    ],
    walking: [
      'assets/character/anim/walk_base/walk_base_0.png',
      'assets/character/anim/walk_base/walk_base_1.png',
      'assets/character/anim/walk_base/walk_base_2.png',
      'assets/character/anim/walk_base/walk_base_3.png'
    ]
  };
  const STATES = ['idle', 'happy', 'curious', 'thinking', 'sleepy', 'embarrassed', 'annoyed', 'sad'];
  const PET_BASE_W = 64;
  const PIXEL_PREVIEW = true;
  const DRAG_IDLE_MS = 2500;
  const PANEL_DRAG_SKIP = 'button, input, select, textarea, option, .pnav-item, .memlist, .wd-slots, .wd-presets, .stats, #wdSuggest, #logClose'
    + ', #researchBody, .r-trait-card, .r-table-container, .r-rounds-list, .r-seg-tabs, .r-subtabs, .r-toolbar';

  /**
   * 桌宠舞台控制器：精灵帧动画、表情状态机、图层换装渲染、拖拽物理、穿透判定与眨眼/可见性暂停。
   */
  function initStage(ctx) {
    const {
      pet, bubble, figure, layerBox, spriteImg, api,
      getAnimController, getAnimRenderer,
      syncMotionPriority, anyOverlayOpen, fitBubble,
      getRenderState, renderBubble,
      noteUserAct, notePokeAndMaybeAsk, setTalking
    } = ctx;

    let currentFrameStopper = null;
    let stateSwitchTimer = null;
    let layerSrcs = [];
    let wardrobeApplyGen = 0;

    let dragging = false, lastX = 0, lastY = 0, moved = 0;
    let dragWatch = null, lastMoveAt = 0;
    let middleTimer = null;
    let lastIgnoreMouse = false;
    let fallbackBlinkTimer = null;

    function applyPetSize() {
      if (pet) pet.style.width = PET_BASE_W + 'px';
      if (PIXEL_PREVIEW) document.body.classList.add('pixel-sprite');
    }
    if (PIXEL_PREVIEW) document.body.classList.add('pixel-sprite');

    function playFrames(el, frames, fps, baseFrames) {
      if (!Array.isArray(frames) || frames.length === 0) return () => {};
      let i = 0;
      const updateEl = (im, src) => { if (im && src) im.src = src; };
      const getBaseLayer = () => layerBox ? layerBox.querySelector('img[data-slot="base"]') : null;
      const bFrames = Array.isArray(baseFrames) && baseFrames.length > 0 ? baseFrames : null;
      updateEl(el, frames[0]);
      if (bFrames) updateEl(getBaseLayer(), bFrames[0]);
      const timer = setInterval(() => {
        i = (i + 1) % frames.length;
        updateEl(el, frames[i]);
        if (bFrames) updateEl(getBaseLayer(), bFrames[i % bFrames.length]);
      }, Math.round(1000 / (fps || 6)));
      return () => {
        clearInterval(timer);
        const currBase = getBaseLayer();
        if (currBase) currBase.src = 'assets/character/base/base_pixel_chibi.png';
      };
    }

    function updateSpriteAnim(state) {
      if (!PIXEL_PREVIEW) return;
      if (currentFrameStopper) { currentFrameStopper(); currentFrameStopper = null; }
      const frames = CHIBI_FRAMES[state] || CHIBI_FRAMES.idle;
      const baseFrames = CHIBI_BASE_FRAMES[state] || CHIBI_BASE_FRAMES.idle;
      const fps = state === 'walking' ? 6 : 2;
      currentFrameStopper = playFrames(spriteImg, frames, fps, baseFrames);
    }

    document.body.dataset.state = 'idle';
    function setState(s) {
      const next = STATES.includes(s) ? s : 'idle';
      if (document.body.dataset.state === next) return;
      document.body.dataset.state = next;
      const animController = getAnimController();
      if (animController) animController.setDialogueState(next);
      pet.classList.add('state-switch');
      clearTimeout(stateSwitchTimer);
      stateSwitchTimer = setTimeout(() => pet.classList.remove('state-switch'), 180);
    }

    function showFallbackSprite() {
      figure.classList.remove('layered');
      layerBox.replaceChildren();
      const animRenderer = getAnimRenderer();
      if (animRenderer) animRenderer.refreshLayers();
    }

    function relayout() {
      fitBubble();
      const { lastText } = getRenderState();
      if (lastText && !bubble.classList.contains('hidden')) renderBubble(lastText);
    }

    function applyLayers(layers) {
      const gen = ++wardrobeApplyGen;
      layerSrcs = layers || [];
      if (!layerSrcs.length && !PIXEL_PREVIEW) return showFallbackSprite();

      const srcs = [
        PIXEL_PREVIEW ? 'assets/character/base/base_pixel_chibi.png' : 'assets/character/base/base.png',
        ...layerSrcs.map(l => l.src)
      ];
      const imgs = srcs.map(src => new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res();
        im.onerror = () => rej(new Error(src));
        im.src = src;
      }));

      Promise.all(imgs).then(() => {
        if (gen !== wardrobeApplyGen) return;
        if (currentFrameStopper) { currentFrameStopper(); currentFrameStopper = null; }
        layerBox.replaceChildren();
        srcs.forEach((src, i) => {
          const im = document.createElement('img');
          im.src = src;
          im.draggable = false;
          im.alt = '';
          im.className = i === 0 ? 'layer base' : 'layer';
          if (i === 0) {
            im.dataset.slot = 'base';
          } else {
            im.style.zIndex = String(layerSrcs[i - 1].z);
            im.dataset.slot = layerSrcs[i - 1].slot || 'unknown';
          }
          layerBox.appendChild(im);
        });
        const animRenderer = getAnimRenderer();
        if (animRenderer) animRenderer.refreshLayers();
        figure.classList.add('layered');
        relayout();
        updateSpriteAnim(document.body.dataset.motionState || 'idle');
      }).catch(() => {
        if (gen !== wardrobeApplyGen) return;
        showFallbackSprite();
        relayout();
      });
    }

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      clearInterval(dragWatch);
      dragWatch = null;
      pet.classList.remove('dragging');
      document.body.classList.remove('pet-dragging');
      pet.style.left = pet.style.right = pet.style.top = pet.style.bottom = '';
      pet.style.transform = '';
      syncMotionPriority();
      if (api) api.dragEnd();
      if (api && api.activity && moved > 6) api.activity('drag', { distance: moved });
    }

    function startWindowDrag(e) {
      if (e.button !== 0) return;
      noteUserAct();
      dragging = true;
      moved = 0;
      lastX = e.screenX;
      lastY = e.screenY;
      lastMoveAt = Date.now();
      pet.classList.add('dragging');
      document.body.classList.add('pet-dragging');
      syncMotionPriority();
      if (api) api.dragStart();
      clearInterval(dragWatch);
      dragWatch = setInterval(() => {
        if (Date.now() - lastMoveAt > DRAG_IDLE_MS) endDrag();
      }, 250);
      e.preventDefault();
    }

    function bindPanelDrag(el) {
      if (!el) return;
      el.addEventListener('mousedown', (e) => {
        if (e.target.closest && e.target.closest(PANEL_DRAG_SKIP)) return;
        startWindowDrag(e);
      });
    }

    function updateMouseIgnore(e) {
      if (!api || !api.setIgnoreMouseEvents) return;
      if (dragging || anyOverlayOpen()) {
        if (lastIgnoreMouse !== false) {
          lastIgnoreMouse = false;
          api.setIgnoreMouseEvents(false);
        }
        return;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const isInteractive = !!(el && (
        el.closest('#pet') ||
        el.closest('#menu') ||
        (el.closest('#bubble') && !bubble.classList.contains('hidden')) ||
        el.closest('.panel') ||
        el.closest('#chatStream')
      ));
      const shouldIgnore = !isInteractive;
      if (lastIgnoreMouse !== shouldIgnore) {
        lastIgnoreMouse = shouldIgnore;
        api.setIgnoreMouseEvents(shouldIgnore);
      }
    }

    function blink() {
      pet.classList.add('blink');
      setTimeout(() => pet.classList.remove('blink'), 200);
    }

    function grow(f) {
      pet.style.width = Math.min(420, Math.max(120, parseFloat(getComputedStyle(pet).width) * f)) + 'px';
    }

    window.addEventListener('resize', () => {
      relayout();
    });

    if (api && api.onWardrobe) {
      api.onWardrobe((layers) => applyLayers(layers));
    }

    pet.addEventListener('mousedown', startWindowDrag);
    pet.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        if (middleTimer) {
          clearTimeout(middleTimer);
          middleTimer = null;
          if (api && api.chatWindowToggle) api.chatWindowToggle();
        } else {
          middleTimer = setTimeout(() => { middleTimer = null; }, 250);
        }
      }
    });

    document.addEventListener('mouseleave', () => {
      if (!api || !api.setIgnoreMouseEvents) return;
      if (!dragging && !anyOverlayOpen()) {
        if (lastIgnoreMouse !== true) {
          lastIgnoreMouse = true;
          api.setIgnoreMouseEvents(true);
        }
      }
    });

    window.addEventListener('mousemove', (e) => {
      updateMouseIgnore(e);
      if (!dragging) return;
      if (e.buttons === 0) { endDrag(); return; }
      const dx = e.screenX - lastX, dy = e.screenY - lastY;
      lastX = e.screenX;
      lastY = e.screenY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (dx || dy) lastMoveAt = Date.now();
      if (api) api.dragMove(dx, dy);
      else {
        pet.style.left = (pet.offsetLeft + dx) + 'px';
        pet.style.bottom = (parseFloat(getComputedStyle(pet).bottom) - dy) + 'px';
      }
    });

    window.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', endDrag);
    if (api && api.onDragCancel) api.onDragCancel(endDrag);

    pet.addEventListener('click', () => {
      if (moved > 6) return;
      noteUserAct();
      const animController = getAnimController();
      if (animController) {
        animController.poke();
      } else {
        blink();
      }
      notePokeAndMaybeAsk();
      if (!document.body.classList.contains('talking') && !api) setTalking(true);
    });

    if (!getAnimController()) {
      fallbackBlinkTimer = setInterval(() => { if (!document.hidden && Math.random() < 0.4) blink(); }, 4000);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          if (currentFrameStopper) { currentFrameStopper(); currentFrameStopper = null; }
        } else {
          const curState = document.body && document.body.getAttribute ? (document.body.getAttribute('data-state') || 'idle') : 'idle';
          updateSpriteAnim(curState);
        }
      });
    }

    function disposeStage() {
      if (fallbackBlinkTimer) {
        clearInterval(fallbackBlinkTimer);
        fallbackBlinkTimer = null;
      }
      if (currentFrameStopper) {
        currentFrameStopper();
        currentFrameStopper = null;
      }
    }

    return {
      STATES,
      DRAG_IDLE_MS,
      applyPetSize,
      playFrames,
      updateSpriteAnim,
      setState,
      showFallbackSprite,
      applyLayers,
      relayout,
      endDrag,
      startWindowDrag,
      bindPanelDrag,
      updateMouseIgnore,
      blink,
      grow,
      disposeStage,
      isDragging: () => dragging,
      getDragWatch: () => dragWatch,
      getMoved: () => moved
    };
  }

  if (typeof window !== 'undefined') {
    window.LifeUiPetStage = { initStage, STATES, DRAG_IDLE_MS };
  }
})();
