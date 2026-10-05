#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
初澜（Chulan）Q 版像素精灵第一版站姿原型生成器 (精修艺术版 · 64x80 纯 CPU 点阵)
========================================================================
依据用户提出的「可爱细节清单」精雕细琢：
1. 眼角双高光（一大一小水灵双白点）
2. 标志性单侧眼下泪痣（观众视角右眼下精准 1px）
3. 发尾淡冰蓝按发束分簇 3 阶色阶跳（非生硬横切，自然发丝簇落感）
4. 头顶微翘呆毛一根（连续弧线，灵动俏皮）
5. 小内八字站姿 + 萌系圆手身前轻点（憨态与羞怯感）
6. 蓬松微卷银发披散 + 胸前两大垂落发束（发量丰盈）
7. 短翘白披肩、哥特黑蕾丝抹胸、厚底圆头黑靴
"""

import os
from PIL import Image

OUT_DIR = r"D:\software\huihua\prototypes"
os.makedirs(OUT_DIR, exist_ok=True)

W, H = 64, 80
img_native = Image.new('RGBA', (W, H), (0, 0, 0, 0))

# ----------------- 精调色板 -----------------
# 皮肤与面部
C_SKIN_BASE   = (253, 238, 230, 255)
C_SKIN_LIGHT  = (255, 248, 243, 255)
C_SKIN_SHADE  = (238, 210, 198, 255)
C_SKIN_DEEP   = (218, 185, 172, 255)  # 下巴与颈部阴影
C_SKIN_BLUSH  = (255, 182, 188, 255)
C_MOLE        = (64, 48, 58, 255)     # 泪痣（深褐紫）
C_LIP         = (226, 148, 154, 255)

# 眼睛
C_LASH        = (24, 20, 30, 255)     # 睫毛
C_PUPIL       = (28, 42, 70, 255)     # 瞳孔深蓝黑
C_IRIS        = (65, 115, 180, 255)   # 蓝灰虹膜主色
C_IRIS_LT     = (115, 172, 235, 255)  # 虹膜反光青蓝
C_GLINT       = (255, 255, 255, 255)  # 纯白双高光
C_SCLERA      = (244, 247, 254, 255)

# 银白发与发尾淡冰蓝（发簇阶调跳）
C_HAIR_WHITE  = (255, 255, 255, 255)  # 高光与呆毛尖
C_HAIR_SILVER = (242, 245, 252, 255)  # 银白主色
C_HAIR_MID    = (225, 231, 244, 255)  # 银白层次
C_HAIR_SHADE  = (200, 208, 226, 255)  # 阴影与暗束
C_HAIR_ICE1   = (165, 194, 228, 255)  # 阶1：柔淡冰蓝过渡
C_HAIR_ICE2   = (110, 165, 225, 255)  # 阶2：清透冰蓝
C_HAIR_ICE3   = (65, 120, 180, 255)   # 阶3：发尖深冰蓝

# 发饰（黑蝴蝶结与银十字星）
C_BOW_BLACK   = (20, 20, 28, 255)
C_BOW_MID     = (40, 40, 54, 255)
C_BOW_CROSS   = (225, 230, 245, 255)

# 服饰：机能白披肩、哥特黑抹胸、短裤、长袜、圆头黑靴
C_CAPE_WHITE  = (252, 253, 255, 255)
C_CAPE_SHADE  = (220, 225, 238, 255)
C_CAPE_DEEP   = (175, 182, 198, 255)
C_CORSET_BLK  = (18, 18, 26, 255)
C_CORSET_MID  = (36, 36, 48, 255)
C_ZIPPER_MET  = (165, 170, 185, 255)
C_SOCK_WHITE  = (248, 250, 255, 255)
C_SOCK_SHADE  = (212, 218, 232, 255)
C_GARTER      = (26, 26, 36, 255)
C_BOOT_BLK    = (14, 14, 20, 255)
C_BOOT_MID    = (30, 30, 42, 255)
C_BOOT_HIGH   = (64, 66, 80, 255)
C_BOOT_BUCKLE = (185, 190, 205, 255)


def set_px(x, y, color):
    if 0 <= x < W and 0 <= y < H:
        img_native.putpixel((x, y), color)


def fill_rect(x1, y1, x2, y2, color):
    for y in range(y1, y2 + 1):
        for x in range(x1, x2 + 1):
            set_px(x, y, color)


# =========================================================
# 1. 后发披散（双侧瀑布大发束，自然垂落包拢身体，发尾冰蓝 3 阶跳）
# =========================================================
# 后头枕部基底 (仅在头部与颈部后方 y 18..36)
for y in range(18, 37):
    for x in range(22, 43):
        if y < 32 or (x < 26 or x > 38):
            set_px(x, y, C_HAIR_SHADE)

# 左侧大披发瀑布 (从左肩外侧倾泻至腿侧 x 13..23, y 25..63)
for y in range(25, 64):
    wave = 1 if (y // 4) % 2 == 0 else 0
    x_left = 13 + wave
    x_right = 23
    for x in range(x_left, x_right + 1):
        # 发梢阶调按发束 x 坐标交错（自然发簇感，非横切）
        tip_offset = (x % 3) * 2 - 1
        if y < 47 + tip_offset:
            col = C_HAIR_SILVER if (x + y) % 3 != 0 else C_HAIR_MID
            if x == x_left:
                col = C_HAIR_SHADE
        elif y < 53 + tip_offset:
            col = C_HAIR_ICE1
        elif y < 58 + tip_offset:
            col = C_HAIR_ICE2
        else:
            col = C_HAIR_ICE3
        set_px(x, y, col)

# 右侧大披发瀑布 (从右肩外侧倾泻至腿侧 x 41..51, y 25..63)
for y in range(25, 64):
    wave = 1 if (y // 4) % 2 == 0 else 0
    x_left = 41
    x_right = 51 - wave
    for x in range(x_left, x_right + 1):
        tip_offset = ((51 - x) % 3) * 2 - 1
        if y < 47 + tip_offset:
            col = C_HAIR_SILVER if (x + y) % 3 != 0 else C_HAIR_MID
            if x == x_right:
                col = C_HAIR_SHADE
        elif y < 53 + tip_offset:
            col = C_HAIR_ICE1
        elif y < 58 + tip_offset:
            col = C_HAIR_ICE2
        else:
            col = C_HAIR_ICE3
        set_px(x, y, col)

# 发尾自然的微卷尖角
for (x, y) in [(14, 63), (15, 64), (16, 65), (17, 64), (19, 63), (20, 64), (21, 65), (22, 64)]:
    set_px(x, y, C_HAIR_ICE3)
for (x, y) in [(42, 64), (43, 65), (44, 64), (46, 63), (47, 64), (48, 65), (49, 64), (50, 63)]:
    set_px(x, y, C_HAIR_ICE3)


# =========================================================
# 2. 头部底胚与颈部
# =========================================================
# 婴儿肥圆润脸蛋（圆形/椭圆，弧度柔和）
face_rows = [
    (18, 26, 38),
    (19, 24, 40),
    (20, 23, 41),
    (21, 22, 42),
    (22, 21, 43),
    (23, 20, 44),
    (24, 20, 44),
    (25, 20, 44),
    (26, 20, 44),
    (27, 20, 44),
    (28, 20, 44),
    (29, 21, 43),
    (30, 22, 42),
    (31, 24, 40),
    (32, 26, 38),
    (33, 28, 36),
    (34, 30, 34),
]
for y, x1, x2 in face_rows:
    for x in range(x1, x2 + 1):
        set_px(x, y, C_SKIN_BASE)

# 颈部与下巴暗影
fill_rect(30, 34, 34, 34, C_SKIN_DEEP)
fill_rect(30, 35, 34, 36, C_SKIN_SHADE)


# =========================================================
# 3. 双腿与内八字脚（小内八字站姿 + 圆头厚底靴）
# =========================================================
# 大腿肉感基底 (y 49..52)
fill_rect(26, 49, 29, 52, C_SKIN_BASE)
fill_rect(35, 49, 38, 52, C_SKIN_BASE)

# 左腿皮质大腿袜圈（仅观众视角右腿，x 35..38, y 51）
fill_rect(35, 51, 38, 51, C_GARTER)

# 白色过膝袜（微微内聚内八姿态）
# 左腿（观众左）：微向右聚
for y in range(53, 65):
    # 袜口微宽，膝下微收
    ox = 27 + (1 if y > 58 else 0)
    set_px(ox - 1, y, C_SOCK_SHADE)
    set_px(ox,     y, C_SOCK_WHITE)
    set_px(ox + 1, y, C_SOCK_WHITE)
    set_px(ox + 2, y, C_SOCK_SHADE)

# 右腿（观众右）：微向左聚
for y in range(53, 65):
    ox = 37 - (1 if y > 58 else 0)
    set_px(ox - 2, y, C_SOCK_SHADE)
    set_px(ox - 1, y, C_SOCK_WHITE)
    set_px(ox,     y, C_SOCK_WHITE)
    set_px(ox + 1, y, C_SOCK_SHADE)

# 圆头厚底黑靴（小内八字站姿！）
# 左靴 (鞋尖指向右上内侧，圆头憨憨感)
fill_rect(24, 65, 30, 71, C_BOOT_MID)
fill_rect(25, 66, 29, 70, C_BOOT_BLK)
fill_rect(23, 72, 31, 74, C_BOOT_BLK)   # 厚底橡胶大底
set_px(29, 68, C_BOOT_HIGH)             # 圆鞋头反光
set_px(30, 69, C_BOOT_HIGH)
set_px(26, 67, C_BOOT_BUCKLE)           # 金属扣点

# 右靴 (鞋尖指向左上内侧，内八对聚)
fill_rect(34, 65, 40, 71, C_BOOT_MID)
fill_rect(35, 66, 39, 70, C_BOOT_BLK)
fill_rect(33, 72, 41, 74, C_BOOT_BLK)   # 厚底
set_px(35, 68, C_BOOT_HIGH)             # 圆鞋头反光
set_px(34, 69, C_BOOT_HIGH)
set_px(38, 67, C_BOOT_BUCKLE)           # 金属扣点


# =========================================================
# 4. 躯干衣饰：哥特蕾丝抹胸、高腰短裤、短翘白披肩、萌系圆手
# =========================================================
# 高腰短裤 (y 45..49, x 25..39)
fill_rect(25, 45, 39, 48, C_CORSET_BLK)
fill_rect(26, 49, 29, 49, C_CORSET_MID)
fill_rect(35, 49, 38, 49, C_CORSET_MID)

# 黑色哥特抹胸 (y 37..44, x 26..38)
fill_rect(26, 37, 38, 44, C_CORSET_BLK)
fill_rect(27, 38, 37, 43, C_CORSET_MID)
# 中心金属拉链与搭扣细节
for y in [38, 40, 42]:
    set_px(31, y, C_ZIPPER_MET)
    set_px(32, y, C_ZIPPER_MET)

# 短翘白机能披肩（落肩、短款、微翘波浪边）
# 左右肩披覆
fill_rect(20, 36, 26, 42, C_CAPE_WHITE)
fill_rect(38, 36, 44, 42, C_CAPE_WHITE)
# 蓬松微翘外袖轮廓
fill_rect(19, 39, 22, 44, C_CAPE_WHITE)
fill_rect(42, 39, 45, 44, C_CAPE_WHITE)
set_px(18, 42, C_CAPE_WHITE)
set_px(46, 42, C_CAPE_WHITE)
set_px(18, 43, C_CAPE_SHADE)
set_px(46, 43, C_CAPE_SHADE)
# 披肩底部暗褶
fill_rect(20, 43, 23, 44, C_CAPE_SHADE)
fill_rect(41, 43, 44, 44, C_CAPE_SHADE)
# 披肩垂下的黑织带 (Straps)
fill_rect(19, 45, 20, 50, C_CORSET_BLK)
fill_rect(44, 45, 45, 50, C_CORSET_BLK)

# 圆手轻贴身前（两只肉肉小圆手在身前相碰轻点，娇憨可爱）
# 左小手 (x 28..30, y 43..45)
fill_rect(27, 43, 29, 45, C_SKIN_BASE)
set_px(29, 44, C_SKIN_LIGHT)
# 右小手 (x 34..36, y 43..45)
fill_rect(34, 43, 36, 45, C_SKIN_BASE)
set_px(34, 44, C_SKIN_LIGHT)


# =========================================================
# 5. 面部五官：灵动水灵双高光大眼、泪痣、粉腮
# =========================================================
# 软萌腮红 (眼下两侧粉晕)
fill_rect(22, 28, 24, 29, C_SKIN_BLUSH)
set_px(23, 27, C_SKIN_BLUSH)
fill_rect(39, 28, 41, 29, C_SKIN_BLUSH)
set_px(40, 27, C_SKIN_BLUSH)

# 甜美小口
set_px(31, 32, C_LIP)
set_px(32, 32, C_LIP)

# 左眼（观众左，x 24..28, y 22..27）
# 上睫毛柔和弧度
set_px(23, 23, C_LASH)
set_px(24, 22, C_LASH)
set_px(25, 22, C_LASH)
set_px(26, 22, C_LASH)
set_px(27, 22, C_LASH)
set_px(28, 23, C_LASH)
# 眼白 Sclera
set_px(23, 24, C_SCLERA)
set_px(28, 24, C_SCLERA)
# 虹膜蓝灰底色
fill_rect(24, 23, 27, 26, C_IRIS)
# 瞳孔深蓝黑
set_px(26, 24, C_PUPIL)
# 下虹膜清透亮蓝
set_px(25, 26, C_IRIS_LT)
set_px(26, 26, C_IRIS_LT)
# ★【水灵双高光】：主高光 2px 竖白点 + 次高光 1px 右下小白点
set_px(24, 23, C_GLINT)
set_px(24, 24, C_GLINT)
set_px(27, 25, C_GLINT)

# 右眼（初澜左眼，观众右，x 35..39, y 22..27）
# 上睫毛弧度
set_px(35, 23, C_LASH)
set_px(36, 22, C_LASH)
set_px(37, 22, C_LASH)
set_px(38, 22, C_LASH)
set_px(39, 22, C_LASH)
set_px(40, 23, C_LASH)
# 眼白
set_px(35, 24, C_SCLERA)
set_px(40, 24, C_SCLERA)
# 虹膜
fill_rect(36, 23, 39, 26, C_IRIS)
# 瞳孔
set_px(37, 24, C_PUPIL)
# 下虹膜清透亮蓝
set_px(37, 26, C_IRIS_LT)
set_px(38, 26, C_IRIS_LT)
# ★【水灵双高光】：主高光 2px 竖白点 + 次高光 1px
set_px(36, 23, C_GLINT)
set_px(36, 24, C_GLINT)
set_px(39, 25, C_GLINT)

# ★【签名不变式】：初澜左眼下泪痣（观众右眼正下方 1px）
set_px(39, 28, C_MOLE)


# =========================================================
# 6. 前发：圆润头顶、碎刘海、胸前垂落双大发束、蝴蝶结、呆毛
# =========================================================
# 银发饱满圆弧头顶 (y 7..14)
head_top = [
    (7,  28, 35),
    (8,  25, 38),
    (9,  23, 40),
    (10, 21, 42),
    (11, 20, 43),
    (12, 19, 44),
    (13, 19, 44),
]
for y, x1, x2 in head_top:
    for x in range(x1, x2 + 1):
        if y == 7:
            set_px(x, y, C_HAIR_WHITE)
        elif y == 8 and x in [29, 30, 31, 32, 33, 34]:
            set_px(x, y, C_HAIR_WHITE)
        elif x in [x1, x2]:
            set_px(x, y, C_HAIR_MID)
        else:
            set_px(x, y, C_HAIR_SILVER)

# 灵动碎刘海（自然发簇，不呆板）
# 左刘海束
fill_rect(20, 14, 23, 21, C_HAIR_SILVER)
set_px(21, 22, C_HAIR_SILVER)
# 中左刘海束
fill_rect(24, 14, 27, 20, C_HAIR_SILVER)
set_px(25, 21, C_HAIR_SILVER)
# 眉心中央微透小分叉
fill_rect(28, 14, 31, 17, C_HAIR_SILVER)
set_px(29, 18, C_HAIR_SILVER)
# 中右刘海束
fill_rect(32, 14, 35, 17, C_HAIR_SILVER)
fill_rect(34, 15, 37, 20, C_HAIR_SILVER)
set_px(36, 21, C_HAIR_SILVER)
# 右刘海束
fill_rect(38, 14, 41, 21, C_HAIR_SILVER)
set_px(40, 22, C_HAIR_SILVER)

# 右侧黑色蝴蝶结发饰（观众视角右上 x 42..47, y 12..17）
fill_rect(42, 12, 47, 16, C_BOW_BLACK)
fill_rect(43, 13, 46, 15, C_BOW_MID)
set_px(44, 14, C_BOW_BLACK)           # 蝴蝶结中心结
# 银色十字星挂坠 (Cross charm)
set_px(45, 17, C_BOW_CROSS)
set_px(45, 18, C_BOW_CROSS)
set_px(44, 18, C_BOW_CROSS)
set_px(46, 18, C_BOW_CROSS)
set_px(45, 19, C_BOW_CROSS)

# ★【胸前垂落两大发束】（Front Strands，发量感具象化）
# 左前发束 (从鬓角 y 22 垂落至胸腹 y 50，发尾微卷内收)
for y in range(22, 43):
    set_px(17, y, C_HAIR_MID)
    set_px(18, y, C_HAIR_SILVER)
    set_px(19, y, C_HAIR_SILVER)
# 发尾淡冰蓝 3 阶跳
for y in range(43, 46):
    set_px(17, y, C_HAIR_ICE1)
    set_px(18, y, C_HAIR_ICE1)
for y in range(46, 49):
    set_px(17, y, C_HAIR_ICE2)
    set_px(18, y, C_HAIR_ICE2)
set_px(18, 49, C_HAIR_ICE3)
set_px(19, 49, C_HAIR_ICE3)           # 微卷尖

# 右前发束 (从鬓角 y 22 垂落至胸腹 y 50)
for y in range(22, 43):
    set_px(44, y, C_HAIR_SILVER)
    set_px(45, y, C_HAIR_SILVER)
    set_px(46, y, C_HAIR_MID)
# 发尾淡冰蓝 3 阶跳
for y in range(43, 46):
    set_px(45, y, C_HAIR_ICE1)
    set_px(46, y, C_HAIR_ICE1)
for y in range(46, 49):
    set_px(45, y, C_HAIR_ICE2)
    set_px(46, y, C_HAIR_ICE2)
set_px(44, 49, C_HAIR_ICE3)
set_px(45, 49, C_HAIR_ICE3)           # 微卷尖

# ★【头顶微翘呆毛】（Ahoge - 拙劣可爱感命脉，为互动弹跳留戏）
# 连续连贯的灵动弧线，从发旋 (31, 7) 起，向左上弯翘，尖端回勾
ahoge_pixels = [
    (31, 7, C_HAIR_SILVER),
    (31, 6, C_HAIR_SILVER),
    (30, 5, C_HAIR_SILVER),
    (29, 4, C_HAIR_WHITE),
    (28, 3, C_HAIR_WHITE),            # 最高拱起峰
    (27, 3, C_HAIR_WHITE),
    (26, 4, C_HAIR_SILVER),           # 尖端回勾
]
for x, y, c in ahoge_pixels:
    set_px(x, y, c)


# =========================================================
# 导出图片（纯 CPU，纯 Pillow）
# =========================================================
path_native = os.path.join(OUT_DIR, "chulan_chibi_stand_64x80.png")
img_native.save(path_native)
print("Saved native 64x80:", path_native)

path_4x = os.path.join(OUT_DIR, "chulan_chibi_stand_256x320_preview.png")
img_4x = img_native.resize((256, 320), Image.Resampling.NEAREST)
img_4x.save(path_4x)
print("Saved 4x preview (256x320):", path_4x)

path_8x = os.path.join(OUT_DIR, "chulan_chibi_stand_512x640_large.png")
img_8x = img_native.resize((512, 640), Image.Resampling.NEAREST)
img_8x.save(path_8x)
print("Saved 8x large (512x640):", path_8x)
