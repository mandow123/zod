# ZOD App 架构优化

## 基线与边界

本实现以 `origin/main@4a6236ec9bc3ae04f54713617a388f0b0aed7a6f` 为唯一父提交，在 `codex/architecture-optimization-20260824` 上逐 hunk 集成。该 main 相对先前批准基线 `a251c17cc2395ff98828b5f24e9641866c677a9e` 已有 447 个路径变化，因此旧 `App.tsx` 只作为语义参考，没有整文件复制。

本轮不修改 screen、backend、package/lockfile、tsconfig、主题、API、数据模型、错误文案、Inquiry Sheet、钱包 Sheet 或 `src/provider-next-navigation.ts`。两张询价 Sheet、Profile 钱包/support、七相 capability/user/subject、KAI OIDC 与 session 恢复、staging shell/banner、formal/staging 订单来源均保留在新 main 原生实现中。

## Typed navigation intent

`src/navigation.ts` 定义内部 `AppRouteKey`、五项 `PrimaryTabKey` 和唯一 ownership 映射。内部 route 继续渲染原页面；BottomNav 只接受五项主栏，通过 `primaryTabFor` 折叠当前内部 route：

- `credits / orders / workspace / resources / publish → assets`
- `creator → profile`

`src/core/app-navigation-intents.ts` 将工作台和消息入口翻译为 UI 中立的 `AppNavigationIntent`。`OrderSide` 随订单 intent 传递：工作台提供方订单为 `orders/provider`，提供方消息订单为 `messages/provider`，买方消息订单为 `orders/buyer`。

`App.tsx` 是唯一 intent 副作用执行器。`open-order` 先写入 `OrderSide` 与 `selectedOrderSource=formal`，再切 route 并加载正式订单。工作台用户动作保留一次 selection haptic；底栏、深链和通知不会新增震动。

提供方 offer 消息先同步进入内部 `publish` route，再请求 offer 状态。请求失败时仍停留 publish，并沿用“暂时无法打开 / 请稍后再试”的既有提示。

## 生命周期边界

`src/core/use-app-lifecycle.ts` 集中注册 Linking、AppState 与 Notifications：

- 初始 URL 与运行时 URL 共用 handled URL ref 和稳定 callback；
- URL 与最后通知响应的异步边界均检查卸载状态；
- Linking、AppState、Notifications 的 listener 都返回配对 cleanup；
- AppState 进入 active 时，App callback 仍执行 refresh、stored session reconcile 与 auth status restore；
- 通知只捕获 notification id 并沿用原消息打开链路，不新增触觉反馈。

KAI consent/cancel/retry、OIDC revocation retry、session publish/reconcile、StagingDemoShell、StagingEnvironmentBanner 及认证状态条均留在 `App.tsx` 原有边界，没有被生命周期抽取改变。

## 证据边界

Node 测试验证 pure intent、生命周期注销/晚到事件保护、订单 side、导航 ownership、询价与钱包静态锚点。TypeScript 验证移动端类型。静态 mobile/backend contract 只证明客户端 method/path 能匹配后端注册路由，不证明运行时服务、权限、payload 或生产可用性。

`architecture-previews/current-state.html` 与 `target-state.html` 是自包含架构说明，不是产品视觉候选、最终美工稿或发布授权。真实性能收益仍需真实设备 profiling；本轮不声称帧率或启动耗时改善。
