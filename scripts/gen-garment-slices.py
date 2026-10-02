#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
过渡期衣物切片生成器（v1.0 资产补全计划 · 方案 B）
=================================================
资产实况：11 张衣物切片是 3KB 全透明占位、外套切片是平铺「商品图」——没有一张是
「穿在素体姿势上的抠图」，纸娃娃式自由搭配因此无法呈现。

本脚本在素体（base.png，760x1000）轮廓上按身体分带绘制衣物切片：
- 轮廓随形（每行取素体 alpha 的左右极值 + 松量），衣物贴身不穿帮；
- 垂直明暗渐变 + 中轴高光 + 边缘羽化，避免纯色块的死板；
- 输出到 catalog 既有路径（src/wardrobe.js 的 file 字段零改动）。

生成的切片是「程序绘制的过渡资产」，像素级美术资产补齐后可整体替换。
"""
import os
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_PATH = os.path.join(ROOT, 'assets', 'character', 'base', 'base.png')

base = Image.open(BASE_PATH).convert('RGBA')
W, H = base.size
arr = np.array(base)
mask = arr[:, :, 3] > 128
ys, xs = np.where(mask)
FIG_Y0, FIG_Y1 = int(ys.min()), int(ys.max())
FIG_H = FIG_Y1 - FIG_Y0

_row_cache = {}
def row_extent(y):
    if y in _row_cache:
        return _row_cache[y]
    row = np.where(mask[y])[0]
    e = (int(row.min()), int(row.max())) if len(row) else (None, None)
    _row_cache[y] = e
    return e

def garment_mask(band0, band1, margin, flare=0):
    """身体分带轮廓填充：band 为图高比例区间，margin 为松量（px），flare 为下摆放量。"""
    m = np.zeros((H, W), dtype=np.uint8)
    ya, yb = FIG_Y0 + int(FIG_H * band0), FIG_Y0 + int(FIG_H * band1)
    for y in range(ya, min(yb, FIG_Y1) + 1):
        e = row_extent(y)
        if e[0] is None:
            continue
        t = (y - ya) / max(1, (yb - ya))
        mg = int(margin + flare * t)
        xa, xb = max(0, e[0] - mg), min(W - 1, e[1] + mg)
        m[y, xa:xb + 1] = 255
    return m

def shade(color, band0, band1):
    """垂直明暗（上亮下暗）+ 中轴微高光。"""
    c = np.zeros((H, W, 3), dtype=np.float32)
    yv = np.linspace(0.0, 1.0, H, dtype=np.float32)[:, None]
    ramp = 1.0 - 0.16 * yv
    xh = np.linspace(-1.0, 1.0, W, dtype=np.float32)[None, :]
    hl = 1.0 + 0.05 * np.cos(xh * np.pi / 2.0)
    for i in range(3):
        c[:, :, i] = color[i] * ramp * hl
    return np.clip(c, 0, 255).astype(np.uint8)

def make(rel_path, band0, band1, margin, color, flare=0):
    out_dir = os.path.join(ROOT, 'assets', 'character', os.path.dirname(rel_path))
    os.makedirs(out_dir, exist_ok=True)
    m = garment_mask(band0, band1, margin, flare)
    mi = Image.fromarray(m).filter(ImageFilter.GaussianBlur(1.4))
    out = np.zeros((H, W, 4), dtype=np.uint8)
    out[:, :, :3] = shade(color, band0, band1)
    out[:, :, 3] = np.array(mi)
    path = os.path.join(out_dir, os.path.basename(rel_path))
    Image.fromarray(out, 'RGBA').save(path)
    print('generated', rel_path)

# ---------- 九件衣物（分带 / 松量 / 配色按母版风格取样） ----------
make('tops/lace_corset_01.png',      0.200, 0.430, 3,  (30, 30, 38))
make('tops/gray_tee_01.png',         0.180, 0.470, 8,  (146, 146, 152))
make('bottoms/black_shorts_01.png',  0.430, 0.585, 4,  (34, 34, 40))
make('bottoms/sport_shorts_01.png',  0.430, 0.575, 4,  (82, 82, 90))
make('dresses/gothic_black_01.png',  0.200, 0.720, 5,  (26, 26, 34), flare=8)
make('socks/white_thighhigh_01.png', 0.550, 0.870, 2,  (240, 240, 246))
make('shoes/black_boots_01.png',     0.845, 1.000, 4,  (24, 24, 30))
make('shoes/white_sneakers_01.png',  0.880, 1.000, 4,  (242, 242, 246))
make('outerwear/white_tech_jacket_01.png', 0.150, 0.640, 14, (244, 244, 250))

# ---------- 样张：素体 + 发 + 休闲三件套，供人工验图 ----------
hair = Image.open(os.path.join(ROOT, 'assets', 'character', 'hair', 'silver_wavy_01.png')).convert('RGBA')
sample = base.copy()
for p in ['socks/white_thighhigh_01.png', 'tops/gray_tee_01.png',
          'bottoms/sport_shorts_01.png', 'shoes/white_sneakers_01.png']:
    sample.alpha_composite(Image.open(os.path.join(ROOT, 'assets', 'character', p)).convert('RGBA'))
sample.alpha_composite(hair)
scratch = os.path.join(ROOT, 'scratch')
os.makedirs(scratch, exist_ok=True)
sample.save(os.path.join(scratch, 'sample_casual.png'))

sample2 = base.copy()
for p in ['dresses/gothic_black_01.png', 'shoes/black_boots_01.png']:
    sample2.alpha_composite(Image.open(os.path.join(ROOT, 'assets', 'character', p)).convert('RGBA'))
sample2.alpha_composite(hair)
sample2.save(os.path.join(scratch, 'sample_gothic.png'))
print('samples written to scratch/')
