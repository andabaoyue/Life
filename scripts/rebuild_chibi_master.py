# -*- coding: utf-8 -*-
"""
初澜 Q 版点阵资产全面重构生成脚本 (Rebuild Chibi Master)
根据独立主审 WorkBuddy 验收报告 (V1.0-CHIBI-PIXEL-ACCEPTANCE-AUDIT.md) 与用户需求：
1. 采用真实分层母本 (chulan_doll_stack_*) 构建真正具有脱衣/换装效果的素体与服饰切片；
2. 钉死正典泪痣 (36, 39)=#40303A 与双高光 (25, 34)、(36, 34)=#FFFFFF；
3. 发片完全镂空面部 (x 22..41, y 32..42)，杜绝遮挡五官与泪痣；
4. 构建平滑连贯 4 帧迈步 (walk_0..3) 与 待机微呼吸 (idle_0..3)；
5. 将 casual / gothic / sneakers / choker 等旧切片全部重制为原生 64x80 1-bit alpha 像素规格。
"""
import math
import os
from PIL import Image
import numpy as np

PROTO_DIR = r"D:\software\huihua\prototypes"
LIFE_DIR = r"d:\GAME\LIFE"
CHAR_DIR = os.path.join(LIFE_DIR, "assets", "character")

CANVAS_W, CANVAS_H = 64, 80
scale = 68.0 / 700.0
tw = round(374 * scale)
th = round(728 * scale)
foot_y_in_small = round(716 * scale)
dst_x = (64 - tw) // 2
dst_y = 78 - foot_y_in_small

def downscale_layer(src_im, alpha_thresh=35):
    small = src_im.resize((tw, th), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    canvas.paste(small, (dst_x, dst_y), small)
    arr = canvas.load()
    for y in range(CANVAS_H):
        for x in range(CANVAS_W):
            p = arr[x, y]
            if p[3] < alpha_thresh:
                arr[x, y] = (0, 0, 0, 0)
            else:
                arr[x, y] = (p[0], p[1], p[2], 255)
    return canvas

def main():
    print("=== 1. 构建真实无衣素体 (base_pixel_chibi.png) ===")
    body_raw = Image.open(os.path.join(PROTO_DIR, "chulan_doll_stack_02_body.png")).convert("RGBA")
    body_im = downscale_layer(body_raw)
    barr = body_im.load()
    
    # 正典泪痣 (36, 39) = #40303A
    MOLE_COLOR = (64, 48, 58, 255)
    barr[36, 39] = MOLE_COLOR
    
    # 眼眸双高光 (Sparkling Catchlights)
    barr[25, 34] = (255, 255, 255, 255)
    barr[36, 34] = (255, 255, 255, 255)
    
    base_p = os.path.join(CHAR_DIR, "base", "base_pixel_chibi.png")
    os.makedirs(os.path.dirname(base_p), exist_ok=True)
    body_im.save(base_p)
    print(f"  -> Saved base {base_p}")

    print("=== 2. 构建真实发型切片 (silver_wavy_01.png) 并面部100%镂空 ===")
    h_back_raw = Image.open(os.path.join(PROTO_DIR, "chulan_doll_stack_01_hair_back.png")).convert("RGBA")
    h_front_raw = Image.open(os.path.join(PROTO_DIR, "chulan_doll_stack_08_hair_front.png")).convert("RGBA")
    h_back = downscale_layer(h_back_raw)
    h_front = downscale_layer(h_front_raw)
    
    # 合成发型，但强制将面部眼颊区域 (x: 22..41, y: 32..42) 100% 镂空
    hair_im = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    hair_im.alpha_composite(h_back)
    hair_im.alpha_composite(h_front)
    harr = hair_im.load()
    for y in range(32, 43):
        for x in range(22, 42):
            harr[x, y] = (0, 0, 0, 0)
            
    # 发尾冰蓝阶跳增强 (y 50..65)
    # #A5C2E6, #6EA5E1, #4178B4
    for y in range(50, 65):
        for x in range(CANVAS_W):
            if harr[x, y][3] > 0 and harr[x, y][0] > 160 and harr[x, y][2] > 180:
                if y > 58:
                    harr[x, y] = (65, 120, 180, 255) # 冰蓝深阶
                elif y > 54:
                    harr[x, y] = (110, 165, 225, 255) # 冰蓝中阶
                else:
                    harr[x, y] = (165, 194, 230, 255) # 冰蓝浅阶
                    
    hair_p = os.path.join(CHAR_DIR, "hair", "silver_wavy_01.png")
    os.makedirs(os.path.dirname(hair_p), exist_ok=True)
    hair_im.save(hair_p)
    print(f"  -> Saved hair {hair_p}")

    print("=== 3. 构建默认服饰真实切片 ===")
    # 1) 发饰 black_bow_01
    bow_raw = Image.open(os.path.join(PROTO_DIR, "chulan_doll_stack_09_bow.png")).convert("RGBA")
    bow_im = downscale_layer(bow_raw)
    bow_p = os.path.join(CHAR_DIR, "hair-accessories", "black_bow_01.png")
    os.makedirs(os.path.dirname(bow_p), exist_ok=True)
    bow_im.save(bow_p)
    print(f"  -> Saved bow {bow_p}")

    # 2) 上装 lace_corset_01
    top_raw = Image.open(os.path.join(PROTO_DIR, "chulan_doll_stack_05_top.png")).convert("RGBA")
    top_im = downscale_layer(top_raw)
    top_arr = top_im.load()
    base_arr = body_im.load()
    # P2 修复：严格以素体轮廓为边界裁切，根除 4px 外溢缝
    for y in range(CANVAS_H):
        for x in range(CANVAS_W):
            if base_arr[x, y][3] == 0:
                top_arr[x, y] = (0, 0, 0, 0)
    top_p = os.path.join(CHAR_DIR, "tops", "lace_corset_01.png")
    os.makedirs(os.path.dirname(top_p), exist_ok=True)
    top_im.save(top_p)
    print(f"  -> Saved top {top_p}")

    # 3) 下装 black_shorts_01
    bot_raw = Image.open(os.path.join(PROTO_DIR, "chulan_doll_stack_06_shorts.png")).convert("RGBA")
    bot_im = downscale_layer(bot_raw)
    bot_p = os.path.join(CHAR_DIR, "bottoms", "black_shorts_01.png")
    os.makedirs(os.path.dirname(bot_p), exist_ok=True)
    bot_im.save(bot_p)
    print(f"  -> Saved bottom {bot_p}")

    # 4) 外套 white_tech_jacket_01
    cape_raw = Image.open(os.path.join(PROTO_DIR, "chulan_doll_stack_07_cape.png")).convert("RGBA")
    cape_im = downscale_layer(cape_raw)
    cape_p = os.path.join(CHAR_DIR, "outerwear", "white_tech_jacket_01.png")
    os.makedirs(os.path.dirname(cape_p), exist_ok=True)
    cape_im.save(cape_p)
    print(f"  -> Saved outerwear {cape_p}")

    # 5) 袜子 white_thighhigh_01
    sock_raw = Image.open(os.path.join(PROTO_DIR, "chulan_doll_stack_03_socks.png")).convert("RGBA")
    sock_im = downscale_layer(sock_raw)
    sock_p = os.path.join(CHAR_DIR, "socks", "white_thighhigh_01.png")
    os.makedirs(os.path.dirname(sock_p), exist_ok=True)
    sock_im.save(sock_p)
    print(f"  -> Saved socks {sock_p}")

    # 6) 靴子 black_boots_01
    boot_raw = Image.open(os.path.join(PROTO_DIR, "chulan_doll_stack_04_boots.png")).convert("RGBA")
    boot_im = downscale_layer(boot_raw)
    boot_p = os.path.join(CHAR_DIR, "shoes", "black_boots_01.png")
    os.makedirs(os.path.dirname(boot_p), exist_ok=True)
    boot_im.save(boot_p)
    print(f"  -> Saved shoes {boot_p}")

    print("=== 4. 重制 casual / gothic 像素切片 (P1-E: 丰富明暗褶皱与高光质感) ===")
    # 1) gray_tee_01 (宽松灰T恤，含领口罗纹、高光、自然布料折痕与阴影)
    tee_im = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    tarr = tee_im.load()
    for y in range(43, 56):
        for x in range(21, 43):
            if top_arr[x, y][3] > 0 or (23 <= x <= 41 and 45 <= y <= 54):
                col = (145, 150, 160, 255)
                if y == 43 and 28 <= x <= 36:
                    col = (185, 190, 200, 255)
                elif y == 44 and 29 <= x <= 35:
                    col = (115, 120, 130, 255)
                elif 45 <= y <= 47 and 27 <= x <= 37:
                    col = (168, 173, 182, 255)
                elif x in (21, 22, 41, 42) or y == 55:
                    col = (105, 110, 120, 255)
                elif (x + y) % 5 == 0 and 48 <= y <= 54:
                    col = (120, 125, 135, 255)
                tarr[x, y] = col
    tee_p = os.path.join(CHAR_DIR, "tops", "gray_tee_01.png")
    tee_im.save(tee_p)
    print(f"  -> Saved gray_tee {tee_p}")

    # 2) sport_shorts_01 (深灰运动短裤，含弹力腰头、侧边运动双白条纹与立体裤褶)
    ss_im = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    sarr = ss_im.load()
    bot_arr = bot_im.load()
    for y in range(53, 63):
        for x in range(21, 43):
            if bot_arr[x, y][3] > 0 or (23 <= x <= 41 and 54 <= y <= 60):
                col = (72, 76, 85, 255)
                if y == 53:
                    col = (100, 105, 115, 255)
                elif (x in (21, 42) and 54 <= y <= 61) or (x in (22, 41) and 55 <= y <= 60):
                    col = (235, 240, 248, 255)
                elif x in (31, 32) and y >= 57:
                    col = (42, 45, 52, 255)
                elif y == 62:
                    col = (52, 55, 62, 255)
                sarr[x, y] = col
    ss_p = os.path.join(CHAR_DIR, "bottoms", "sport_shorts_01.png")
    ss_im.save(ss_p)
    print(f"  -> Saved sport_shorts {ss_p}")

    # 3) gothic_black_01 (哥特黑连衣裙，含蕾丝方领、竖向鱼骨骨架提亮、百褶裙摆与花边)
    goth_im = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    garr = goth_im.load()
    for y in range(43, 66):
        for x in range(20, 44):
            if top_arr[x, min(53, y)][3] > 0 or bot_arr[x, min(61, y)][3] > 0 or (y >= 58 and 21 <= x <= 43):
                col = (28, 26, 33, 255)
                if y == 43 and 27 <= x <= 37:
                    col = (190, 195, 205, 255) if (x % 2 == 0) else (130, 135, 145, 255)
                elif 44 <= y <= 52 and x in (26, 31, 32, 37):
                    col = (52, 48, 62, 255)
                elif y == 52:
                    col = (18, 16, 22, 255)
                elif y >= 53:
                    if x % 3 == 0:
                        col = (44, 40, 52, 255)
                    elif x % 3 == 1:
                        col = (20, 18, 25, 255)
                    else:
                        col = (32, 29, 38, 255)
                    if y == 65 and (x % 2 == 0):
                        col = (68, 62, 80, 255)
                garr[x, y] = col
    goth_p = os.path.join(CHAR_DIR, "dresses", "gothic_black_01.png")
    os.makedirs(os.path.dirname(goth_p), exist_ok=True)
    goth_im.save(goth_p)
    print(f"  -> Saved gothic_black {goth_p}")

    # 4) white_sneakers_01 (白色运动鞋，含鞋面鞋带反光、立体灰调与大底耐磨黑边)
    snk_im = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    snk_arr = snk_im.load()
    boot_arr = boot_im.load()
    for y in range(71, 79):
        for x in range(22, 44):
            if boot_arr[x, y][3] > 0:
                col = (245, 248, 252, 255)
                if y in (72, 74) and (24 <= x <= 27 or 37 <= x <= 40):
                    col = (255, 255, 255, 255)
                elif (x in (22, 28, 36, 43) and y <= 76):
                    col = (195, 202, 212, 255)
                elif y == 77:
                    col = (140, 146, 158, 255)
                elif y == 78:
                    col = (48, 50, 56, 255)
                snk_arr[x, y] = col
    snk_p = os.path.join(CHAR_DIR, "shoes", "white_sneakers_01.png")
    snk_im.save(snk_p)
    print(f"  -> Saved white_sneakers {snk_p}")

    # 5) choker_key_01 (颈带钥匙项圈，双层丝绒带 + 精细金色吊坠钥匙)
    choker_im = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    charr = choker_im.load()
    for x in range(28, 38):
        charr[x, 40] = (50, 45, 55, 255)
        charr[x, 41] = (26, 22, 30, 255)
    charr[32, 42] = (255, 230, 140, 255)
    charr[33, 42] = (220, 185, 95, 255)
    charr[32, 43] = (240, 200, 100, 255)
    charr[33, 43] = (195, 160, 70, 255)
    charr[32, 44] = (210, 175, 80, 255)
    charr[33, 44] = (160, 130, 55, 255)
    charr[32, 45] = (225, 190, 90, 255)
    charr[33, 45] = (140, 110, 45, 255)
    choker_p = os.path.join(CHAR_DIR, "accessories", "choker_key_01.png")
    os.makedirs(os.path.dirname(choker_p), exist_ok=True)
    choker_im.save(choker_p)
    print(f"  -> Saved choker_key {choker_p}")

    print("=== 5. 构建走动序列：整装帧 (walk) 与 素体基座帧 (walk_base，P0-A 解耦) ===")
    SRC_DRESSED = os.path.join(PROTO_DIR, "chulan_doll_dressed_374x728_alpha.png")
    src_dressed = Image.open(SRC_DRESSED).convert("RGBA")
    sa_dressed = np.asarray(src_dressed).astype(np.uint8).copy()

    SRC_BODY = os.path.join(PROTO_DIR, "chulan_doll_stack_02_body.png")
    src_body = Image.open(SRC_BODY).convert("RGBA")
    sa_body = np.asarray(src_body).astype(np.uint8).copy()

    LEG_BOX = {"L": (88, 576, 187, 728), "R": (187, 576, 286, 728)}
    TORSO_CUT_Y = 612
    PIVOT = {"L": (149.0 - 88, 566.0 - 576), "R": (224.0 - 187, 566.0 - 576)}

    def rotate_about(img, pivot, deg):
        if abs(deg) < 1e-6: return img
        w, h = img.size
        pad = max(w, h) + 8
        BW, BH = w + 2 * pad, h + 2 * pad
        big = Image.new("RGBA", (BW, BH), (0, 0, 0, 0))
        big.paste(img, (pad, pad))
        cx, cy = BW / 2.0, BH / 2.0
        ox, oy = round(cx - (pivot[0] + pad)), round(cy - (pivot[1] + pad))
        moved = Image.new("RGBA", big.size, (0, 0, 0, 0))
        moved.paste(big, (ox, oy))
        rot = moved.rotate(deg, resample=Image.NEAREST, center=(cx, cy))
        back = Image.new("RGBA", big.size, (0, 0, 0, 0))
        back.paste(rot, (-ox, -oy))
        return back.crop((pad, pad, pad + w, pad + h))

    def make_walk_cycle(source_img, sa_arr, out_subfolder, prefix):
        torso_a = sa_arr.copy()
        for _, (x0, _y0, x1, y1) in LEG_BOX.items():
            torso_a[TORSO_CUT_Y:y1, x0:x1] = (0, 0, 0, 0)
        torso = Image.fromarray(torso_a, "RGBA")
        legs = {k: source_img.crop(box) for k, box in LEG_BOX.items()}
        frames = []
        N_WALK = 4
        for i in range(N_WALK):
            p = 2 * math.pi * i / N_WALK
            cos_p, sin_p = math.cos(p), math.sin(p)
            thL, thR = 5.0 * cos_p, -5.0 * cos_p
            liftL = 9 * max(0.0, -sin_p)
            liftR = 9 * max(0.0, sin_p)
            frame = Image.new("RGBA", (374, 728), (0, 0, 0, 0))
            frame.alpha_composite(torso, (0, 0))
            for side, ang, lift in (("L", thL, liftL), ("R", thR, liftR)):
                x0, y0, _, _ = LEG_BOX[side]
                piece = rotate_about(legs[side], PIVOT[side], ang)
                frame.alpha_composite(piece, (x0, y0 + round(lift)))
            wf = downscale_layer(frame)
            warr = wf.load()
            warr[36, 39] = MOLE_COLOR
            warr[25, 34] = (255, 255, 255, 255)
            warr[36, 34] = (255, 255, 255, 255)
            out_p = os.path.join(CHAR_DIR, "anim", out_subfolder, f"{prefix}_{i}.png")
            os.makedirs(os.path.dirname(out_p), exist_ok=True)
            wf.save(out_p)
            frames.append(wf)
            print(f"  -> Saved {out_p}")
        return frames

    walk_frames = make_walk_cycle(src_dressed, sa_dressed, "walk", "walk")
    walk_base_frames = make_walk_cycle(src_body, sa_body, "walk_base", "walk_base")

    print("=== 6. 构建待机序列：整装帧 (idle) 与 素体基座帧 (idle_base，P0-B 微呼吸) ===")
    stand_base = walk_frames[0].copy()
    stand_p = os.path.join(CHAR_DIR, "stand", "chulan_chibi_stand_64x80.png")
    stand_base.save(stand_p)
    print(f"  -> Saved stand {stand_p}")

    def make_idle_cycle(base_img, out_subfolder, prefix):
        out_dir = os.path.join(CHAR_DIR, "anim", out_subfolder)
        os.makedirs(out_dir, exist_ok=True)
        # idle_0: 基准站姿
        f0 = base_img.copy()
        f0.save(os.path.join(out_dir, f"{prefix}_0.png"))

        # idle_1: 同源微呼吸 (P0-B 修复：呆毛微摆 + 胸腔微抬 1px，全图差异严格 <2%)
        f1 = base_img.copy()
        f1_arr = f1.load()
        s_arr = base_img.load()
        # 呆毛尖微摆 (y: 10..12, x: 28..33)
        for y in range(10, 13):
            for x in range(28, 33):
                if s_arr[x, y][3] > 0:
                    f1_arr[x + 1, y] = s_arr[x, y]
                    if s_arr[x - 1, y][3] == 0:
                        f1_arr[x, y] = (0, 0, 0, 0)
        # 胸腔核心微抬 1px (y: 45..47, x: 29..36)
        for y in range(45, 48):
            for x in range(29, 36):
                if s_arr[x, y][3] > 0:
                    f1_arr[x, y - 1] = s_arr[x, y]
        f1.save(os.path.join(out_dir, f"{prefix}_1.png"))

        # idle_2: 呼气复位
        f2 = base_img.copy()
        f2.save(os.path.join(out_dir, f"{prefix}_2.png"))

        # idle_3: 眨眼微笑 (仅睫毛与眼睑闭合线，泪痣保持不动，差异严格 <2%)
        f3 = base_img.copy()
        f3_arr = f3.load()
        for x in range(24, 29):
            f3_arr[x, 34] = (255, 230, 220, 255)
            f3_arr[x, 35] = (60, 50, 60, 255)
        for x in range(35, 40):
            f3_arr[x, 34] = (255, 230, 220, 255)
            f3_arr[x, 35] = (60, 50, 60, 255)
        f3_arr[36, 39] = MOLE_COLOR
        f3.save(os.path.join(out_dir, f"{prefix}_3.png"))
        print(f"  -> Saved {out_subfolder} 0..3 frames")

    make_idle_cycle(stand_base, "idle", "idle")
    make_idle_cycle(body_im, "idle_base", "idle_base")

    print("=== 全量正典点阵切片与动作帧重构成功！===")

if __name__ == "__main__":
    main()
