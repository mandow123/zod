# ZOD 移动端美术选型记录（2026-08-24）

## 已确认的规则

- 全局信息骨架采用 **B 编辑流**：暖纸底、排版优先、留白与品牌语气。
- 提供方的状态、资源和异常反馈采用 **A 精密控制组件语法**：状态灯、网格与紧凑运营信息。
- 订单、钱包和资产详情采用 **C 信任凭证组件语法**：凭证、序列、核验与时间线。
- 这是一组分层使用规则，**不代表存在新的混合终选 HTML，也不代表 React Native 已实现**。

## 吉祥物决策

- 决策 ID：`ZOD-PHASE3-MASCOT-I`；I 使用妈妈已选择的 A2 深蓝圆顶礼帽 v3。
- K 与 A 保持 v2，不改动原有素材。
- 决策 ID：`ZOD-PHASE3-MASCOT-INTERFACES-R2`；应用内 buyer/provider 五栏及 `orders`、`wallet`、`publish` 等内部 route 直接切换，不显示吉祥物跳转层。
- 仅外部账号授权、外部支付、后端服务网站三类离开应用的边界显示连体 K → A → I 反馈；预览不联网、不打开外部目标。

## 证据入口与边界

本候选把来源提交 `0708bc377c75cd5ff4eac1ac6fea2a3419415fed`
（`design/mobile-preview-20260823`）的设计证据等价重放到架构提交
`321fe7e8c6415fb673b418ca410b917f41c5f373` 之上；不改变来源提交或
远端历史。

- 三方向设计证据：`design-previews/2026-08-23/index.html`。
- provider 媒体与导航设计证据：`design-previews/mobile-20260823/kai-mobile-v2-preview.html`。
- 吉祥物边界预览：`mascot-interface-preview/index.html`。
- 统一审阅入口：`unified-review/index.html`。

上述文件仅是设计与验收证据。真实 RN 美术重构、PR/合并、发布、部署和生产变更均不由本记录授权。
