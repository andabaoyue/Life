# 初澜桌宠立绘与分层换装资产生成规范（Layered Sprite Stacking Guide）

## 1. 核心定位：分层立绘叠放架构（Layered Sprite Stacking）

本规范用于指导初澜桌宠所有视觉图层的绘制与 AI 图像生成。程序采用 **760×1000 px 统一画布、透明 RGBA 32-bit PNG、固定全局锚点、分层立绘叠放（Layered Sprite Stacking）** 的渲染方案。

只要每一张素材严格遵循本规范：
- 渲染引擎无需单独针对单件素材调节 CSS offset、缩放或对齐位置；
- 新增服饰只需按目录放入并在 `src/wardrobe.js` 中登记；
- 各部件可以像专业 2D 换装游戏一样在同一身体基准上严密叠放，不产生穿模、双重肢体或面部漂移。

---

## 2. 核心原则：“完整角色生成”与“独立资产生成”的严格区别

在向 AI 绘图模型（如 Stable Diffusion、Midjourney、DALL-E 等）输入 Prompt 时，必须深刻认识到以下区别：

$$\mathbf{完整角色图\ Prompt \neq 独立分层资产\ Prompt}$$

- **完整角色图（Character Master Reference）**：用于确定画风基准、色彩体系、脸型、瞳色、发质、泪痣位置及初始人体比例。**仅用于视觉参照，禁止直接裁切或作为独立衣物图层！**
- **独立分层资产（Independent Layer Component）**：用于程序运行期叠放的独立身体、服装、发型或饰品图层。**严禁生成完整人体，必须仅生成该部件本身，其内部或背景完全中空透明！**

未来任何新增资产，必须先按以下矩阵确立工程属性，方可编写生成 Prompt：

$$\text{Asset Type} \longrightarrow \text{Slot} \longrightarrow \text{Layer Position} \longrightarrow \text{Anchor} \longrightarrow \text{Z-index} \longrightarrow \text{Negative Constraints} \longrightarrow \text{Prompt}$$

---

## 3. Schema 1：角色母本与身体核心（Body Base Prompt 规范）

### 3.1 Body Base 的职责
Body Base（基础身体层，如 `assets/character/base/base.png` 或 `body.png`）是数字生命的**稳定身份核心**：
- 它提供了稳定的骨骼高度、头身比、肩膀宽度、腰臀轮廓与站立基准线；
- **绝对不随换装、发型变化而发生任何比例漂移或锚点偏移**；
- 必须为无服装、无鞋、不带独立可拆卸发型的干净素体；
- 预留中性基础五官与脸型，供后续表情差分系统叠加。

### 3.2 技术规格
- **画布尺寸**：760×1000 px
- **色彩模式**：RGBA 32-bit（真正透明背景，Alpha=0）
- **姿态**：正面完全水平对称站立（front view, neutral standing pose），两臂自然垂下与躯干微分离，双脚平稳踏在固定水平基准线上，无任何动态透视倾斜。
- **构图**：全局居中（centered），头顶及左右保留充足呼吸余量（约占画布高度 75%~80%）。

### 3.3 Body Base 正向 Prompt 模板
```text
masterpiece, best quality, ultra-detailed, anime cel-shading, 1girl, chulan,
pale fair skin, slender graceful adult female proportions,
neutral standing pose, perfectly facing front, looking directly at viewer,
light blue-gray eyes, calm, curious and intelligent neutral expression, closed mouth,
single subtle beauty mark under left eye, fixed delicate face shape,
bald head OR skin-tight pale neutral hair cap, no loose hair,
completely bare body, naked base model, bare shoulders, bare arms, bare legs, bare feet,
arms slightly separated from torso, feet firmly standing on horizontal baseline,
clean lineart, consistent anime game sprite asset,
pure transparent background, 760x1000 canvas, centered composition.
```

### 3.4 Body Base 负向 Prompt 模板
```text
clothes, underwear, dress, shirt, skirt, pants, socks, shoes, boots,
long hair, loose hair, bangs, hair accessories, bow, ribbon,
action pose, dynamic pose, walking, running, sitting, tilted head, camera tilt, perspective foreshortening,
side view, three-quarter view, back view, crossed arms, crossed legs, hands in pockets,
blurry, lowres, bad anatomy, deformed limbs, extra fingers, extra hands, missing limbs,
background, indoor, outdoor, shadow on floor, drop shadow, white background, gray background, checkerboard pattern.
```

---

## 4. Schema 2：独立分层组件（Independent Layer Component Prompt 规范）

### 4.1 独立组件的硬性约束
所有服装（top、bottom、dress、outerwear）、鞋袜（socks、shoes）、独立发型（hair）与饰品（hairAccessory、accessory）必须满足：
1. **单一独立组件（Single Isolated Component）**：只生成该物件本身，严禁包含模特人体、人体轮廓、假人模特（Mannequin）或衣架。
2. **相同画布与锚点（Fixed 760×1000 Canvas）**：即使是一只小蝴蝶结或一双短袜，也必须输出在 **760×1000 px 画布** 的绝对正确空间位置上，与 Body Base 严格重合对齐。
3. **一致光照（Consistent Lighting）**：统一采用正前上方柔和赛璐珞光源（Upper-front soft lighting），避免部件叠放时光影方向矛盾。
4. **透明背景与完全中空（Transparent Interior Space）**：
   - **服装内部必须中空**：领口、袖口、下摆内部原本露出身体的部分必须是**完全透明的 Alpha=0 空间**，供 Body Base 的身体肌肤自然穿入显露。严禁模型在衣服内部绘制肉色皮肤、手臂截面或脖颈！

### 4.2 发型结构解耦约束（Back-Hair vs Front-Hair）
长发极易在叠放时发生层次穿模。严禁将所有长发合并为一个覆盖在所有服装最前方的庞大图层。
规范要求拆分两部分：
- **后发（Back Hair, Z-index 较低）**：位于身体与大部分衣物之后（`z < body` 或紧贴底模背后），承载后脑勺长发、垂至背部的披肩发梢。
- **前发/刘海（Front Hair / Bangs, Z-index 较高）**：位于面部五官与内层衣物之前，承载刘海、鬓角侧发。
- **核心发型不可脱空**：发型属于角色核心视觉身份，衣柜中 `hair` 槽位标记为 `required: true`，不可被完全脱下，仅可换款式。

---

## 5. Negative Prompt（负向提示词体系）

### 5.1 全局通用 Layer Negative Prompt
生成任何独立分层图层时，**必须默认携带**以下全局排斥词：
```text
human body, skin, naked body, torso, chest, face, head, neck, collarbone,
hands, fingers, arms, legs, thighs, feet, toes, human silhouette,
mannequin, dress form, dummy, hanger, clothing rack, stand, display stand,
extra limbs, extra sleeves, extra legs, deformed shape,
skin showing through empty clothes, flesh tones, skin texture,
drop shadow, cast shadow, ambient occlusion shadow on background,
white background, gray background, black background, opaque background,
checkerboard pattern, faux transparency grid,
cropped edges, close-up, perspective distortion, isometric view.
```

### 5.2 类别专属 Negative Prompt 补充

#### (1) 上装与外套（Tops & Outerwear）
```text
neck, collarbone skin, cleavage, chest skin, belly, navel, bare shoulders,
arms inside sleeves, wrists, hands, waist skin, lower body, skirt, pants.
```

#### (2) 下装与短裙（Bottoms & Skirts）
```text
waist skin, belly button, legs inside skirt, thighs, knees, calves, underwear, upper body, shirt.
```

#### (3) 连衣裙（Dresses）
```text
bare skin inside neckline, bare arms, bare legs under hem, body contours drawn in skin tone, head, face, shoes.
```

#### (4) 袜子（Socks & Thigh-highs）
```text
feet, toes, toenails, legs, skin above socks, skin below socks, shoes, boots, sole of foot.
```

#### (5) 鞋靴（Shoes & Boots）
```text
legs, ankles, socks, bare feet, toes, skin, pants legs tucked in, ground plane, floor shadow.
```

#### (6) 发型（Hair Components）
```text
face, eyes, nose, mouth, ears, neck, shoulders, complete head, skull, body, clothes, hairpins not requested.
```

#### (7) 发饰与配饰（Hair Accessories & Accessories）
```text
hair, head, face, ear, neck, fingers, clothes, full character.
```

---

## 6. 新资产工业化生成工作流

```mermaid
flowchart TD
    A["1. 确定资产定义<br>(Slot, Z-index, itemId)"] --> B["2. 调取 760x1000 母版锚点"]
    B --> C["3. 运行 Layer Component Prompt + Category Negatives"]
    C --> D["4. 检查 Alpha=0 透明背景与中空穿入空间"]
    D --> E["5. 边缘去色与抗锯齿 (tools/chroma.py / 手工修剪)"]
    E --> F["6. 存入 assets/character/{slot_dir}/{itemId}.png"]
    F --> G["7. 在 src/wardrobe.js CATALOG 登记"]
    G --> H["8. 执行自动化测试 (node test/wardrobe.test.js)"]
```

### 6.1 生成 Prompt 标准撰写范式（示例：灰色宽松 T 恤）
```text
[Prompt]
isolated single clothing item, one oversized light gray t-shirt,
short sleeves, relaxed crew neckline, soft cotton fabric texture,
hollow interior, transparent opening for neck and arms,
strictly front view, perfectly centered on 760x1000 canvas,
anime cel-shading style, clean crisp lineart, matching upper-front light source,
pure transparent RGBA background, production sprite asset.

[Negative Prompt]
human body, neck, collarbone, arms, hands, torso, chest skin, skin texture,
mannequin, hanger, shadow, checkerboard background, white background, cropped.
```

---

## 7. 现有衣柜插槽体系与未来扩展架构

### 7.1 当前生产已实现的 9 大插槽（`src/wardrobe.js`）
当前渲染管线严格按照以下 Z 轴层级升序叠放（从下到上）：

| 序号 | 槽位 ID (`slot`) | 中文名称 | Z-index | 是否必选 (`required`) | 冲突与互斥规则 |
| :---: | :--- | :--- | :---: | :---: | :--- |
| 1 | `hair` | 发型 | 10 | **true**（核心身份件，不可脱空） | 只能更换款式 |
| 2 | `socks` | 袜子 | 20 | false | 可脱下 |
| 3 | `dress` | 连衣裙 | 30 | false | **与 top、bottom 强互斥** |
| 4 | `top` | 上装 | 31 | false | 与 dress 互斥 |
| 5 | `bottom` | 下装 | 32 | false | 与 dress 互斥 |
| 6 | `outerwear` | 外套 | 40 | false | 覆盖于上装/连衣裙之上 |
| 7 | `shoes` | 鞋子 | 45 | false | 可脱下 |
| 8 | `hairAccessory`| 发饰 | 50 | false | 默认 `black_bow_01`，可脱下 |
| 9 | `accessory` | 饰品 | 60 | false | 最外层挂件 |

### 7.2 架构审查与未来插槽预留（Architecture Compatibility Check）
本轮审查确认：**初澜现有插槽体系具备向更高级生命体表现扩展的弹性，且不阻止后续演进。**
未来规划的可平滑挂载插槽包括：
- `backHair` (Z=5，底模背后的长发层)
- `frontHair` (Z=15，前额刘海层)
- `eyes` (Z=8，眼部差分与视线追踪)
- `mouth` (Z=9，嘴型差分与语音对口型)
- `expression` (Z=9.5，面部综合情绪表情)

> **职责边界说明**：
> “初澜身体之外的视觉组件原则上可替换”并不等同于所有视觉元素都必须塞入 `wardrobe.js`。
> 身体骨骼、生命情绪差分与日常换装服饰保持清晰的职责解耦，有利于后续平滑接入表情控制器或动画状态机。

---

## 8. 资源质检清单（Quality Checklist）

在将生成的图片提交入库前，必须逐项通过以下验收门禁：

- [ ] **格式正确**：必须为真正 32-bit RGBA PNG 格式，严禁伪透明或 JPG 强转。
- [ ] **尺寸绝对一致**：必须严格为 **760×1000 px**，严禁拉伸或非标准比例。
- [ ] **Alpha 通道真实透明**：背景必须完全透明（Alpha=0），严禁保留 AI 生成的伪透明黑白棋盘格。
- [ ] **穿入空间中空**：服装领口、袖口、裤口内部必须中空透明，无多余皮肤色块或假人骨架。
- [ ] **无边缘污染**：高对比度放大检查边缘，无白边（White Fringe）、黑边或绿幕反光溢色。
- [ ] **锚点重合**：与 `assets/character/base/base.png` 叠加对比，肩膀、腰线、脚底基准线 100% 严密对齐。
- [ ] **命名规范**：文件名仅限小写字母、数字和下划线（如 `hoodie_blue_01.png`），并在 `src/wardrobe.js` 中完成登记。
