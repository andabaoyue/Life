/**
 * 窗口几何测试 —— 缩放不能累积取整误差。
 *
 * 旧写法用「上一次的 h/w」当下一次的比例，每次 round 都把比例带偏一点，
 * 来回缩放收不回原尺寸（340x480 → 放大 6 次 → 缩小 6 次 → 320x453，
 * 而设计比例给的是 452）。这一组测试锁的就是「比例是常量」这件事。
 */
const L = require('../src/layout');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

/* 1. 设计比例是常量，不是量出来的 */
check('ASPECT 由高/宽定义且不可变', L.ASPECT === L.BASE_H / L.BASE_W);
check('基准尺寸下 heightFor 正好等于 BASE_H', L.heightFor(L.BASE_W) === L.BASE_H,
  L.BASE_W + 'x' + L.heightFor(L.BASE_W));

/* 2. 全量程逐个宽度：round 带来的像素误差最多半像素 */
let worstPx = 0;
for (let w = L.MIN_W; w <= L.MAX_W; w++) {
  const dev = Math.abs(L.heightFor(w) - w * L.ASPECT);
  if (dev > worstPx) worstPx = dev;
}
check('全量程内高度偏差不超过半像素', worstPx <= 0.5, 'worst=' + worstPx.toFixed(3) + 'px');

/* 3. 来回缩放必须收得回 —— 这正是旧实现失败的地方 */
const roundTrip = (factor, times) => {
  let w = L.BASE_W;
  for (let i = 0; i < times; i++) w = L.nextSize(w, factor).w;
  for (let i = 0; i < times; i++) w = L.nextSize(w, 1 / factor).w;
  return w;
};
check('×1.1 六次再 ÷1.1 六次回到原宽度',
  roundTrip(1.1, 6) === L.BASE_W, 'got ' + roundTrip(1.1, 6));
// 1.25 那组会撞到 MAX_W 夹取，夹取本身就要损失信息，不该拿来验漂移
check('×1.15 四次再 ÷1.15 四次回到原宽度',
  roundTrip(1.15, 4) === L.BASE_W, 'got ' + roundTrip(1.15, 4));
check('交替缩放 30 次：高度永远等于 heightFor(当前宽度)', (() => {
  let w = L.BASE_W;
  for (let i = 0; i < 30; i++) {
    const s = L.nextSize(w, i % 2 ? 1.1 : 0.9);
    w = s.w;
    if (s.h !== L.heightFor(s.w)) return false;   // 高度永远由当前宽度推
  }
  return true;
})());
/* 拿旧写法跑同一段循环，量出来的差距（脚本复算，不是估的）：
     旧（按当前宽高夹取）：400 次交替缩放后停在 200x280，
       而 200 宽的设计高度是 282 —— 比例被 round 带走了 2 像素，
       且误差只累积不归零，所以永远回不到 heightFor 上。
     新：任何时刻都满足 h === heightFor(w)，回到原宽度就回到原高度。
   早期还记录过一组"不夹取"的数据（6 次放大 + 6 次缩小 → 320x453，
   应为 320x452），那是这条注释的由来；夹取版本更难看出 1 像素，
   所以这里断言的是"最终高度不等于设计高度"这个稳定事实。 */
check('对照旧写法：比例来自上一次量出的 h/w 时确实会漂', (() => {
  let w = L.BASE_W, h = L.BASE_H;
  for (let i = 0; i < 400; i++) {
    const s = L.nextSize(w, i % 2 ? 0.9 : 1.1);
    h = Math.round(s.w * (h / w));           // 病灶：用上一次量出来的比例
    w = s.w;
  }
  return h !== L.heightFor(w);
})());
check('新写法同一串操作后仍然自洽', (() => {
  let w = L.BASE_W;
  for (let i = 0; i < 400; i++) {
    const s = L.nextSize(w, i % 2 ? 0.9 : 1.1);
    if (s.h !== L.heightFor(s.w)) return false;
    w = s.w;
  }
  return true;
})());

/* 4. 边界：夹在 MIN/MAX 之间，且都是整数 */
check('超范围宽度被夹住', L.clampWidth(10) === L.MIN_W && L.clampWidth(9999) === L.MAX_W);
check('夹完仍是整数', Number.isInteger(L.clampWidth(333.7)));
check('缩到最小后再放大不会被粘住',
  L.nextSize(L.MIN_W, 1.1).w > L.MIN_W && L.nextSize(L.MAX_W, 1.1).w === L.MAX_W);

/* 5. 下边缘钉住：y + h 在缩放前后不变（脚不能陷进屏幕底） */
check('anchorBottom 保持下边缘不动', (() => {
  const y = 300, s = L.nextSize(L.BASE_W, 1.1);
  return L.anchorBottom(y, L.BASE_H, s.h) + s.h === y + L.BASE_H;
})());
check('缩小时 y 下移，同样保持下边缘', (() => {
  const y = 300, s = L.nextSize(L.BASE_W, 0.9);
  return L.anchorBottom(y, L.BASE_H, s.h) + s.h === y + L.BASE_H;
})());
check('anchorBottom 返回整数（Electron setContentSize 收小数）',
  Number.isInteger(L.anchorBottom(300, 480, 517)));

/* 6. 回归护栏：main.js 里不许再出现「用上一次的比例推下一次」的写法 */
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  check('main.js 不再用 h / w 反推比例', !/Math\.round\(\s*\w+\s*\*\s*\(\s*h\s*\/\s*w\s*\)/.test(src));
  check('main.js 缩放走 layout 模块', src.includes("require('./src/layout')"));
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
