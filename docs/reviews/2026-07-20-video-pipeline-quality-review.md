# 视频生成核心流程质量审查(2026-07-20)

> 背景:最终生成的视频"不够精美"。本次审查覆盖 research → design → script → voiceover → compose → render 全链路,
> 以及 skills 内容、registry 组件目录、渲染质检门。方法:8 个领域评审 agent 深读各子系统 + 逐条对抗核实
> (33 条确认;另有 14 条核实器因限额未跑完,其中关键条目已人工对照代码逐一证实)。
> 所有 file:line 以本 worktree 为准。

## 核心结论(为什么不精美)

不是某个单点 bug,而是四个结构性问题叠加:

1. **全链路没有"眼睛"**。research 只有 `web_fetch`(纯文本 HTML),从不截图;design 看不到网站、看不到 logo、
   看不到自己生成的图;compose 看不到任何素材像素、也看不到自己作品的任何渲染帧;QA 门只回传文本诊断。
   而 prod 用的 Gemini 3.1 Pro 是多模态模型——这个能力全程闲置。
2. **决定美感的上游阶段没有弹药**。design 的 system prompt 约 7 行、script 约 16 行,而 compose 有 160 行铁律。
   视觉方向(配色、字体、动效语言)和叙事节奏在最上游被"裸奔"决定,下游再努力也只能在错误的方向上抛光。
3. **质检门只拦"错",不拦"丑"**。lint/validate/inspect 能拦溢出和黑屏(部分),但对比度是 exit-0 警告被静默丢弃
   (system prompt 却向 agent 承诺会验证 contrast)、无 design 一致性检查、无像素级黑帧检测、prod 渲染只用
   standard/30fps。
4. **skills 与 registry 与 pipeline 环境错配**。skill 内容本身不错,但它是为交互式 Claude Code 写的:教 agent 跑
   `npx hyperframes lint/preview`(compose 没有 shell)、教用不存在的 `HyperShader` API、preset 里带禁用字体 Inter;
   registry 的 caption 组件自带违规 `<link>` Google Fonts、60/64 blocks 只有横屏。

---

## P0 — 最高杠杆(建议先做)

### 1. 给 compose 加"视觉回看"闭环 ⭐ 单点最大杠杆
- **现状**:[pi-compose-handler.ts:477-504](../../apps/server/src/phases/pi-compose-handler.ts) 的循环:
  `runner.check()` 通过即定稿。agent 盲写 500+ 行 HTML/CSS/GSAP,几何检查一过,首稿审美直接出片。
  修复轮的反馈也只有 JSON 文本。
- **修复**:validation 通过后,在关键时间点(每场景中点)截 3-5 帧,以 image block 附给同一个 harness,
  强制一轮"视觉自评"(对照 design 检查布局/配色/层次/字体渲染),改完再过一次门。inspect 本身已驱动
  headless Chrome,补一个截图调用即可。每视频约多一次多模态调用,成本可忽略。
- 同理:修复轮把失败场景的截图一并附上,而不是只有 bounding-box 文本。

### 2. research 加网站截图 + 品牌提取规则
- **现状**:[research-tools.ts](../../apps/server/src/tools/research-tools.ts) 只有 web_fetch(文本)/download_asset
  (只回传路径文本)。system prompt([pi-research-handler.ts:15-51](../../apps/server/src/phases/pi-research-handler.ts))
  对 color/font/CSS/srcset **零提及**,但 `write_brief` 的 `brandHints.colors` 是必填字段——模型被迫从 HTML 文本里
  编造 hex,而现代网站的品牌色在外链 CSS custom properties 里,web_fetch 的 HTML body 里根本没有。
- **修复**:
  - 加 screenshot 工具(render worker 已有 Chromium),首屏+全页截图作为 image block 给 research 和 design;
  - prompt 加提取规则:抓主样式表、`:root` custom properties、`<meta name="theme-color">`、manifest 色、
    heading/body 的 font-family 栈;色板按 背景/前景/强调 排序并注明出处;
  - 用 sharp(已是依赖)对 logo/og:image 做主色提取,确定性写入 brandHints,不全靠 LLM 猜;
  - download_asset 把图片本体作为 image block 回传(大图降采样),让模型看得见自己抓了什么。
- 另修:favicon 让抓却抓不了(`.ico` 不在 [ALLOWED_IMAGE_TYPES](../../apps/server/src/tools/research-tools.ts) 白名单);
  read_upload 用 utf8 读二进制上传(用户上传的 logo PNG 变乱码)。

### 3. 重写 design 阶段(prompt + schema + 输入)
- **现状**:[pi-design-handler.ts:10-17](../../apps/server/src/phases/pi-design-handler.ts) 全部艺术指导是一句话;
  bare Agent,没有 harness、没有 read_skill_file——而 vendored 的 house-style.md / typography.md / palettes/
  里全是现成的设计知识,design 阶段一个字都用不上。schema([design.ts](../../../packages/shared/src/design.ts))
  的 palette 只是 `{name,hex}[]`,无色彩角色(bg/fg/accent),compose 只能猜哪个色当背景;无 type scale、无间距、
  无 motion spec。
- **字体矛盾**:design 自由选字体,compose 却有 Google Fonts 白名单 + 禁用名单(Inter/Roboto/Poppins/Syne…)。
  design 大概率选中禁用字体,compose 要么违规要么擅自换掉——设计一致性从这里就断了。
- **修复**:
  - 把 house-style/typography/palettes 精华蒸馏进 design system prompt(或给 design 也配 harness + skill 子集);
  - 字体约束前移:把"Google Fonts 目录 + 禁用名单"写进 design prompt;
  - 扩展 DesignSchema:色彩角色(background/surface/foreground/accent + 用途)、type scale、spacing/radius、
    motion 语言(ease 家族、节奏)、每场景艺术方向;
  - 把网站截图 + logo + 生成的 key visuals 作为图像输入给 design agent(多模态,零基建成本);
  - design 的 generate_image 产物没人看过就出片——同样附图自查。

### 4. 把"对比度"从空头承诺变成真门
- **现状**:compose prompt 明说"The system will validate it (lint, **contrast**, and layout inspect)"
  ([pi-compose-handler.ts:189-190](../../apps/server/src/phases/pi-compose-handler.ts)),但
  [quality-runner.ts](../../apps/server/src/render/quality-runner.ts) 里 validate 的 WCAG 警告 exit 0 直接被丢。
  agent 被明确告知系统会兜底,于是更不自查。低对比文字是生成视频最常见的丑。
- **修复**:仿照 `findSevereContainerOverflows` 的既有模式加 `findContrastFailures()`:解析 validate 输出,
  比率不达 4.5:1(正文)/3:1(大字)就 `ok=false` 塞回诊断。~50 行。

---

## P1 — 结构性修复

### 5. brief 在 compose 边界被丢掉
compose 只用了 brief 的 aspectRatio/bgm/logoFile/图片列表([pi-compose-handler.ts:447-467](../../apps/server/src/phases/pi-compose-handler.ts))。
产品名、受众、keyMessages、brandHints.colors/fonts、sourceAssets.copy 全部到不了写片子的人手里。
把 brief 的产品/受众/品牌块加进 compose 的 context。

### 6. script 阶段叙事升级(纯 prompt 改动)
[pi-script-handler.ts:8-24](../../apps/server/src/phases/pi-script-handler.ts) 只有机械规则(总时长相等、覆盖
keyMessages、不重叠)。没有 hook、没有 问题→方案→证明→CTA 弧线、没有场景数/时长变化指导——产出天然是
"均匀幻灯片"。参照 compose 的力度重写:hook ≤3s、CTA 停留 ≥3-4s、相邻场景时长要有变化、onScreenText ≤6 词、
narration 为耳朵而写。

### 7. 节奏被 TTS 机械改写 + 总时长失控
[narration-timeline.ts:34-36](../../apps/server/src/phases/narration-timeline.ts):narrated 场景时长被
`audio + 1s pad` 直接覆盖,script 的节奏设计作废;没有任何机制核对改写后总长 vs 用户选的 15/30/60s
——"30 秒视频"实际出多长全看 TTS 念多快。修复:
- script prompt 加词数预算(~2.4 词/秒),write_script 时校验偏差 >25% 就打回;
- TTS 后总长偏差 >15% 回环 script 给出逐场景删减目标;
- 把"每场景末尾有 1s pad,可用作转场窗口"明确告诉 compose(现在它不知道 pad 存在)。
- TTS 无任何语气指导(brief/design 的 tone 到不了 voiceover)——把 mood 传给 TTS 的 style 指令。

### 8. 转场契约自相矛盾(每个带旁白的视频都中招)
[narration-prompt.ts:24-26](../../apps/server/src/phases/narration-prompt.ts) 要求场景 clip 用 EXACT
data-start/duration(硬窗口,出窗即卸载),而必读的 transitions/catalog.md 教的是"场景 div 不带 clip 属性,
用 GSAP reveal 控制可见性"。两个权威契约打架:守前者→交叉溶解退化成硬切;守后者→违反 narration 块。
修复:把 narration timeline 改为"时间边界"语义(reveal 时刻 + audio data-start),或明确允许 N+1 场景
提前 ≤0.8s 进场、声明 1s pad 就是转场窗口。

### 9. skills 出"pipeline 版"
skill 内容为交互式使用而写,在 compose 环境里有四类硬伤(均已逐条证实):
- **不存在的 API**:transitions.md/beat-direction.md/catalog.md 教 `HyperShader.init()` /
  `@hyperframes/shader-transitions`——该包在 server 环境、registry、lockfile 里**均不存在**,照做必挂;
- **不可用的指令**:SKILL.md 的 checklist 要求跑 `npx hyperframes lint/validate/inspect/preview`、
  registry skill 教 `curl` GitHub——compose agent 没有 shell;
- **自相矛盾**:visual-styles.md 有 7 处 `fontFamily: Inter`,而 typography.md 和 compose prompt 都把
  Inter 列为禁用;
- **引导用户交互**:design picker、"问用户要不要变体"等流程在 pipeline 里无意义,浪费注意力。
修复:为 pipeline 维护一个净化过的 skill 子集(删 CLI/交互/HyperShader 段落、修 preset 字体),或在
skill-loader 加一层 pipeline overlay。**这也解释了为什么"读 skill"是自觉行为**——目前 prompt 只说
"read BEFORE authoring",没有任何机制核实 agent 真读了;净化后可考虑把最关键的 2-3 个 reference
(transitions 目录、motion-principles、typography)直接预注入 compose prompt,不再赌模型自觉。

### 10. registry 组件与主契约打架
- caption-* 组件(prompt 主动推荐的那批)自带 `<link href="fonts.googleapis.com...">` + 硬编码 Montserrat
  ——compose 自己的铁律禁止 `<link>` 字体加载;安装即违规,agent 要么带病出片要么弃用;
- 27 个 transition blocks 实为 "Showcase" demo 页(描述里自己写着 showcase),却被当 drop-in 转场卖给 agent;
  多个 block 内部 `data-composition-id="main"` 与宿主根 id 撞名;
- 块安装是黑盒:agent 看不到安装内容,Figma/HeyGen 等第三方水印可能原样进片;
- 60/64 blocks 是 1920×1080:9:16/1:1 的单子基本无组件可用,且目录不按 aspect 过滤,竖屏时全是干扰项。
修复:组件参数化(颜色/字体走 design token)、去 `<link>`、目录按 aspectRatio 过滤、把 showcase 类块
下架或改标签、给 add_registry_item 的返回附上块的 HTML 概要。

---

## P2 — 打磨项

- **黑帧像素检测**:现有唯一防线是一条窄正则([scene-reveal-check.ts](../../apps/server/src/render/scene-reveal-check.ts),
  只匹配 `gsap./tl.from` 字面量),两类已上过 prod 的黑屏(grid 塌陷、position-0 hide-all)它都拦不住。
  在 inspect 阶段按场景中点截帧算亮度方差,近全黑即 fail;渲染后再用 ffmpeg blackdetect 兜底。
- **design 一致性静态检查**:把 design 工件传进质检(现在 `check(projectDir)` 根本拿不到 design),
  diff 组合物里的 hex/font-family vs 色板(容忍同色相明暗变体),"发明色 #4ecdc4 不在色板中"直接进修复循环。纯字符串/色彩数学。
- **generate_image 风格一致性**:目前每次调用独立 prompt,同一视频里生成图风格漂移;由 design 生成统一的
  style suffix(色板+光影+媒介描述)自动拼进每个 prompt;分辨率从默认 ~1K 提到 2K 再进 1080p 帧。
- **compose 素材回收污染**:[pi-compose-handler.ts:322-341](../../apps/server/src/phases/pi-compose-handler.ts)
  全量扫 assets/ 目录,research 刻意排除的近空白图又被捞回 available assets。给被拒素材做标记(或单独目录)。
- **渲染档位**:prod 全部 standard/30fps,文档定义的 final-delivery 档(--quality high)从未用过。至少 Pro 用户出 high。
- **refinement 只活一跳**:[session-orchestrator.ts:528-529](../../apps/server/src/orchestrator/session-orchestrator.ts)
  用户的审美反馈("更高级一点")只进链条第一个 phase,下游只见再生成的 JSON。给 Brief 加 styleIntent 字段沉淀用户审美语言。
- **审批门是纯文本**:design 的用户审批看不到 sample frames / 已花钱生成的 key visuals 图片,用户在盲批。

## 已被驳回的方向(核实后不成立/已有缓解)

14 条中除上文人工证实的外,真正被驳回的主要是:个别 line 号引用错位、以及"UI 约束会被 LLM 洗掉"
(已由 d46047a 确定性覆盖修复)。完整清单见 workflow 输出。

## 数据来源

- Workflow run `wf_2e1f0580-224`:8 个子系统 map + 33 条对抗核实通过的发现 + 9 条 low notes。
- 完整发现明细(evidence/fix 全文):session scratchpad `confirmed-findings.md`。
- 14 条未跑完核实的发现中,shader API 缺失、Inter 冲突、CLI 指令不可用、caption `<link>` 违规、
  竖屏目录空缺、showcase 误标、registry skill 教 curl,均已由主会话人工对照代码证实。
