# 吉祥物形状墨迹包围盒实测与缩放系数（mascot-fit t1）

> 2026-10-27 · 任务：`mascot-fit` t1（量出每个吉祥物形状的墨迹包围盒与缩放系数）
> 仓库：`/Users/limeng/DSH/团队/dsh-team-mode`
> 数据源：`node_modules/@dicebear/styles/dist/gaze.min.json` → `components.shape.variants`（`@dicebear/styles` 10.6.0，11 个变体，canvas 100×100）
> 产物：`scripts/measure-mascot-shapes.mjs`（一次性脚本）+ `src/client/mascot-shape-fit.ts`（`MASCOT_SHAPE_FIT`）
> 无新增依赖；不改 UI 代码。

---

## 0. 结论

`scale = targetFill / fillRatio`，`targetFill = 0.98`，`fillRatio = max(width, height) / 100`。
把生成 SVG 的 100×100 画布整体放大 `scale` 倍（以画布中心为原点、父容器 `overflow: hidden`），每个形状的最长边就占到 36px 容器的 98%，四周各留 1%。

| shape | x | y | width | height | fillRatio | scale |
|---|---|---|---|---|---|---|
| circle | 16 | 16 | 68 | 68 | 0.68 | 1.441 |
| square | 16 | 16 | 68 | 68 | 0.68 | 1.441 |
| triangle | 16.329 | 17.635 | 67.342 | 60.365 | 0.673 | 1.455 |
| pentagon | 16.769 | 17.82 | 66.463 | 64.92 | 0.665 | 1.475 |
| hexagon | 17.96 | 16 | 64.08 | 68 | 0.68 | 1.441 |
| octagon | 15.915 | 15.915 | 68.17 | 68.17 | 0.682 | 1.438 |
| diamond | 16.305 | 16.305 | 67.39 | 67.39 | 0.674 | 1.454 |
| pill | 11 | 25 | 78 | 50 | 0.78 | 1.256 |
| column | 28 | 11 | 44 | 78 | 0.78 | 1.256 |
| egg | 21 | 13 | 58 | 73 | 0.73 | 1.342 |
| arch | 18 | 14 | 64 | 74 | 0.74 | 1.324 |

入库常量见 `src/client/mascot-shape-fit.ts` 的 `MASCOT_SHAPE_FIT`（数值与上表 `scale` 列一致）。

---

## 1. 怎么量的

脚本 `scripts/measure-mascot-shapes.mjs` 直接读 DiceBear 的样式 JSON，不打渲染器、不截图：

1. 每个变体取**绘制身体的那一个元素**（`elements` 里第一个非 `<g>` 的 `element`）：实际数据里是 `<path>` 8 个、`<circle>` 1 个（circle）、`<rect>` 2 个（pill / column），没有 `<polygon>`。脚本对 path/circle/rect/polygon/polyline 都实现了包围盒；未知元素直接抛错，不静默跳过。
2. `<circle>` 用 `cx±r / cy±r`；`<rect>` 用 `x,y,w,h`（`rx` 不改变包围盒）。
3. `<path>`：完整的 `d` 词法/命令解析（`M L H V C S Q T A Z`，含相对命令与隐式重复参数），**每个三次/二次贝塞尔和椭圆弧采样 128 段**取极值，而不是拿控制点当边界——控制点会在曲线外侧虚增包围盒（例如 triangle 的 `Q50 12` 实际最低点是 17.635，不是 12）。
4. 弧线按 SVG 1.1 F.6.5 的 endpoint → center 参数化后按 θ 采样；当前 11 个变体没有 `A` 命令，但脚本支持，避免以后样式升级时量错。
5. `fillRatio = max(width, height) / 100`（100 是 viewBox 边长）；`scale = 0.98 / fillRatio`，保留三位小数（36px 下 0.001 的误差 < 0.04px）。
6. 采样结果与解析极值交叉验证，避免采样步数骗人：
   - triangle 顶部二次曲线 `Q(50,12)`，起点/终点 y 都是 23.27，顶点 y = (23.27 + 2×12 + 23.27) / 4 = **17.635**，与输出的 `y` 完全一致；
   - pentagon 顶部 `Q(50,14)` 同理 = (21.64 + 2×14 + 21.64) / 4 = **17.82**，也一致。

## 2. 脚本输出（原样）

```text
shape     x       y       width   height  fillRatio  scale
circle    16      16      68      68      0.68       1.441
square    16      16      68      68      0.68       1.441
triangle  16.329  17.635  67.342  60.365  0.673      1.455
pentagon  16.769  17.82   66.463  64.92   0.665      1.475
hexagon   17.96   16      64.08   68      0.68       1.441
octagon   15.915  15.915  68.17   68.17   0.682      1.438
diamond   16.305  16.305  67.39   67.39   0.674      1.454
pill      11      25      78      50      0.78       1.256
column    28      11      44      78      0.78       1.256
egg       21      13      58      73      0.73       1.342
arch      18      14      64      74      0.74       1.324

targetFill=0.98, samplesPerCurve=128, canvas=100x100
```

复跑：

```bash
node scripts/measure-mascot-shapes.mjs
```

（`node` 打印的 `UNDICI-EHPA` 警告来自本机代理环境，与本脚本无关，可忽略。）

## 3. 使用这些系数时要知道的三件事

1. **只按“最长边”归一。** `pill`（78×50）放大 1.256 后宽占 98%、高只占 62.8%，这是形状本身的比例；并排时以最长边读大小，视觉等大。若以后想改成“按面积归一”，需要另取 `sqrt(wh)` 口径，本表不适用。
2. **DiceBear 每次渲染还会给身体加一层按 seed 的抖动**：`components.shape` 的 `rotate: -11..11°`、`scale: 0.93..1.06`（可在生成 SVG 的 `<use transform="rotate(...) translate(50,50) scale(...)">` 里看到）。这部分是逐 seed 随机的，静态系数表无法抵消；本表量的是抖动前的真实几何，属于可归一的上限。11° 旋转绕画布中心进行，形状的墨迹半径不变，因此不会额外出画布。
3. **系数假设以画布中心缩放。** 各形状墨迹中心几乎都在画布中心：横向全部是 50；纵向最大偏差是 triangle 的 −2.18 单位（36px 下约 0.8px），arch 为 +1.0。按 0.98 归一后，arch 的底部到达 `(88−50)×1.324+50 = 100.31` 单位，即在 36px 容器底边被裁掉约 **0.11px**，属于亚像素级；其余形状放大后最长边都落在 98%。如果以后容器改成非 `overflow: hidden` 或换成圆形裁剪，需要重新评估边缘。

## 4. 改动文件

- `scripts/measure-mascot-shapes.mjs`（新增，一次性测量脚本，不参与构建）
- `src/client/mascot-shape-fit.ts`（新增，唯一入库的系数表）
- `docs/superpowers/notes/2026-10-27-mascot-shape-fit.md`（本文件）
