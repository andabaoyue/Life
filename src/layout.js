/**
 * 窗口几何 —— 纯函数，不 require electron，所以能在 node 侧直接测。
 *
 * 为什么要单独拿出来：缩放曾经写成
 *   const [w, h] = win.getSize();
 *   setSize(nw, Math.round(nw * (h / w)))
 * 也就是**用上一次的宽高比推下一次**。每次取整都把这个比例往一边带一点，
 * 连点几轮放大缩小就看得出形变：
 *   340x480 → 连点 6 次 1.1 → 602x851 → 连点 6 次 0.9 → 320x453
 *   （按 480/340 应该是 320x452，多长了一像素，而且这个误差只会累积不会回零）
 * 比例是设计值（立绘 + 气泡 + 输入框的布局是按它排的），不是量出来的，
 * 所以它必须是常量。
 */

const BASE_W = 340;
const BASE_H = 480;
const ASPECT = BASE_H / BASE_W;   // 高/宽，写死
const MIN_W = 200;
const MAX_W = 760;

function clampWidth(w) {
  return Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
}

function heightFor(width) {
  return Math.round(width * ASPECT);
}

/** 一次缩放：从「目标宽度 = 当前宽度 × 系数」出发，高度一律按设计比例算 */
function nextSize(currentW, factor) {
  const w = clampWidth(currentW * factor);
  return { w, h: heightFor(w) };
}

/**
 * 缩放时把窗口**下边缘**钉住。
 * 窗口的 x/y 是左上角，而桌宠在 CSS 里是 bottom 定位（脚踩屏幕）。
 * 只 setSize 不补 y，变高的那部分全长在下面，人就往屏幕底下陷进去；
 * 缩小则相反，会突然往上跳。
 */
function anchorBottom(y, oldH, newH) {
  return Math.round(y + (oldH - newH));
}

module.exports = { BASE_W, BASE_H, ASPECT, MIN_W, MAX_W,
                   clampWidth, heightFor, nextSize, anchorBottom };
