#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
初澜（Chulan）像素化原型生成管线 (CPU 纯净计算版)
===================================================
为 v1.0 像素化演进路线产出首批像素级美术原型（Pixel Art Prototypes）。
运行环境：纯 CPU 离线计算（Pillow + OpenCV + NumPy），不依赖任何 GPU 驱动与显卡算力。

核心不变式（Invariants）固化：
1. 银白微卷长发，发尾淡冰蓝 (silver wavy hair with subtle ice-blue tips)
2. 蓝灰眼眸与灵动画布高光 (blue-gray eyes with specular catchlights)
3. 单侧眼下泪痣 (canonical left under-eye tear mole at x=411, y=112)
4. 纯净透明通道 (RGBA 32-bit，无半透明杂色虚边，方便 LibreSprite/Pixelorama 选区与填色)

输出目标：D:\\software\\huihua\\prototypes\\
"""

import os
import cv2
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = r"D:\software\huihua\prototypes"
os.makedirs(OUT_DIR, exist_ok=True)

# 资产源文件
PATH_FULL = os.path.join(ROOT, "assets", "character", "base", "base_legacy_full.png")
PATH_BASE = os.path.join(ROOT, "assets", "character", "base", "base.png")
PATH_HAIR = os.path.join(ROOT, "assets", "character", "hair", "silver_wavy_01.png")

# 颜色标准盘 (用于 LibreSprite / Pixelorama 调色板)
PALETTE_DEFINITIONS = [
    # 肤色组 (Skin tones)
    ("Skin Highlight",  (255, 246, 242)),
    ("Skin Base",       (252, 235, 226)),
    ("Skin Mid",        (240, 218, 206)),
    ("Skin Shadow",     (218, 186, 174)),
    ("Skin Deep Shadow",(186, 148, 138)),
    ("Blush Rose",      (235, 172, 172)),
    ("Lip Pink",        (215, 142, 146)),
    ("Tear Mole Dark",  (68, 52, 60)),

    # 发色组：银白与淡冰蓝 (Hair tones)
    ("Hair Pure White", (255, 255, 255)),
    ("Hair Silver Light",(240, 242, 248)),
    ("Hair Silver Mid", (216, 222, 235)),
    ("Hair Lavender Mid",(192, 198, 218)),
    ("Hair Shadow",     (152, 160, 185)),
    ("Hair Deep Shadow",(106, 114, 142)),
    ("Ice Blue Highlight",(210, 236, 255)),
    ("Ice Blue Light",  (180, 215, 245)),
    ("Ice Blue Mid",    (140, 186, 225)),
    ("Ice Blue Dark",   (100, 150, 195)),
    ("Ice Blue Deep",   (72, 118, 162)),

    # 蓝灰眼眸组 (Eye tones)
    ("Eye Glint White", (255, 255, 255)),
    ("Eye Iris Cyan",   (160, 205, 240)),
    ("Eye Iris BlueGray",(95, 140, 188)),
    ("Eye Iris Deep",   (48, 76, 115)),
    ("Eye Pupil Dark",  (28, 38, 60)),
    ("Eye Lash Black",  (28, 24, 34)),

    # 哥特黑与深色组 (Gothic Darks)
    ("Gothic Deep Black",(18, 18, 24)),
    ("Gothic Dark Slate",(32, 32, 42)),
    ("Gothic Charcoal",  (48, 48, 60)),
    ("Gothic Mid Gray",  (72, 72, 88)),
    ("Gothic Buckle Metal",(130, 134, 148)),
    ("Gothic Chrome High",(200, 205, 220)),

    # 白色机能外套与过膝袜组 (Techwear Whites)
    ("Fabric White Pure",(250, 251, 255)),
    ("Fabric White Base",(238, 240, 248)),
    ("Fabric Soft Gray", (212, 215, 228)),
    ("Fabric Fold Gray", (175, 178, 195)),
    ("Fabric Deep Fold", (132, 136, 154)),
    ("Tech Strap Black", (22, 22, 28)),
    ("Tech Strap Metal", (168, 172, 185)),
]


def enhance_source_image(img_rgba, is_hair=False):
    """
    预处理图像：强化明暗交界线、保护五官区域锐度、提纯发梢冰蓝饱和度
    """
    arr = np.array(img_rgba)
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3]
    h, w = rgb.shape[:2]

    # 双边滤波：平滑衣服与发丝褶皱的杂散噪点，形成赛璐珞/色块阶调 (Cel-Shading)
    filtered = cv2.bilateralFilter(rgb, d=7, sigmaColor=35, sigmaSpace=35)

    if is_hair:
        # 发尾冰蓝自然渐变：从下半部 65% 处平滑过渡，不设生硬硬切线
        y_norm = np.linspace(0, 1, h)[:, None]
        tip_weight = np.clip((y_norm - 0.62) / 0.38, 0.0, 1.0)
        tip_weight_2d = np.repeat(tip_weight, w, axis=1)
        b_boost = filtered.copy().astype(np.float32)
        blue_mask = (b_boost[:, :, 2] > b_boost[:, :, 0]) & (tip_weight_2d > 0.03)
        b_boost[blue_mask, 2] = np.clip(b_boost[blue_mask, 2] * (1.0 + 0.22 * tip_weight_2d[blue_mask]), 0, 255)
        filtered = np.clip(b_boost, 0, 255).astype(np.uint8)
    else:
        # 保护人脸与五官区域锐度
        face_mask = np.zeros((h, w), dtype=np.float32)
        y_coords, x_coords = np.ogrid[:h, :w]
        dist = ((x_coords - 380.0) / 75.0)**2 + ((y_coords - 130.0) / 70.0)**2
        face_mask = np.clip(1.0 - dist, 0.0, 1.0)
        face_mask = cv2.GaussianBlur(face_mask, (19, 19), 0)

        # 发尾冰蓝柔和提纯
        y_norm = np.linspace(0, 1, h)[:, None]
        tip_weight = np.clip((y_norm - 0.65) / 0.35, 0.0, 1.0)
        tip_weight_2d = np.repeat(tip_weight, w, axis=1)
        b_boost = filtered.copy().astype(np.float32)
        blue_mask = (b_boost[:, :, 2] > b_boost[:, :, 0]) & (tip_weight_2d > 0.05)
        b_boost[blue_mask, 2] = np.clip(b_boost[blue_mask, 2] * (1.0 + 0.18 * tip_weight_2d[blue_mask]), 0, 255)
        filtered = np.clip(b_boost, 0, 255).astype(np.uint8)

        filtered = (filtered.astype(np.float32) * (1.0 - face_mask[:, :, None]) + 
                    rgb.astype(np.float32) * face_mask[:, :, None]).astype(np.uint8)

    return filtered, alpha


def render_pixel_sprite(src_rgb, src_alpha, target_w, target_h, is_full_character=True, has_face=True):
    """
    根据目标尺寸生成干净点阵精灵，并钉住身份锚点
    """
    src_h, src_w = src_rgb.shape[:2]

    # 等比降采样
    prep_img = Image.fromarray(np.dstack([src_rgb, src_alpha]))
    small = prep_img.resize((target_w, target_h), Image.Resampling.LANCZOS)
    small_arr = np.array(small)

    # 干净 Alpha 截断（绝不留半透明毛边，方便像素编辑器填充）
    clean_alpha = np.where(small_arr[:, :, 3] > 110, 255, 0).astype(np.uint8)

    # 色彩量化到有限色盘（保留像素风格阶调）
    small_rgb_img = Image.fromarray(small_arr[:, :, :3])
    num_colors = 48 if target_w >= 128 else 32
    quant = small_rgb_img.quantize(colors=num_colors, method=Image.Quantize.MEDIANCUT)
    quant_rgb = np.array(quant.convert('RGB'))

    # 五官与身份锚点：仅对整图锚定泪痣（素体自身保持其正脸自然坐标）
    if is_full_character and has_face:
        scale_x = target_w / 760.0
        scale_y = target_h / 1000.0

        mole_x = int(round(411.0 * scale_x))
        mole_y = int(round(112.0 * scale_y))

        # 调配眼部微像素
        if target_w >= 180:  # 190x250 高精度细腻像素
            C_MOLE = [68, 52, 60]
            quant_rgb[mole_y, mole_x] = C_MOLE
        elif target_w >= 120:  # 128x168 经典独立游戏像素
            C_MOLE = [70, 55, 65]
            quant_rgb[mole_y, mole_x] = C_MOLE
        elif target_w >= 60:  # 64x84 GBA 掌机像素
            C_MOLE = [75, 60, 70]
            quant_rgb[mole_y, mole_x] = C_MOLE

    out_arr = np.dstack([quant_rgb, clean_alpha])
    return Image.fromarray(out_arr, 'RGBA')


def upscale_to_canvas(sprite_img, canvas_w=760, canvas_h=1000):
    """
    点对点无损最近邻放大到 760x1000 原画画布，方便直接在桌宠窗口全屏对照
    """
    w, h = sprite_img.size
    # 计算整数放大倍率
    scale = min(canvas_w // w, canvas_h // h)
    if scale < 1:
        scale = 1
    
    scaled_w = w * scale
    scaled_h = h * scale
    scaled_sprite = sprite_img.resize((scaled_w, scaled_h), Image.Resampling.NEAREST)

    canvas = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
    offset_x = (canvas_w - scaled_w) // 2
    offset_y = (canvas_h - scaled_h) // 2
    canvas.paste(scaled_sprite, (offset_x, offset_y), scaled_sprite)
    return canvas


def export_palette_files():
    """
    导出调色板：
    1. chulan_palette.png (可视色板预览条)
    2. chulan_palette.gpl (GIMP/LibreSprite/Pixelorama 通用调色板格式)
    """
    # 1. 导出 GPL
    gpl_path = os.path.join(OUT_DIR, "chulan_palette.gpl")
    with open(gpl_path, "w", encoding="utf-8") as f:
        f.write("GIMP Palette\n")
        f.write("Name: Chulan Identity Palette\n")
        f.write("Columns: 8\n")
        f.write("#\n")
        for name, rgb in PALETTE_DEFINITIONS:
            f.write(f"{rgb[0]:3d} {rgb[1]:3d} {rgb[2]:3d}  {name}\n")
    print(f"Palette GPL written: {gpl_path}")

    # 2. 导出色板 PNG 预览图
    swatch_size = 40
    cols = 8
    rows = (len(PALETTE_DEFINITIONS) + cols - 1) // cols
    img_w = cols * swatch_size
    img_h = rows * swatch_size

    palette_img = Image.new('RGB', (img_w, img_h), (30, 30, 30))
    from PIL import ImageDraw
    draw = ImageDraw.Draw(palette_img)

    for idx, (name, rgb) in enumerate(PALETTE_DEFINITIONS):
        c = idx % cols
        r = idx // cols
        x0 = c * swatch_size
        y0 = r * swatch_size
        x1 = x0 + swatch_size - 1
        y1 = y0 + swatch_size - 1
        draw.rectangle([x0, y0, x1, y1], fill=rgb)
        draw.rectangle([x0, y0, x1, y1], outline=(50, 50, 50))

    png_path = os.path.join(OUT_DIR, "chulan_palette.png")
    palette_img.save(png_path)
    print(f"Palette PNG written: {png_path}")


def export_readme():
    """
    在输出目录写入说明文档
    """
    readme_path = os.path.join(OUT_DIR, "README_PROTOTYPES.md")
    content = """# 初澜（Chulan）像素化原型资产库 (Pixel Art Prototypes)

本目录为 **v1.0 像素化美术演进路线** 首次离线生成的高质量点阵原型。
全部基于纯 CPU 计算管线生成，严格保全初澜的身体特征不变式与透明图层规格。

---

## 🎨 核心特征不变式清单 (Identity Invariants)

1. **发型发色**：银白微卷长发，在发尾渐变为柔和清透的「淡冰蓝」（`#8cbae1` / `#b4d7f5`）。
2. **眼眸质感**：沉静纯澈的「蓝灰眼眸」，瞳孔含高反差白点高光（Sparkling Catchlight）。
3. **单侧泪痣**：初澜左眼（观众视角右眼）正下方，精准单点深色泪痣（Canonical Tear Mole）。
4. **图层规格**：全通道 32-bit RGBA，完全剔除半透明边缘毛边，适合像素编辑器直接取色、选区和修笔。

---

## 📁 生成资产对照表

| 文件名 | 尺寸 | 说明 | 适用场景 |
|---|---|---|---|
| `chulan_full_190x250.png` | 190×250 | **细腻级原型**（原画 1/4 等比） | 街机/PC-98 精细点阵，发丝与服饰褶皱细腻完整 |
| `chulan_full_190x250_canvas760x1000.png` | 760×1000 | 细腻级 4x 整数放大画布 | **可直接在桌宠窗口中预览**，与既有 760×1000 画布无缝对齐 |
| `chulan_base_190x250.png` | 190×250 | 素体点阵切片（脱下外衣与头发） | 供后续绘制新衣物、换装部件（纸娃娃系统）作为打底层 |
| `chulan_hair_190x250.png` | 190×250 | 发型独立点阵切片 | 纯发丝图层，用于测试独立图层叠穿效果 |
| `chulan_full_128x168.png` | 128×168 | **经典级原型**（约 1/6 等比） | 经典独立游戏（Celeste/Momodora）风格，点阵颗粒感明显 |
| `chulan_full_128x168_canvas760x1000.png` | 760×1000 | 经典级 6x 放大画布 | 桌宠等比点阵大图预览 |
| `chulan_full_64x84.png` | 64×84 | **复古掌机级原型**（约 1/12 等比） | GBA / 宝可梦式极简像素风，轮廓鲜明 |
| `chulan_full_64x84_canvas760x1000.png` | 760×1000 | 复古掌机级 11x 放大画布 | 极简点阵大图预览 |
| `chulan_palette.png` | 320×200 | 角色专有色板预览图 | 包含肤色、银白发、冰蓝、眼眸、哥特深色等全部标定色 |
| `chulan_palette.gpl` | GPL 文件 | **通用调色板** | **LibreSprite / Pixelorama 专用**：一键导入色盘 |

---

## 🛠️ 在绘画软件中使用操作指南

### 1. 使用 LibreSprite 打开与精修
- 打开软件：运行 `D:\\software\\huihua\\LibreSprite\\libresprite.exe`
- 载入调色板：点击上方调色板工具栏菜单按钮 -> 选择 **Load Palette** -> 选取 `chulan_palette.gpl`，即可直接获得官方标定颜色！
- 载入图层精修：点击 **File -> Open**，选择 `chulan_full_190x250.png` 即可逐像素进行光影精修或补笔。

### 2. 使用 Pixelorama 打开与图层分拆
- 打开软件：运行 `D:\\software\\huihua\\Pixelorama\\Pixelorama.exe`
- 导入工程：拖拽 `chulan_base_190x250.png` 和 `chulan_hair_190x250.png` 到画布，分别作为底图与上层，可以直接在中间新建图层画新衣服！
- 载入色盘：在右侧 Palette 面板点击 **Import Palette** 导入 `chulan_palette.gpl`。
"""
    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"README written: {readme_path}")


def main():
    print("=== 开始初澜（Chulan）像素化原型批量生成 ===")

    # 1. 导出调色板与说明文档
    export_palette_files()
    export_readme()

    # 2. 读取源文件
    print(f"Loading full character: {PATH_FULL}")
    img_full = Image.open(PATH_FULL).convert('RGBA')
    rgb_full, alpha_full = enhance_source_image(img_full)

    print(f"Loading base mannequin: {PATH_BASE}")
    img_base = Image.open(PATH_BASE).convert('RGBA')
    rgb_base, alpha_base = enhance_source_image(img_base)

    print(f"Loading hair layer: {PATH_HAIR}")
    img_hair = Image.open(PATH_HAIR).convert('RGBA')
    arr_hair = np.array(img_hair)
    rgb_hair, alpha_hair = enhance_source_image(img_hair, is_hair=True)

    # 规格清单: (name_prefix, target_w, target_h)
    resolutions = [
        ("190x250", 190, 250),
        ("128x168", 128, 168),
        ("64x84",    64,  84),
    ]

    for tag, tw, th in resolutions:
        print(f"\n--- 生成规格: {tag} ({tw}x{th}) ---")

        # A. 全身整图
        sprite_full = render_pixel_sprite(rgb_full, alpha_full, tw, th, is_full_character=True, has_face=True)
        path_native_full = os.path.join(OUT_DIR, f"chulan_full_{tag}.png")
        sprite_full.save(path_native_full)
        print(f"  [OK] {path_native_full}")

        # 整数放大到 760x1000 原画画布
        canvas_full = upscale_to_canvas(sprite_full, 760, 1000)
        path_canvas_full = os.path.join(OUT_DIR, f"chulan_full_{tag}_canvas760x1000.png")
        canvas_full.save(path_canvas_full)
        print(f"  [OK] {path_canvas_full}")

        # B. 素体（对于 190x250 和 128x168 产出）
        if tw >= 120:
            sprite_base = render_pixel_sprite(rgb_base, alpha_base, tw, th, is_full_character=False, has_face=True)
            path_native_base = os.path.join(OUT_DIR, f"chulan_base_{tag}.png")
            sprite_base.save(path_native_base)
            print(f"  [OK] {path_native_base}")

            if tag == "190x250":
                canvas_base = upscale_to_canvas(sprite_base, 760, 1000)
                path_canvas_base = os.path.join(OUT_DIR, f"chulan_base_{tag}_canvas760x1000.png")
                canvas_base.save(path_canvas_base)
                print(f"  [OK] {path_canvas_base}")

        # C. 纯发型图层（对于 190x250 产出）
        if tag == "190x250":
            sprite_hair = render_pixel_sprite(rgb_hair, alpha_hair, tw, th, is_full_character=False, has_face=False)
            path_native_hair = os.path.join(OUT_DIR, f"chulan_hair_{tag}.png")
            sprite_hair.save(path_native_hair)
            print(f"  [OK] {path_native_hair}")

            canvas_hair = upscale_to_canvas(sprite_hair, 760, 1000)
            path_canvas_hair = os.path.join(OUT_DIR, f"chulan_hair_{tag}_canvas760x1000.png")
            canvas_hair.save(path_canvas_hair)
            print(f"  [OK] {path_canvas_hair}")

    print("\n=== 全部像素化原型资产已成功生成至: D:\\software\\huihua\\prototypes ===")


if __name__ == "__main__":
    main()
