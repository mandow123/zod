# 节点接入接口

节点接入由资源方账号发起，但所有节点标识、认领密钥、挑战值和失效时间均由后台生成。App 不得自行生成或伪造这些值。

## 资源方操作

1. `POST /mobile/v1/provider/assets/:assetId/node-claims`
   - 需要登录、当前主体的 `provider.resource.manage` 权限以及 `Idempotency-Key`。
   - 首次返回 `201`；同一请求安全重放返回 `200`，并恢复完全相同的认领密钥。
   - 响应禁止缓存。认领密钥只会出现在这一个响应中。
2. `DELETE /mobile/v1/provider/assets/:assetId/node-enrollments/:deploymentId`
   - 需要相同权限。
   - 必须携带认领响应返回的固定 `deploymentId`，只撤销这一代接入；旧请求重试不会断开后来重新接入的新节点。
   - 有挂牌、订单或交付任务时拒绝撤销。
   - 响应丢失后重试会返回 `replayed: true`，不会误报失败。

## 节点操作

1. `POST /node/v1/claims/:claimId/consume`
   - 使用 `Authorization: NodeClaim <token>`。
   - 请求体包含 Ed25519 公钥、签名、GPU 清单及策略/运行环境摘要。
   - 成功后返回后台生成的 node/binding 标识和心跳路径。
2. `POST /node/v1/nodes/:nodeId/heartbeats`
   - 每次心跳使用已登记的 Ed25519 密钥签名，后台时间作为接收时间。
   - 正常或精确重放返回 `200`。
   - 已验签但发现配置漂移的心跳返回 `202` 和 `readiness: checking`；这表示事件已被消费，节点应推进本地序列，不得无限重发同一事件。
   - 无效签名、过期时间、旧 boot 或序列冲突不会被消费。

所有接口均返回 `Cache-Control: no-store, private`。反向代理必须转发 `/node/v1/*`，不得记录 Authorization 或请求体。GPU 信息的可信边界见 `NODE_ENROLLMENT_TRUST_BOUNDARY.md`。
