"""绿幕抠图 v5 —— YCbCr 色度距离 + 自动标定 + 色度去混合

演进过程（为什么前面几版不行）：
  v1 固定阈值 + 连通域削边 -> 细发丝被整片吃掉
  v2 绿色溢出量 + 填洞      -> 发丝缝隙的背景被填成前景，出现绿色块
  v3 色度投影              -> 偏蓝白发被误判成半透明，边缘起雾
  v4 溢出量 + 自动标定      -> 抠得干净，但黄色/黄绿发夹溢出量与背景绿
                              接近，被误抠成半透明而变黑

v5 的做法：在 YCbCr 的色度平面里量「离背景绿有多远」。
黄色 (Cb≈48, Cr≈127) 与背景绿 (Cb≈113, Cr≈88) 相距 75，
而半透明发丝混的是背景绿，方向上正好落在原点到背景色之间，
所以既能保住彩色发夹，又能让发丝软边正常透明。

阈值不用手调：从四边取背景色，再用背景色度的离散度推出噪声底，
斜坡起点 = 3σ，终点 = 起点 * 2.2。

最后用 p = a*F + (1-a)*B 反解前景色，还原染上绿光的发丝。

用法: python3 chroma.py 输入.png 输出.png [--trim] [--crop-bottom 0.05]
"""
import sys
import numpy as np
import cv2
from PIL import Image


def to_ycbcr(rgb):
    """rgb: float32 0-255 -> YCbCr float32"""
    return cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2YCrCb) \
             .astype(np.float32)


def border_bg(rgb):
    """从四边估计背景色（RGB）"""
    band = np.concatenate([
        rgb[:12].reshape(-1, 3), rgb[-12:].reshape(-1, 3),
        rgb[:, :12].reshape(-1, 3), rgb[:, -12:].reshape(-1, 3)])
    ex = band[:, 1] - np.maximum(band[:, 0], band[:, 2])
    greenish = band[ex > 15]
    if len(greenish) < 200:
        greenish = band
    return np.median(greenish, axis=0)


def chroma_alpha(rgb, B):
    """按 YCbCr 色度距离算 alpha，分界点用 Otsu 自动定，不手调阈值"""
    ycc = to_ycbcr(rgb)
    cb, cr = ycc[..., 1], ycc[..., 2]

    bcc = to_ycbcr(np.tile(B, (2, 2, 1)))
    cbB, crB = float(np.median(bcc[..., 1])), float(np.median(bcc[..., 2]))

    dist = np.sqrt((cb - cbB) ** 2 + (cr - crB) ** 2)

    # Otsu 在「背景绿」与「前景」之间找分界，再用背景噪声定斜坡起点
    T, _ = cv2.threshold(np.clip(dist, 0, 255).astype(np.uint8),
                         0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    T = max(float(T), 8.0)
    bg = dist < T * 0.6
    sd = float(np.std(dist[bg])) if bg.sum() > 1000 else 3.0
    lo = T * 0.45 + 2.0 * sd
    hi = T * 1.7
    return np.clip((dist - lo) / (hi - lo), 0.0, 1.0).astype(np.float32), (lo, hi)


def unmix(rgb, B, alpha):
    """反解前景色 F = (p - (1-a)B) / a"""
    a = alpha[..., None]
    F = np.clip((rgb - (1.0 - a) * B) / np.maximum(a, 1e-3), 0, 255)
    # 低 alpha 处反解不稳定：只在明显偏绿时压绿色
    R, G, Bc = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    safe = rgb.copy()
    safe[..., 1] = np.minimum(G, np.maximum(R, Bc) + 6)
    return np.where(alpha[..., None] < 0.12, safe, F)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    args = sys.argv[3:]
    trim = '--trim' in args
    cb = 0.05
    if '--crop-bottom' in args:
        cb = float(args[args.index('--crop-bottom') + 1])

    rgb = np.array(Image.open(src).convert('RGB')).astype(np.float32)
    if cb > 0:
        rgb = rgb[:int(rgb.shape[0] * (1 - cb))]
    h, w = rgb.shape[:2]

    B = border_bg(rgb)
    if B[1] - max(B[0], B[2]) < 15:
        raise SystemExit('背景不像绿幕，换一张纯绿底图')

    alpha, (lo, hi) = chroma_alpha(rgb, B)

    # 去背景上的孤立噪点：按「最小面积 + 不贴边」过滤，
    # 而不是只保留最大连通块 —— 耳坠、发夹、飘起的发丝可能和主体不连通，
    # 只留最大块会把它们整个擦掉。
    # 贴边的小块（绿幕阴影、溢色）不受面积保护直接剔，否则 trim 框会被撑到全幅。
    m = (alpha > 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    if n > 2:
        largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        keep = []
        for i in range(1, n):
            x, y, bw, bh, area = stats[i, :5]
            touches = (x == 0 or y == 0 or x + bw >= w or y + bh >= h)
            if i == largest or (area >= 40 and not touches):
                keep.append(i)
        alpha = np.where(np.isin(lab, keep), alpha, 0.0).astype(np.float32)

    guide = (rgb.mean(-1) / 255.0).astype(np.float32)
    alpha = np.clip(cv2.ximgproc.guidedFilter(guide, alpha, 4, 5e-4), 0, 1)

    out = np.dstack([unmix(rgb, B, alpha), alpha * 255.0]).astype(np.uint8)

    if trim:
        ys, xs = np.where(alpha > 0.04)
        p = 10
        out = out[max(0, ys.min() - p):min(h, ys.max() + p),
                  max(0, xs.min() - p):min(w, xs.max() + p)]

    Image.fromarray(out).save(dst)
    print('saved %s  %dx%d  bg=%s  ramp=%.0f-%.0f  soft_px=%d'
          % (dst, out.shape[1], out.shape[0], B.astype(int).tolist(),
             lo, hi, int(((alpha > 0.02) & (alpha < 0.98)).sum())))


if __name__ == '__main__':
    main()
