# KAI CloudPay：最终 APK 整合候选与备案门禁（2026-08-25）

## 交付状态

这是本地集成源码与**测试候选**说明，不是正式签名备案 APK。未生成 APK、未提取公钥或证书 MD5、未部署，也未提交任何备案订单。

## 已验证事实

| 字段 | 当前候选值 | 证据 | 状态 |
| --- | --- | --- | --- |
| 安装名 | `KAI CloudPay` | `app.json` | 已配置；待最终 APK 安装验证 |
| Android 包名 | `com.kaicloud.marketplace` | `app.json` | 候选，待产品确认及同一正式 APK 提取 |
| 图标 | `assets/icon.png`，1024×1024 青色 KAI 字标 | SHA-256 `179be7fc660ea246266f226b13efaf30e2461fb154ae74c0b23d8b3e27b7dfb0` | 已选 F1；待最终 APK 资源提取 |
| 移动 API / 支付回调 / OIDC 回调 | `https://api.kaicloudpay.com` | `app.json`、backend runtime constants | 候选；运维未就绪 |
| 官网和公开法务 | `https://kaicloudpay.com` | `app.json` | 候选；法务页面未就绪 |
| 外部身份 | `https://auth.kai.com/api/auth` | `app.json` | 候选；待实际授权流程验证 |
| 管理域 | `admin.kaicloudpay.com`、`admin-api.kaicloudpay.com` | 本文档边界 | 移动包不得直接访问 |
| 七象支付 | `api.payqixiang.cn` 的 external-browser/H5 边界 | 当前支付实现和产品合同 | 不是原生支付 SDK；最终链路未确认 |
| Seedance | 默认 `SEEDANCE_VIDEO_ENABLED=false` | backend config / route gate | 关闭时不注册服务、路由或外部调用 |

候选法务链接：`/legal/privacy`、`/legal/terms`、`/legal/third-party-sdks`、`/legal/permissions`、`/legal/account-deletion`；账户删除地址为 `/account/delete`，均以 `https://kaicloudpay.com` 为根。

## 直接访问/唤起的域名边界

| 类别 | 域名 | 备注 |
| --- | --- | --- |
| 移动业务 API | `api.kaicloudpay.com` | 候选生产 API；构建前必须可解析、TLS 正常且由实际 ECS/反代承载 |
| 法务与账户删除 | `kaicloudpay.com` | 仅候选公开页面 |
| 身份服务 | `auth.kai.com` | 外部身份服务，保持独立 |
| 支付 H5 | `api.payqixiang.cn` | 外部浏览器跳转；不表示原生 SDK 或最终支付机构 |
| 关闭的可选视频服务 | 配置的 Seedance API 基址 | 默认关闭，不应发起网络请求 |

`admin.kaicloudpay.com` 与 `admin-api.kaicloudpay.com` 不属于移动 APK 直接访问面。移动源码与预计 bundle 的受检范围（`App.tsx`、`src/**`、`app.json`、Expo/Metro 配置、plugins/modules）不得包含旧 `cloudpay.kai.com` 或上述管理域；历史部署脚本、测试记录与审计归档不进入移动 bundle，保留时必须明确为历史证据。

## SDK 与权限：构建前清单

当前 `package.json` 声明 Expo / React Native、`expo-auth-session`、`expo-crypto`、`expo-document-picker`、`expo-file-system`、`expo-haptics`、`expo-network`、`expo-notifications`、`expo-screen-capture`、`expo-secure-store`、`expo-video`、`expo-web-browser`、日期选择器和安全区域组件。该清单来自源码依赖，**不是最终 APK 的已提取 SDK 清单**；`expo-video` 对应的 Seedance 能力默认关闭。

`app.json` 显式阻止悬浮窗、外部/存储读写、开机广播、安装来源和第三方桌面角标等权限。最终 manifest、实际权限、第三方 SDK、source map 和网络域名必须从同一正式 APK 解包复核；当前没有该 APK，故均为待确认。

## 明确阻塞与唯一解除责任

| 阻塞 | 已知证据 | 唯一责任人 | 解除条件 |
| --- | --- | --- | --- |
| 生产 API/DNS/反代 | 2026-08-25 `api.kaicloudpay.com` 无 A/CNAME | 运维/阿里云管理员 | 提供 DNS、TLS、ECS 实例、公网 IP、部署和反代映射，并由独立检查确认 HTTPS 可达 |
| 法务页面 | 六个候选 HTTPS 地址 TLS 可验证但均 HTTP 404 | 法务/产品 | 发布可读页面并确认主体、SDK、权限、注销流程一致 |
| 正式签名 | 未发现可用正式签名 APK 或最终发布报告 | 发布负责人 | 在不生成或更换密钥的前提下提供既有正式签名条件 |
| 产品备案字段 | 分类、第二分类、语言、备注、是否对外提供 SDK 未确认 | 产品/法务 | 给出书面最终字段值 |
| 支付链路 | 未证明“七象 → BullCardPay → 上海汇付”映射或生效合同 | 商务/法务 | 提供真实链路映射和已签署、生效材料；此前不得认定最终支付机构/SDK |

BullCardPay/上海牛卡派资料仅是候选技术服务材料：外包备案编码 `W2301171907363941` 有效至 2027-01-15，上海汇付合作授权期限为 2026-03-11 至 2028-03-10；两者不等于支付牌照、支付能力保证或生效支付合同。

## 构建规则

可在测试签名条件下构建和安装验证的产物必须标为“非备案正式 APK”，不得据此提取或填报最终公钥、MD5、SDK、权限或备案字段。只有全部阻塞解除后，才可使用用户提供的既有正式签名条件构建同一份正式备案候选 APK，并从该 APK 提取包名、公钥、证书 MD5、安装名、图标、语言、权限、SDK 和域名清单。
