/**
 * 自然动画系统 V1 —— 渲染适配器 (Rendering Adapter)
 *
 * 架构目标：
 * 1. 严格作为 FrameData 的单向消费者，负责将结构化姿态参数渲染到底层目标（DOM / CSS / Pixi / Canvas / Live2D 等）；
 * 2. 绝对不反向决定动画状态、行为优先级或触发条件（单一职责）；
 * 3. 具备异常隔离能力：渲染层抛错不得影响 Controller 的状态机运转；
 * 4. 提供统一语义接口：render(frameData)、reset()、refreshLayers()、destroy()。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const exports = factory();
    root.AnimationRenderer = exports.AnimationRenderer;
    root.NullAnimationRenderer = exports.NullAnimationRenderer;
    root.DomAnimationRenderer = exports.DomAnimationRenderer;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 渲染适配器基类接口
   */
  class AnimationRenderer {
    init(options) {}
    render(frameData) {}
    reset() {}
    refreshLayers() {}
    destroy() {}
  }

  /**
   * 无头渲染器（用于 Node.js 单元测试和无界面环境）
   */
  class NullAnimationRenderer extends AnimationRenderer {
    constructor() {
      super();
      this.frameCount = 0;
      this.lastFrame = null;
      this.destroyed = false;
      this.throwOnRender = false;
    }

    render(frameData) {
      if (this.destroyed) return;
      if (this.throwOnRender) throw new Error('Simulated renderer error');
      this.frameCount++;
      this.lastFrame = frameData;
    }

    reset() {
      this.lastFrame = null;
    }

    refreshLayers() {}

    destroy() {
      this.destroyed = true;
      this.reset();
    }
  }

  /**
   * DOM / CSS Transform 渲染器
   *
   * 负责将 AnimationController 输出的纯数据 FrameData 映射至 Electron DOM 结构：
   * - #figure: 负责整体姿态、身体微动、Poke 重心倾角、行走起伏
   * - #layers: 分层立绘容器
   *   - .layer[data-slot="hair"]: 头部发丝以头顶为锚点独立微摆
   *   - .layer[data-slot="hairAccessory"]: 发饰跟随微摆
   *   - .layer[data-slot="dress" / "outerwear" / "bottom"]: 服装下摆微摆
   *   - .layer[data-slot="base"]: 身体素体层
   * - #sprite: 单图降级兜底时的复合微动
   * - #shadow: 随身体起伏微弱变化的投影
   */
  class DomAnimationRenderer extends AnimationRenderer {
    constructor(opts = {}) {
      super();
      this.pet = opts.petElement || (typeof document !== 'undefined' ? document.getElementById('pet') : null);
      this.figure = opts.figureElement || (typeof document !== 'undefined' ? document.getElementById('figure') : null);
      this.layers = opts.layersElement || (typeof document !== 'undefined' ? document.getElementById('layers') : null);
      this.sprite = opts.spriteElement || (typeof document !== 'undefined' ? document.getElementById('sprite') : null);
      this.shadow = opts.shadowElement || (typeof document !== 'undefined' ? document.getElementById('shadow') : null);

      this.cachedSlots = new Map();
      this.destroyed = false;

      this.refreshLayers();
    }

    /**
     * 刷新分层缓存（在衣柜图层切换或重新加载后调用）
     */
    refreshLayers() {
      if (!this.layers || typeof this.layers.querySelectorAll !== 'function') return;
      this.cachedSlots.clear();
      const imgs = this.layers.querySelectorAll('img.layer');
      imgs.forEach((img) => {
        const slot = img.dataset.slot || 'unknown';
        if (!this.cachedSlots.has(slot)) {
          this.cachedSlots.set(slot, []);
        }
        this.cachedSlots.get(slot).push(img);
      });
    }

    /**
     * 渲染一帧纯数据 FrameData
     */
    render(frameData) {
      if (this.destroyed || !frameData) return;

      try {
        const { body, hair, clothes, eyes, shadow, state } = frameData;

        // 1. 身体与躯干姿态渲染（#figure）
        if (this.figure && body) {
          const sx = Number.isFinite(body.scaleX) ? body.scaleX : 1;
          const sy = Number.isFinite(body.scaleY) ? body.scaleY : 1;
          const tx = Number.isFinite(body.translateX) ? body.translateX : 0;
          const ty = Number.isFinite(body.translateY) ? body.translateY : 0;
          const rot = Number.isFinite(body.rotate) ? body.rotate : 0;

          this.figure.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) rotate(${rot.toFixed(2)}deg) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;

          if (this.figure.dataset.animState !== state) {
            this.figure.dataset.animState = state;
          }
        }

        // 2. 眼睛表达层（设置属性供 CSS 渲染或表情切图使用）
        if (eyes && this.figure) {
          const eyeState = eyes.state || 'eye_open';
          if (this.figure.dataset.eyeState !== eyeState) {
            this.figure.dataset.eyeState = eyeState;
          }
          if (this.pet && this.pet.style && typeof this.pet.style.setProperty === 'function' && Number.isFinite(eyes.openness)) {
            this.pet.style.setProperty('--eye-openness', eyes.openness.toFixed(3));
          }
        }

        // 3. 分层服装与头发独立摆动（Layered 模式下）
        const isLayered = this.figure && this.figure.classList && this.figure.classList.contains('layered');
        if (isLayered && this.layers) {
          // 3.1 头发与发饰层（以头顶为锚点微摆）
          if (hair && Number.isFinite(hair.rotate)) {
            const hairElements = [
              ...(this.cachedSlots.get('hair') || []),
              ...(this.cachedSlots.get('hairAccessory') || [])
            ];
            for (let i = 0; i < hairElements.length; i++) {
              const el = hairElements[i];
              el.style.transformOrigin = hair.origin || '50% 18%';
              el.style.transform = `rotate(${hair.rotate.toFixed(2)}deg)`;
            }
          }

          // 3.2 裙装、外套与衣物下摆微摆（以腰部为锚点）
          if (clothes && Number.isFinite(clothes.rotate)) {
            const clothesElements = [
              ...(this.cachedSlots.get('dress') || []),
              ...(this.cachedSlots.get('outerwear') || []),
              ...(this.cachedSlots.get('top') || []),
              ...(this.cachedSlots.get('bottom') || [])
            ];
            const cSy = Number.isFinite(clothes.scaleY) ? clothes.scaleY : 1;
            for (let i = 0; i < clothesElements.length; i++) {
              const el = clothesElements[i];
              el.style.transformOrigin = clothes.origin || '50% 45%';
              el.style.transform = `rotate(${clothes.rotate.toFixed(2)}deg) scaleY(${cSy.toFixed(4)})`;
            }
          }
        }

        // 4. 单张兜底立绘（Fallback Sprite）
        if (!isLayered && this.sprite && hair) {
          const hRot = Number.isFinite(hair.rotate) ? hair.rotate * 0.3 : 0;
          this.sprite.style.transform = `rotate(${hRot.toFixed(2)}deg)`;
        }

        // 5. 投影缩放响应
        if (this.shadow && shadow) {
          const sSx = Number.isFinite(shadow.scaleX) ? shadow.scaleX : 1;
          const sOp = Number.isFinite(shadow.opacity) ? shadow.opacity : 0.5;
          this.shadow.style.transform = `translateX(-50%) scaleX(${sSx.toFixed(3)})`;
          this.shadow.style.opacity = sOp.toFixed(3);
        }
      } catch (err) {
        // 渲染异常捕获，确保 Controller 绝不因 DOM 操作故障中断
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[DomAnimationRenderer] Render error caught:', err);
        }
      }
    }

    /**
     * 重置所有内联变换与状态标注
     */
    reset() {
      try {
        if (this.figure && this.figure.style) {
          this.figure.style.transform = '';
          delete this.figure.dataset.animState;
          delete this.figure.dataset.eyeState;
        }
        if (this.sprite && this.sprite.style) {
          this.sprite.style.transform = '';
        }
        if (this.shadow && this.shadow.style) {
          this.shadow.style.transform = '';
          this.shadow.style.opacity = '';
        }
        if (this.layers && typeof this.layers.querySelectorAll === 'function') {
          const imgs = this.layers.querySelectorAll('img.layer');
          imgs.forEach((img) => {
            img.style.transform = '';
          });
        }
      } catch (err) {
        // 忽略重置错误
      }
    }

    /**
     * 销毁并重置相关 DOM 内联样式
     */
    destroy() {
      this.destroyed = true;
      this.reset();
      this.cachedSlots.clear();
    }
  }

  return {
    AnimationRenderer,
    NullAnimationRenderer,
    DomAnimationRenderer
  };
});
