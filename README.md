# KAI CloudPay 移动端

这是 `kaicloudpay.com` 的独立原生移动端项目，位于桌面独立目录，不引用也不修改原网站工程。

产品结构采用移动端任务语言，而不是缩小网页版：

- 首页：算力雷达、市场脉搏、场景任务和交付时间线
- 市场：按训练、推理、地区和时段意图查看已核验资源档案；价格通过双审后生成卡时价
- 发布：需要算力、闲置变现、供应商入驻三条任务路径
- 消息：履约、市场和系统状态时间线
- 我的：账户会话、卡时闭环状态、隐私与数据用途

当前版本采用同一账号下的双视角导航：使用算力为 `首页 / 市场 / 订单 / 消息 / 我的`，提供算力为 `工作台 / 资源 / 上架 / 消息 / 我的`。两者一键切换且共用账号、主体、资源、订单和卡时账户。

## 数据边界

候选生产 App 从 `https://api.kaicloudpay.com` 读取公开健康状态、已验真资源目录、账户认证状态和发布准备状态；在运维与法务门禁闭合前，这不是可发布的生产声明。资源人民币直付与供应方自定人民币价格不属于产品模型，也不存在兼容入口。

正式版登录与 `cloud.kai.com` 共用 `auth.kai.com` 统一身份。App 只用系统浏览器打开登录页；密码和上游 Token 不进入 App，回调通过后端一次性登录码与设备 PKCE 换取 CloudPay 会话。本地 E2E 包保留隔离的本机验证码，正式包不提供短信登录/注册入口。

## 本地运行

```bash
npm install
npm run typecheck
npm run contract:verify
npm run android
```

## Android 构建

```bash
npm run prebuild:android
npm run release:key
CLOUDPAY_ANDROID_PACKAGE_NEVER_PUBLISHED=1 npm run build:apk:direct
CLOUDPAY_ANDROID_PACKAGE_NEVER_PUBLISHED=1 npm run build:aab:play
CLOUDPAY_ANDROID_PACKAGE_NEVER_PUBLISHED=1 npm run release:preflight
npm run release:smoke:android
```

PowerShell 使用 `$env:CLOUDPAY_ANDROID_PACKAGE_NEVER_PUBLISHED='1'` 设置同一项版本历史证明；构建脚本会自行选择 `gradlew` 或 `gradlew.bat`，渠道也不再依赖 shell 环境变量语法。

如果同包名曾在任一商店或测试轨道上传过，构建和预检都必须传入已用最高版本码；候选 `versionCode` 不高于该值时自动失败。若确认这个包名从未上传过，改为显式传入 `CLOUDPAY_ANDROID_PACKAGE_NEVER_PUBLISHED=1`。两项必须且只能选择一项，不能靠缺省值猜测。

`release:key` 首次执行会在 `~/.cloudpay-release` 创建 CloudPay 专用上传密钥。私钥和口令始终位于项目外，不进入源码仓库；仓库只保留可公开的上传证书。两个发布命令都强制使用该密钥。华为和国内 Android 构建不依赖 Expo/EAS；只有准备启用 Expo 推送时才传入 `CLOUDPAY_EAS_PROJECT_ID`，届时脚本会校验当前登录账号与项目绑定。正式签名和版本历史证明仍是发布门禁。本地 E2E 预览不要求这些正式身份。

`build:apk:direct` 生成国内直装版，保留支付宝/微信卡时充值、卡时购买和完整提供方上架闭环。`build:aab:play` 生成 Google Play 管理版：不包含支付宝/微信 SDK、充值入口或新增购买动作，但完整保留资源录入、审计补件、上架、接单、交付、售后和结算。

`contract:verify` 会逐项比对手机版实际请求与后端已注册路由。当前 Android 正式构建和后端部署打包都会先运行这道门禁；请求方式或路径有任何一处不同，均停止生成发布产物。

`release:preflight` 会校验 AAB 结构、包名、版本、目标 API、权限、签名证书、AAB 内实际嵌入的 Expo 项目 ID、正式 API、隐私政策、服务条款和独立账户删除页面，并把机器可读报告写入 `artifacts/release/android-release-report.json`。任何一项失败都禁止发布。

每次 Android 构建都会把当前主前端的源码指纹写入包内。预检会重新计算 App 入口、全部页面、Android 原生分发代码、插件、配置与锁定依赖的指纹；旧 APK/AAB 即使包名、签名和版本均合法，只要不是当前代码生成，也会以 `frontend_source_current` 失败，禁止误提交废弃前端。

`release:smoke:android` 会在唯一连接的安卓测试设备上执行正式 APK 冷启动，逐个打开五个主入口，保存截图和 UI 结构，并检查主前端指纹、渠道、接口环境、候选包与设备安装文件哈希、崩溃、Metro 依赖及致命日志。需要安装包时使用 `npm run release:smoke:android -- --install`；未通过候选包校验时安装动作不会发生。查看当前本地上架版统一使用 `npm run preview:android:provider`。

## Android 产物规则

- `artifacts/release/KAI-CloudPay-1.0.0-1-local-e2e.apk`：当前本地完整链路验收包，不得提交商店
- `artifacts/release/KAI-CloudPay-1.0.0-1-direct-cn.apk`：配置完整后重新构建的国内直装正式候选包
- `artifacts/release/KAI-CloudPay-1.0.0-1-google-play.aab`：配置完整后重新构建的 Google Play 正式候选包
- 同名 `.sha256` 文件：上传前的完整性校验值
- `artifacts/release/android-release-report.json`：发布门禁报告
- `artifacts/release/KAI-CloudPay-source-1.0.0.zip`：不含依赖缓存、构建目录和任何私钥的当前源码包
- `docs/cloudpay-upload-certificate.pem`：提交 Google Play 或校验签名所需的公开证书

旧 debug、preview、国内直装和 Google Play 候选物已移出项目，避免同包名旧前端被误装。补齐生产配置后必须重新构建；若启用 Expo 推送，再绑定真实 Expo 项目。仍以最新预检报告中的 `ready` 字段为唯一发布依据。

## 商店标识

- Android：`com.kaicloud.marketplace`
- iOS：`com.kaicloud.marketplace`
- URL Scheme：`kaicloudpay://`
- 当前版本：`1.0.0 (1)`
