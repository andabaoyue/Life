/**
 * 自然动画系统 V1 —— 渲染适配器单元测试
 *
 * 测试覆盖：
 * 1. NullAnimationRenderer 帧计数与销毁
 * 2. DomAnimationRenderer DOM 映射（姿态、微摆、锚点、眼睛状态）
 * 3. 分层槽位缓存与独立锚点（hair 50% 18%, clothes 50% 45%）
 * 4. 异常隔离性（DOM 抛错不中断渲染链路）
 * 5. 销毁与样式重置
 */

const assert = require('assert');
const { NullAnimationRenderer, DomAnimationRenderer } = require('../src/render-adapter');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL  ' + name + '  ' + e.message);
  }
}

/* ---------- 1. NullAnimationRenderer ---------- */
(() => {
  const r = new NullAnimationRenderer();
  check('NullAnimationRenderer 初始状态', () => {
    assert.strictEqual(r.frameCount, 0);
    assert.strictEqual(r.lastFrame, null);
    assert.strictEqual(r.destroyed, false);
  });

  check('NullAnimationRenderer 记录渲染帧', () => {
    r.render({ state: 'idle', time: 100 });
    assert.strictEqual(r.frameCount, 1);
    assert.strictEqual(r.lastFrame.state, 'idle');
  });

  check('NullAnimationRenderer 销毁后停止接收帧', () => {
    r.destroy();
    assert.strictEqual(r.destroyed, true);
    r.render({ state: 'walk', time: 200 });
    assert.strictEqual(r.frameCount, 1);
  });
})();

/* ---------- 2. DomAnimationRenderer 模拟测试 ---------- */
function createMockElement(tag, id = '') {
  const classes = new Set();
  const dataset = {};
  const styleProps = new Map();
  const style = {
    setProperty: (k, v) => styleProps.set(k, v),
    getPropertyValue: (k) => styleProps.get(k) || '',
    removeProperty: (k) => styleProps.delete(k)
  };
  const children = [];

  const el = {
    id,
    tagName: tag.toUpperCase(),
    dataset,
    style,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    },
    appendChild: (child) => { children.push(child); return child; },
    querySelectorAll: (sel) => {
      // 简单模拟选择器
      if (sel === 'img.layer') {
        return children.filter(c => c.tagName === 'IMG' && c.classList.contains('layer'));
      }
      return [];
    }
  };
  return el;
}

(() => {
  const mockPet = createMockElement('div', 'pet');
  const mockFigure = createMockElement('div', 'figure');
  const mockLayers = createMockElement('div', 'layers');
  const mockSprite = createMockElement('img', 'sprite');
  const mockShadow = createMockElement('div', 'shadow');

  mockFigure.classList.add('layered');

  // 创建两个发型图层，两个衣服图层，一个底模图层
  const baseImg = createMockElement('img');
  baseImg.classList.add('layer', 'base');
  baseImg.dataset.slot = 'base';

  const hairImg = createMockElement('img');
  hairImg.classList.add('layer');
  hairImg.dataset.slot = 'hair';

  const dressImg = createMockElement('img');
  dressImg.classList.add('layer');
  dressImg.dataset.slot = 'dress';

  mockLayers.appendChild(baseImg);
  mockLayers.appendChild(hairImg);
  mockLayers.appendChild(dressImg);

  const renderer = new DomAnimationRenderer({
    petElement: mockPet,
    figureElement: mockFigure,
    layersElement: mockLayers,
    spriteElement: mockSprite,
    shadowElement: mockShadow
  });

  check('初始化时正确检索并分类槽位图层', () => {
    assert(renderer.cachedSlots.has('hair'));
    assert(renderer.cachedSlots.has('dress'));
    assert(renderer.cachedSlots.has('base'));
  });

  check('render() 正确设置 figure 的 transform 与状态 dataset', () => {
    renderer.render({
      state: 'poke',
      body: { scaleX: 1, scaleY: 1.01, translateX: -2, translateY: 1.5, rotate: -3.2 },
      hair: { rotate: 0.8, origin: '50% 18%' },
      clothes: { rotate: 0.4, scaleY: 1.005, origin: '50% 45%' },
      eyes: { state: 'eye_wide', openness: 1.15 },
      shadow: { scaleX: 0.95, opacity: 0.45 }
    });

    assert(mockFigure.style.transform.includes('rotate(-3.20deg)'));
    assert(mockFigure.style.transform.includes('translate(-2.00px, 1.50px)'));
    assert.strictEqual(mockFigure.dataset.animState, 'poke');
    assert.strictEqual(mockFigure.dataset.eyeState, 'eye_wide');
  });

  check('render() 为 hair 和 dress 分别注入独立 transformOrigin 与微摆', () => {
    assert.strictEqual(hairImg.style.transformOrigin, '50% 18%');
    assert(hairImg.style.transform.includes('rotate(0.80deg)'));

    assert.strictEqual(dressImg.style.transformOrigin, '50% 45%');
    assert(dressImg.style.transform.includes('rotate(0.40deg)'));
  });

  check('render() 正确更新投影缩放', () => {
    assert(mockShadow.style.transform.includes('scaleX(0.950)'));
    assert.strictEqual(mockShadow.style.opacity, '0.450');
  });

  check('异常隔离保护：DOM 属性异常不影响后续运行', () => {
    // 制造一个会在写入时报错的模拟节点
    const badFigure = {
      get style() { throw new Error('DOM exploded'); }
    };
    const faultRenderer = new DomAnimationRenderer({
      figureElement: badFigure
    });

    let threw = false;
    try {
      faultRenderer.render({ state: 'idle', body: { scaleX: 1 } });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false);
    faultRenderer.destroy();
  });

  check('reset() 重置 DOM 内联变换与状态标注', () => {
    renderer.render({
      state: 'walk',
      body: { scaleX: 1, scaleY: 1, translateX: 0, translateY: -2, rotate: 1 },
      hair: { rotate: 0.5, origin: '50% 18%' },
      clothes: { rotate: 0.3, origin: '50% 45%' },
      eyes: { state: 'eye_open', openness: 1.0 },
      shadow: { scaleX: 1, opacity: 0.5 }
    });
    assert.strictEqual(mockFigure.dataset.animState, 'walk');
    renderer.reset();
    assert.strictEqual(mockFigure.style.transform, '');
    assert.strictEqual(mockFigure.dataset.animState, undefined);
  });

  check('destroy() 清理 inline 样式和状态', () => {
    renderer.destroy();
    assert.strictEqual(renderer.destroyed, true);
    assert.strictEqual(mockFigure.style.transform, '');
    assert.strictEqual(mockFigure.dataset.animState, undefined);
  });
})();

console.log('\n' + (failures ? failures + ' 项失败' : 'RenderAdapter 测试全部通过'));
process.exit(failures ? 1 : 0);
