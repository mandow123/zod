# KAI 吉祥物外部边界与状态综合预览

决策 ID：`ZOD-PHASE3-MASCOT-INTERFACES-R2`
状态：妈妈已确认的 HTML 设计证据；非 RN、未发布、未部署。

## 状态与边界矩阵

| 状态 | 路由/角色 | 吉祥物用途 | 事实边界 |
| --- | --- | --- | --- |
| arrival | 当前应用内路由 | 抵达提示 | 不表示业务数据已加载 |
| external-auth | 当前应用内路由 | 离开应用前的账号授权反馈 | 不打开真实授权页 |
| external-payment | 当前应用内路由 | 离开应用前的支付反馈 | 不发起支付、不打开支付页 |
| backend-service | 当前应用内路由 | 离开应用前的服务网站反馈 | 不访问网站、不连接服务 |
| offline-reconnect | offline | 离线/重连反馈 | 不发起网络请求 |
| failure-boundary | offline | 失败边界与回退提示 | 不声称修复服务端问题 |

应用内的买方/提供方底部五栏，以及 `orders`、`wallet`、`publish` 内部 route 均直接切换；它们不触发 KAI 组合反馈层。

## 已验证的静态自检（2026-08-24）

- HTML 解析：PASS；34 个唯一 id。
- 内联 JavaScript 解析：PASS。
- 原生可键盘操作控件：23 个静态控件（16 个按钮、4 个选择器、3 个链接）；运行时底部导航另生成 5 个原生按钮，合计 28 个。
- 6 个状态按钮、两种角色、三个内部 route 直接切换入口、三个外部边界入口、`pushState`、`popstate` 与 `prefers-reduced-motion` 均存在。
- 主栏归属规则已静态复核：提供方 `workspace → workspace`、`resources → resources`、`publish → assets`；买方及其他内部交易 route 均折叠到 `assets`。
- 角色切换、底部导航及内部 route 会记录 `旧角色/旧路由 → 新角色/新路由`，直接抵达并恢复标题焦点；源码未让这些入口调用 `enterExternal()`。
- 仅外部账号授权、外部支付、后端服务网站三类入口调用 `enterExternal()`，显示 K/A/I 相连的组合反馈；页面没有外链打开行为。
- `390×844` 与 `360×800` 是目标画布/设备预设；在更小浏览器中原型会自适应，未把它们宣称为每个运行环境的精确 DOM 尺寸。
- 12 个本地吉祥物资源路径存在；每一个可见状态均同时渲染相连的 K/A/I 三只，K/A 使用 `-v2`，I 仅使用 A2 `-v3`。
- 页面源码未发现外部网络 URL、`fetch`、`XMLHttpRequest` 或 `WebSocket`。

## 仍待独立浏览器复核

本环境对新 `file://` 预览的浏览器直接访问被 URL 安全策略拒绝，未绕过该限制。因此以下项目未在本岗位内宣称通过：

- 390×844 与 360×800 的页面级横向溢出；
- console errors/warnings；
- 六场景实际点击、Back/Forward 与标题焦点恢复；
- OS 级 `prefers-reduced-motion` 实际模拟与本地图片加载可视状态。

独立验证者应在本地浏览器直接打开 `index.html` 后复核以上四项。
