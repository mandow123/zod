# ZOD Phase 2 统一审阅与验收报告

报告 ID：`01a02b2b-c34f-7ce2-9f03-d7af11a121af:3`
状态：**Phase 2 技术与视觉独立复核已获妈妈批准**
阶段：`phase-2-unified-final-acceptance`

## 1. 目标与权限边界

本阶段把架构、A/B/C 视觉方向、十二场景、provider 修订和既有验证证据收束为一个可直接打开的入口。原始统一入口的唯一写入面是 `docs/unified-review/**`。

本报告是设计证据归档；不授权真实 React Native UI、发布、部署或生产变更。

统一入口：[index.html](./index.html)

## 2. 本轮证据来源

- 架构审计：[ZOD_ARCHITECTURE_OPTIMIZATION.md](../ZOD_ARCHITECTURE_OPTIMIZATION.md)
- 架构 before/after：[current-state.html](../../architecture-previews/current-state.html)、[target-state.html](../../architecture-previews/target-state.html)
- 视觉方向说明：[ZOD_MOBILE_VISUAL_DIRECTIONS.md](../ZOD_MOBILE_VISUAL_DIRECTIONS.md)
- A/B/C 总览：[index.html](../design-previews/2026-08-23/index.html)
- A/B/C 运行时：[preview.js](../design-previews/2026-08-23/preview.js)
- design 来源说明：[README.md](../design-previews/mobile-20260823/README.md)
- 目标态差距审计：[zod-mobile-gap-audit.md](../design-previews/mobile-20260823/zod-mobile-gap-audit.md)
- 已归档 provider 设计快照：[kai-mobile-v2-preview.html](../design-previews/mobile-20260823/kai-mobile-v2-preview.html)
- 已批准 Phase 1 技术报告：`01a02b2b-c34f-7ce2-9f03-d7af11a121af:2`
- 已批准 Phase 1 视觉报告：`01a02b2b-c253-7da1-8a42-3281985e9156:2`

## 3. AC-01 至 AC-07 证据矩阵

| AC | 当前状态 | 可验证证据 | 边界 / 不可推断 |
| --- | --- | --- | --- |
| AC-01 | Phase 1 已验证、已批准 | provider workspace `provider_order → orders/provider`；provider message `messages/provider`；buyer order `orders/buyer`；生命周期卸载保护；provider_offer 先进入 publish；聚焦 8/8、全量 161/161、TypeScript、143/121 | 143/121 不覆盖 payload、auth 或运行时后端 |
| AC-02 | Phase 1 已验证、已批准 | 两份架构 HTML 解析 2/2，内容与 typed intent / lifecycle / 唯一 executor 一致 | 未采集真实设备性能 profiler |
| AC-03 | Phase 2 已批准 | A/B/C 共用 12 场景，结构上 3×12 可达；buyer/provider 两套五栏；9 张 390×844 代表截图；既有独立浏览器 72/72 双尺寸检查、Back/Forward/focus 和 console 证据 | 不是 36 张截图；没有 A/B/C 360 截图集；CSS 不能替代几何实测；Web History/focus 仅属 HTML |
| AC-04 | Phase 2 已批准 | design 来源提交、provider 快照 SHA、README、gap audit 和媒体依赖均可追溯；视觉与技术 verifier 均 PASS | 设计证据不是 main、生产或已合并 RN；gap audit 的 main 是旧审计基线 |
| AC-05 | Phase 2 已批准 | 统一 HTML 入口、本文、107/107 本地链接、双尺寸入口浏览器检查和两次独立只读复核 | 入口只汇总证据，不授权实施 |
| AC-06 | Phase 1 已验证、已批准 | provider 顶部媒体、底部五栏、390/360、console 0/0、媒体仅 workspace 播放 | 实际 OS reduced-motion 未模拟 |
| AC-07 | Phase 1 已验证、已批准 | 两岗位联合 :2 报告、独立复核、无接口/所有权冲突 | 报告批准不等于真实 UI 授权 |

## 4. 架构证据

### 4.1 精确职责边界

- `App.tsx`：唯一 `AppNavigationIntent` 副作用执行器，负责 route、订单侧、加载和 Sheet state。
- `src/core/app-navigation-intents.ts`：把 workspace、通知和 offer 状态收窄为 UI-neutral typed intent。
- `src/core/use-app-lifecycle.ts`：集中 Linking、AppState、Notifications 注册与释放。
- `src/navigation.ts`：RN 五主栏和 11 个内部 route ownership。
- `src/screens/**`：继续承载页面错误/空态与视觉；Phase 1/2 均未修改。

### 4.2 provider_order 与 provider_offer

- `open-order` intent 显式携带 `side`；唯一 executor 在加载订单前设置 `orderSide`。
- provider workspace order 为 `orders + provider`，不会沿用默认 buyer 订单侧。
- provider offer 先切到 publish，再加载状态；加载失败仍在 publish，不构造假 offer intent。

### 4.3 生命周期

- 启动 URL Promise 解析后，在调用 `onUrl` 前检查 active；取消订阅后晚到 URL 不回调。
- AppState 和 notification subscription 各自配对清理；最后通知响应异步结果也有卸载保护。

### 4.4 RN / Web 边界

RN 源码和架构预览没有 `pushState`、`replaceState`、`popstate` 或 DOM focus。远程 HTML 和 A/B/C 的 Back/Forward、URL、active nav 与 heading focus 是各自的浏览器投影证据，不能反推 RN 已实现 Web History。

## 5. A/B/C 与 3×12

三方向入口：

- [A 精密控制](../design-previews/2026-08-23/direction-a-control.html)
- [B 编辑流](../design-previews/2026-08-23/direction-b-editorial.html)
- [C 信任凭证](../design-previews/2026-08-23/direction-c-ledger.html)

共用 `preview.js` 的 12 场景：

1. `home` — 买方首页
2. `market` — 资源市场
3. `assets` — 我的资产
4. `messages` — 消息
5. `profile` — 我的
6. `orders` — 买方订单
7. `wallet` — KAI 卡时
8. `workspace` — 供应工作台
9. `resources` — 提供方资源
10. `publish` — 上架中心
11. `login` — 安全登录
12. `offline` — 离线恢复

两角色五栏：

- buyer：`home / market / assets / messages / profile`
- provider：`workspace / resources / publish / messages / profile`

入口中的 36 个深链接证明结构可达。截图证据是 9 张代表图：A 为 home/market/workspace，B 和 C 为 home/market/assets；这些 `.png` 文件实际承载 JPEG 内容，均为 390×844。`screenshots-overview.png` 为 1280×720。没有 36 张全矩阵截图，也没有 A/B/C 的 360×800 截图集。

既有视觉报告记录的真实浏览器验收为 3 方向 × 12 场景 × 2 尺寸 = 72/72，覆盖 `scrollWidth === clientWidth`、五栏、可点击控件；其 Back/Forward/focus/console 结论属于浏览器验收，而不是从 `overflow-x:hidden` 推断。

## 6. 远程快照与 origin/main

| 项目 | 当前复核事实 |
| --- | --- |
| 架构父提交 | `321fe7e8c6415fb673b418ca410b917f41c5f373` |
| 其 main 基线 | `4a6236ec9bc3ae04f54713617a388f0b0aed7a6f` |
| 来源分支 | `origin/design/mobile-preview-20260823` |
| 工作树 HEAD | `0708bc377c75cd5ff4eac1ac6fea2a3419415fed` |
| 分支关系 | design 提交内容在线性候选中以来源提交形式重放 |
| provider 修订 | `kai-mobile-v2-preview.html` 来自已批准 design 工作树快照，将作为本分支设计证据提交 |
| 来源文件 SHA-256 | `49943850d13996c8b099a92f7160f543eb21b265940e96cbcf9614f9a223359c` |
| 旧 audit 基线 | `b2adcc088543a25725ed46bb8287454478150c85` 仅是 2026-08-20 gap audit 当时的 origin/main |

因此当前应称为：**由 design 工作树快照归档的设计证据**。它不是 main、生产或 React Native 实现。

远程资源：

- [integrated preview](../design-previews/mobile-20260823/kai-mobile-v2-preview.html?role=provider&size=393#app-workspace)
- [README](../design-previews/mobile-20260823/README.md)
- [gap audit](../design-previews/mobile-20260823/zod-mobile-gap-audit.md)
- [poster](../design-previews/mobile-20260823/server-room-poster.jpg)
- [mp4](../design-previews/mobile-20260823/server-room-preview.mp4)

## 7. 双尺寸、History、focus 与 console

### A/B/C

- 已批准证据：390×844 与 360×800 的 72/72 浏览器检查，无横向溢出；Back/Forward 后 URL、标题、标题焦点与导航焦点恢复；两尺寸 console 无错误。
- 证据呈现限制：只保存了 9 张 390×844 代表截图，没有 A/B/C 360 截图集。

### 远程 provider 修订

- 390×844：document 390/390，phone 390×844，nav 388×82，media 352×170。
- 360×800：document 360/360，phone 360×800，nav 358×82，media 322×170。
- buyer/home ↔ provider/workspace 及 workspace ↔ resources 的 Back/Forward 后，URL、role、route、active nav 与 heading focus 一致。
- provider 视频只在 workspace 播放；其余 route 和 buyer 角色暂停；console error/warning 为 0/0。
- 实际 OS reduced-motion 未模拟；仅验证 CSSOM、JS pause 分支和常驻 poster。

以上均是 HTML 浏览器证据，不是 RN History/focus 或真实业务运行时证据。

## 8. 静态 API 合同边界

`143 calls / 121 route contracts` 来自静态脚本：收集 `src/**` 的 `apiRequest` / `orderAction` 和 `backend/src/**` 的 app routes，再匹配 `/mobile/v1` 的 HTTP method + normalized path。

它不验证：

- 请求 payload 或响应 schema；
- 认证、授权和交易主体语义；
- 后端运行时可达性；
- 真实余额、订单、库存、收益或权限；
- HTML History、focus、console 或视觉几何。

## 9. 本地打开

从仓库根目录启动任意静态文件服务器，然后打开 `docs/unified-review/index.html`。所有交付链接均为仓库相对路径，统一入口、A/B/C、架构预览和 provider 设计证据均可在同一仓库中访问。

## 10. 本轮验收状态

统一入口草案自检：

- 本地链接：HTML `href/src` 88 项、Markdown 本地链接 19 项，合计 0 缺失；33 个唯一目标可在文件系统追溯。
- HTML：统一入口、架构 2 份、A/B/C 总览与三方向、remote integrated preview，共 8/8 由标准库 parser 解析通过。
- 脚本：A/B/C 共用 `preview.js` 通过 `vm.Script`；remote 4/4 inline scripts 通过；统一入口没有运行时脚本。
- 图片：统一入口 16 张图片全部加载，0 broken；文件类型与尺寸确认 A/B/C 9 张为 JPEG 内容的 390×844 `.png`，overview 为 1280×720，三张 Phase 1 副本尺寸分别为 390×844、360×800、390×844。
- 390×844 浏览器：document `390/390`、body `390/390`，8 个章节、证据边界与报告门禁可见。
- 360×800 浏览器：document `360/360`、body `360/360`；宽表和顶部章节导航仅在各自容器内滚动，不传播为 document 横溢出；console error/warning 为 `[]`。
- 浏览器链接抽查：架构 current-state、A 精密控制、remote provider workspace 均实际导航成功；Markdown 端点以 `text/markdown` 返回 HTTP 200。

独立视觉运行时证据（移动美术总监在草案前先行复跑）：

- A/B/C × 12 场景 × 390×844/360×800 = 72/72 PASS；每项均有标题、当前角色五栏、可点击控件、fact-note，document/body 无横溢出。
- A/B/C 各一条 `buyer/home → market → provider/workspace → resources → Back → Forward` 交互链 PASS；URL、标题、active nav 和 focus 一致。该证据仅属 HTML。
- A/B/C index/matrix console error/warning 为 `[]`；真实 reduced-motion 环境未模拟。
- remote provider 390/360 几何与 console 再测通过；fresh tab 视频因 autoplay policy 暂停，poster 与诚实文案可见；Phase 1 已批准证据覆盖 workspace play / 离开 pause。

独立复核：

- 移动美术总监：PASS，无阻断缺陷。独立确认入口 390×844/360×800 无页面级横溢出、16 张图片 0 broken、console `[]`；代表实开 architecture、A/B/C 场景、remote 393/360 和 poster；AC-03/04 表述与版本警示准确。
- 技术 verifier：PASS，无阻断缺陷。独立确认 107/107 本地链接、HTML 8/8、`preview.js` 1/1、remote inline scripts 4/4、36 个矩阵深链接、版本边界与 RN/HTML、143/121 边界。
- 保护面：`/tmp/zod-phase2-protected-before.sha256` 共 13,649 项，独立 verifier 核验 13,649/13,649 PASS；原始独立源树无 Git 元数据，因此不编造 Git diff。

报告 `:3` 已获妈妈批准；没有待修复缺陷。

## 11. 已验证事实、推断与未验证项

### 已验证事实

- Phase 1 AC-01、AC-02、AC-06、AC-07 已获妈妈批准。
- A/B/C 共用 12 场景和两角色五栏；代表截图为 9 张 390×844，不存在 36 张或 360 截图集。
- 当前 provider HTML SHA、design HEAD、当前 origin/main 和 dirty 状态可追溯。
- 原始独立源树不是可识别 Git 工作树，不能为其编造 commit。

### 推断

- 链接、浏览器和两次独立复核均已通过；本入口具备作为 AC-03/04/05 统一候选验收载体的证据。

### 未验证 / 非覆盖

- 真实 RN UI、真实设备性能、运行时 payload/auth/backend。
- 实际 OS reduced-motion。
- A/B/C 的 360 截图集。

## 12. 审批门禁

妈妈已批准 `01a02b2b-c34f-7ce2-9f03-d7af11a121af:3`。该批准不进入任何真实 UI、发布、部署或生产阶段。
