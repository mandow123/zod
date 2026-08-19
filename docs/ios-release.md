# Zod iOS Release Runbook

## 外部前置条件

- 在 Expo/EAS 中把真实项目 UUID 配置为 `CLOUDPAY_EAS_PROJECT_ID`；不得使用示例 UUID。
- 在 Apple Developer/App Store Connect 创建与 `com.kaicloud.marketplace` 对应的 App ID 和应用记录，并由账号持有人管理证书、描述文件和 APNs key。
- `cloudpay.kai.com` 发布有效的 `apple-app-site-association`，包含该 App ID 和 `/mobile/auth/kai/callback`。
- 后端认证白名单必须同时精确接受 `https://cloudpay.kai.com/mobile/auth/kai/callback` 与 `kaicloudpay://auth/kai/callback`，完成一次性 code + App PKCE 交换。App 在 iOS 17.4+ 使用前者与 Universal Link，在 iOS 17.3 及以下使用后者；未知系统版本失败关闭到自定义 scheme。
- App Store Connect 隐私标签、年龄分级、支持 URL、隐私政策 URL、审核联系人和演示账号由业务/法务确认。
- 服务端在创建充值、算力订单、设备订单、Vast 订单和购买需求时校验 `app-store` 渠道。客户端已经失败关闭，但服务端校验仍是发布阻塞项。

## 构建与 TestFlight

1. 在干净分支确认仅包含本次移动端文件，且没有纳入用户未提交的 `backend/` 修改。
2. 使用满足 React Native 0.86.2 engine 要求的 Node 版本安装锁定依赖：`npm ci`。
3. 设置真实 `CLOUDPAY_EAS_PROJECT_ID`，运行 `npm run typecheck`、`npm test` 和 `npm run release:preflight:ios`。
4. 运行 `npx eas-cli build --platform ios --profile ios-preview`。Windows 可发起 EAS Build，但不能本地生成或签名最终 iOS 二进制。
5. 在真实 iPhone 安装 internal build，完整执行 [iOS smoke test](./ios-smoke-test.md)。
6. 生产候选使用 `npx eas-cli build --platform ios --profile ios-production`；确认版本和 buildNumber 未被已上传构建占用。
7. 由获授权人员使用 `npx eas-cli submit --platform ios --latest` 或 App Store Connect 上传。此仓库流程不会自动提交，也不会创建或替换 Apple 凭证。
8. TestFlight 内测通过后，再开启外部测试；认证、通知、文件上传、已有订单履约、注销和商业边界必须全部通过。

## App Store 提交说明

建议审核备注：

> Zod 是免费的企业算力账户与履约伴侣。iOS 版本可浏览资源目录、查看和履行已有订单、处理售后、消息、账户安全及供应商经营资料。iOS 版本不提供充值、不创建新的算力或设备订单，也不引导用户前往网页购买。登录在系统认证会话中完成，使用一次性 code 与 PKCE，密码不会交给 App。

提交前确认：

- [ ] 名称 Zod、bundle ID、版本、buildNumber、图标、Splash 和仅 iPhone 纵向策略正确。
- [ ] `distributionChannel=app-store`、`nativeTopupsEnabled=false`、`newOrdersEnabled=false`。
- [ ] 生产 HTTPS API、真实 EAS projectId、APNs、Universal Link 和兼容 scheme 均验证。
- [ ] 隐私政策 `https://cloudpay.kai.com/privacy`、协议 `https://cloudpay.kai.com/terms`、注销 `https://cloudpay.kai.com/account/delete` 可访问。
- [ ] App Privacy 答案与实际收集的数据、服务端保留策略和 Privacy Manifest 一致。
- [ ] 审核账号只能演示已有订单/供应商流程，不需要充值或购买。
- [ ] 出口合规声明与 `usesNonExemptEncryption=false` 一致。
- [ ] 截图和描述不出现充值、新购或外部购买引导。
- [ ] 客户端与后端均按 `app-store` 渠道阻止购买类 mutation。
- [ ] TestFlight 构建通过完整 smoke test，已记录设备、iOS 版本和构建号。
