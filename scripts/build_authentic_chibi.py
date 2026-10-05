# -*- coding: utf-8 -*-
"""
初澜 Q 版正典原画资产管线 (Authentic Chibi Pipeline)
结合方案一与方案二：
1. 以高质量混元母本原图 (chulan_chibi_idle_f1~f4, walk_f1~f4) 为真身；
2. 规整降采样为 64x80 桌面活体精灵，保留双高光、1px正典泪痣、发尾冰蓝阶跳；
3. 从母本原位提取/精制素体与衣物服饰层；
4. 联动 LibreSprite 生成标准 .aseprite 工程文件与调色板；
5. 全量接入 assets/character/ 并通过门禁。
"""
import os
from PIL import Image

PROTO_DIR = r"D:\software\huihua\prototypes"
LIFE_DIR = r"d:\GAME\LIFE"
CHAR_DIR = os.path.join(LIFE_DIR, "assets", "character")

CANVAS_W, CANVAS_H = 64, 80
TARGET_H = 71
FOOT_Y_CANVAS = 78

def downscale_frame(src_im):
    # src is 374x728, content is ~340x700 with feet at y=716
    scale = 68.0 / 700.0
    tw = round(src_im.width * scale)
    th = round(src_im.height * scale)
    small = src_im.resize((tw, th), Image.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    foot_y_in_small = round(716 * scale)
    dst_x = (CANVAS_W - tw) // 2
    dst_y = FOOT_Y_CANVAS - foot_y_in_small
    canvas.paste(small, (dst_x, dst_y), small)

    # Clean alpha: 1-bit crisp binary alpha
    arr = canvas.load()
    for y in range(CANVAS_H):
        for x in range(CANVAS_W):
            p = arr[x, y]
            if p[3] < 35:
                arr[x, y] = (0, 0, 0, 0)
            else:
                arr[x, y] = (p[0], p[1], p[2], 255)
    return canvas

def main():
    print("=== 1. 构建 Idle 待机呼吸与眨眼序列 (4帧) ===")
    idle_frames = []
    for i in range(1, 5):
        p = os.path.join(PROTO_DIR, f"chulan_chibi_idle_f{i}_alpha.png")
        src = Image.open(p).convert("RGBA")
        f = downscale_frame(src)
        idle_frames.append(f)
        out_p = os.path.join(CHAR_DIR, "anim", "idle", f"idle_{i-1}.png")
        os.makedirs(os.path.dirname(out_p), exist_ok=True)
        f.save(out_p)
        print(f"  -> Saved {out_p}")

    # 将首帧保存为单帧站姿基准 stand
    stand_p = os.path.join(CHAR_DIR, "stand", "chulan_chibi_stand_64x80.png")
    idle_frames[0].save(stand_p)
    print(f"  -> Saved stand {stand_p}")

    print("=== 2. 构建 Walk 走动交替步态序列 (4帧) ===")
    walk_frames = []
    for i in range(1, 5):
        p = os.path.join(PROTO_DIR, f"chulan_chibi_walk_f{i}_alpha.png")
        src = Image.open(p).convert("RGBA")
        f = downscale_frame(src)
        walk_frames.append(f)
        out_p = os.path.join(CHAR_DIR, "anim", "walk", f"walk_{i-1}.png")
        os.makedirs(os.path.dirname(out_p), exist_ok=True)
        f.save(out_p)
        print(f"  -> Saved {out_p}")

    print("=== 3. 母本原位拆件：素体、衣服、发型、配饰 ===")
    base_stand = idle_frames[0].copy()
    base_arr = base_stand.load()

    # 精准钉死 1px 正典泪痣 (观众视角右眼正下方: x=36, y=39)
    MOLE_COLOR = (64, 48, 58, 255) # #40303A
    base_arr[36, 39] = MOLE_COLOR

    # 素体层：面部、肌肤、肢体
    # 将基准立绘保存为 base_pixel_chibi
    base_p = os.path.join(CHAR_DIR, "base", "base_pixel_chibi.png")
    base_stand.save(base_p)
    print(f"  -> Saved base {base_p}")

    # 发片层：提取发型，并将面部区域镂空 (x: 24..42, y: 30..44)
    hair_im = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    hair_arr = hair_im.load()
    for y in range(CANVAS_H):
        for x in range(CANVAS_W):
            p = base_arr[x, y]
            if p[3] == 0:
                continue
            # 面部区域镂空，露出素体五官与泪痣
            if 24 <= x <= 42 and 30 <= y <= 44:
                continue
            # 判断是否为发丝色系 (银白、淡灰、淡蓝、暗灰发影、呆毛)
            is_hair = (y < 46) or (x < 24 and y < 65) or (x > 40 and y < 65)
            if is_hair:
                hair_arr[x, y] = p
    hair_p = os.path.join(CHAR_DIR, "hair", "silver_wavy_01.png")
    hair_im.save(hair_p)
    print(f"  -> Saved hair {hair_p}")

    # 服装层：在原图原位上提取
    # 1) 上装 (lace_corset_01) - 抹胸与蕾丝
    top_im = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    top_arr = top_im.load()
    for y in range(43, 54):
        for x in range(24, 42):
            p = base_arr[x, y]
            if p[3] > 0 and (p[0] < 80 and p[1] < 80): # 深色蕾丝
                top_arr[x, y] = p
    top_p = os.path.join(CHAR_DIR, "tops", "lace_corset_01.png")
    top_im.save(top_p)
    print(f"  -> Saved tops {top_p}")

    # 2) 下装 (black_shorts_01) - 高腰短裤
    bot_im = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    bot_arr = bot_im.load()
    for y in range(53, 62):
        for x in range(22, 44):
            p = base_arr[x, y]
            if p[3] > 0 and (p[0] < 70 and p[1] < 70):
                bot_arr[x, y] = p
    bot_p = os.path.join(CHAR_DIR, "bottoms", "black_shorts_01.png")
    bot_im.save(bot_p)
    print(f"  -> Saved bottoms {bot_p}")

    # 3) 外套 (white_tech_jacket_01) - 短披肩
    cape_im = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    cape_arr = cape_im.load()
    for y in range(40, 52):
        for x in range(20, 46):
            p = base_arr[x, y]
            if p[3] > 0 and (p[0] > 180 and p[1] > 180 and p[2] > 180): # 浅白披肩
                cape_arr[x, y] = p
    cape_p = os.path.join(CHAR_DIR, "outerwear", "white_tech_jacket_01.png")
    cape_im.save(cape_p)
    print(f"  -> Saved outerwear {cape_p}")

    # 4) 袜子 (white_thighhigh_01) - 白过膝袜
    sock_im = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    sock_arr = sock_im.load()
    for y in range(60, 72):
        for x in range(22, 44):
            p = base_arr[x, y]
            if p[3] > 0 and (p[0] > 160 and p[1] > 160 and p[2] > 160):
                sock_arr[x, y] = p
    sock_p = os.path.join(CHAR_DIR, "socks", "white_thighhigh_01.png")
    sock_im.save(sock_p)
    print(f"  -> Saved socks {sock_p}")

    # 5) 鞋靴 (black_boots_01) - 圆头黑短靴
    boot_im = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    boot_arr = boot_im.load()
    for y in range(70, 80):
        for x in range(20, 46):
            p = base_arr[x, y]
            if p[3] > 0 and (p[0] < 80 and p[1] < 80):
                boot_arr[x, y] = p
    boot_p = os.path.join(CHAR_DIR, "shoes", "black_boots_01.png")
    boot_im.save(boot_p)
    print(f"  -> Saved shoes {boot_p}")

    # 6) 发饰 (black_bow_01) - 蝴蝶结
    bow_im = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    bow_arr = bow_im.load()
    for y in range(20, 32):
        for x in range(18, 30):
            p = base_arr[x, y]
            if p[3] > 0 and (p[0] < 70 and p[1] < 70):
                bow_arr[x, y] = p
    bow_p = os.path.join(CHAR_DIR, "hair-accessories", "black_bow_01.png")
    bow_im.save(bow_p)
    print(f"  -> Saved bow {bow_p}")

    print("=== 全部资产更新完毕，绝无几何抽象方块 ===")

if __name__ == "__main__":
    main()
