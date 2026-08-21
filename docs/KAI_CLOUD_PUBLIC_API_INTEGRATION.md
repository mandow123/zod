# KAI Cloud 公共 API 接入基线

状态：阶段 2 沙箱契约；生产默认关闭
上游参考：[`mandow123/cloud-`](https://github.com/mandow123/cloud-) 的 `docs/contracts/kai-cloud-public-v1.openapi.yaml`，commit `c30f38cadc7f9030c8fb59fbf91c6182d9d4cb9c`，Git blob `70b0bc523d92706a16f5633510c68371e005f51e`；KAI Cloud API v1.0，2026-08-20
本文件只保留脱敏后的接口结论，不复制群内原始文档。

## 结论

KAI Cloud v1.0 描述的是同源网站内部接口。它使用 HttpOnly `SameSite=Strict` Cookie、`Origin` 与 CSRF，且明确禁止外部系统依赖管理员、Host Agent、测试、旧交易或默认关闭的 Hosting V2 接口。因此移动 App 和本项目 backend 均不得把这些路径当作公共 API。

正式数据流固定为：

```text
KAI CloudPay App -> 本项目 backend -> KAI Cloud /api/public/v1
受信任 Sidecar/Agent -> 设备签名注册与心跳接口
KAI Cloud -> 签名 Webhook -> 本项目 backend
```

## 所有权与映射

| 领域 | 本项目 | KAI Cloud 公共接口 | 规则 |
|---|---|---|---|
| 当前交易主体 | 登录、组织切换、权限检查 | `organizationReference` | 只传不透明引用；客户端传值不能提升权限 |
| 资源草稿与材料 | 流程、自动保存、材料审核 | `resourceReference` 与脱敏规格 | 不传资产原始编号、证据地址或临时下载链接 |
| 在线验证 | 保存请求、显示状态、审计 | `resource-verifications` | KAI Cloud 是外部验证结果事实源 |
| 节点接入 | 本地认领和恢复体验 | `devices` / Agent 协议 | 私钥只在 Agent；App 不转发或保存 |
| 交易与结算 | 保持现有卡时闭环 | 不在本批接入 | 不开启 Hosting V2、自动成交或卡时扣减 |

现有网站 `/api/v2/supply/agent-challenges`、`/api/v2/agent/*`、管理员接口与旧 `/api/v1/orders/*` 仅用于差异参考，不作为依赖。

## 安全契约

- 使用 OAuth 2.0 Client Credentials，token endpoint 为 `/api/public/v1/oauth/token`，并按操作最小授权：本项目 backend 仅申请 `resource:read verification:write`；Sidecar/Agent 使用独立凭据申请 `agent:write`。
- OAuth client secret 与 Webhook secret 独立，均只由服务端密钥系统注入。
- Agent challenge 受 OAuth `agent:write` 保护；设备注册 `registerSignedDevice` 不使用 OAuth，而是一次性 challenge 加 Ed25519 证明；设备心跳 `recordSignedDeviceHeartbeat` 不使用 OAuth，而是注册设备密钥和单调 `sequence`。
- 写入携带 16–128 位 `Idempotency-Key`；同键异载荷返回 409。
- Webhook 使用 `x-kai-delivery-id`、Unix 秒时间戳与 `sha256=HMAC(secret, timestamp.rawBody)`；允许时钟偏差 5 分钟。
- 未配置、401/403、超时、503、签名错误或无效响应均 fail-closed，不产生“已验证”状态。
- 日志禁止记录 OAuth token、client secret、Webhook signature、Cookie、Agent 密钥和完整证据。

## 当前实现与启用门禁

- 合同定义：`docs/contracts/kai-cloud-public-v1.openapi.yaml`。
- backend 只在五项 `KAI_CLOUD_PUBLIC_*` 配置完整且安全时声明能力可用；该能力当前不进入生产 release readiness，也不会被环境变量单独变成交易就绪。
- App 始终通过 `/mobile/v1/provider/assets/:assetId/kai-cloud-verification` 访问，不直接调用 KAI Cloud。
- 生产启用前必须获得版本化 OpenAPI、沙箱 Client、Webhook 测试密钥、错误码目录、限流与弃用策略，并完成一台非生产节点的挑战、心跳、漂移、离线和撤销验收。
