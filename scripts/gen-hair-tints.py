# -*- coding: utf-8 -*-
"""
发色变体生成器（v1.0 拍板：发色变体先行）
由银白微卷长发切片（assets/character/hair/silver_wavy_01.png）亮度保留着色派生：
阴影/高光结构原样保留，只换色相 —— 同发型不同色，今日即可换装。
新发型（不同剪裁）仍走 §6.7 资产管线，本脚本不伪造剪裁。
"""
from PIL import Image, ImageOps
import os

SRC = os.path.join('assets', 'character', 'hair', 'silver_wavy_01.png')
OUT_DIR = os.path.join('assets', 'character', 'hair')
VARIANTS = {
    'ink_long_01.png':  ((46, 46, 58),   '墨黑微卷长发'),
    'gold_long_01.png': ((198, 156, 64),  '鎏金微卷长发'),
    'pink_long_01.png': ((228, 130, 168), '樱粉微卷长发'),
    'blue_long_01.png': ((74, 106, 180),  '黛蓝微卷长发'),
}

src = Image.open(SRC).convert('RGBA')
alpha = src.getchannel('A')
gray = src.convert('L')
for fname, (rgb, name) in VARIANTS.items():
    black = tuple(int(c * 0.22) for c in rgb)              # 阴影端：目标色压暗
    white = tuple(min(255, int(c + 130)) for c in rgb)     # 高光端：目标色提亮
    out = ImageOps.colorize(gray, black=black, white=white).convert('RGBA')
    out.putalpha(alpha)                                     # 透明边原样
    p = os.path.join(OUT_DIR, fname)
    out.save(p)
    print('生成', name, '->', p, out.size)
print('DONE')
