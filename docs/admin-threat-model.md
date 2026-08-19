# KAI 管理员后台威胁模型

状态：上线前安全基线

适用范围：`/admin/v1`、管理员 Web、KAI OIDC 管理员 Client、`admin_*` 数据表

不适用范围：移动端账户认证、移动 Bearer Token、旧 operator API、退款/争议/发票/Vast 管理功能

## 1. 安全目标

管理员系统必须同时满足以下不变量：

1. 管理员身份永远不能由移动端 `AccountPrincipal`、移动 Bearer Token 或 `users.role` 推导。
2. 只有独立管理员 OIDC Client 签发、通过 issuer/audience/azp/nonce/PKCE 校验的登录才能建立管理员 Session。
3. 上游 Group Claim 只能经显式白名单映射到固定角色；原始 Group 不得写入日志、审计或数据库。
4. 管理员 HTTP 鉴权只接受固定 `__Host-` Cookie，不接受 Authorization/Bearer。
5. 所有有副作用的管理员请求必须同时通过精确 Origin 和 CSRF 校验。
6. 每个请求重新计算当前有效角色和权限；角色自然过期、身份停用、授权版本或权限定义变化必须失败关闭。
7. Session Token、CSRF、state、nonce、浏览器绑定只以独立密钥的 HMAC 保存；PKCE 和 PII 只保存认证加密密文。
8. OIDC code、state、nonce、Token、Cookie、Secret、PKCE、原始 Group 和自由文本错误不得进入应用日志或审计。
9. 管理员认证默认关闭。开启但配置、数据库 Schema 或审计能力不安全时，服务不得提供管理员路由。
10. legacy refunds/disputes/invoices 和 Vast 不得借管理员路由重新启用。
11. Session Token 必须在 current/previous 两种状态与所有 Session 之间全局唯一；过期 registry 只能由受控维护任务清理。

## 2. 资产与数据分类

| 资产 | 级别 | 主要保护要求 |
|---|---|---|
| OIDC Client Secret、Pepper、加密密钥 | 最高 | Secret Manager；不进仓库、日志、命令行和 readiness |
| Session Cookie、OIDC code、state、nonce、PKCE | 最高 | 短生命周期；只在内存/浏览器安全通道出现；日志绝对脱敏 |
| 管理员角色、权限、身份状态 | 高 | 强一致授权、可审计、并发安全 |
| 管理员邮箱 | 高 | AES-256-GCM 密文；查找只使用独立 HMAC |
| 原始 Group Claim | 高 | 仅在单次回调内存中使用；不得持久化 |
| 审计事件 | 高 | 追加写、不可更新删除、稳定代码、最小化元数据 |
| display name、时间和稳定状态码 | 内部 | 长度/控制字符校验；按需返回 |

## 3. 信任边界

```text
管理员浏览器
  | HTTPS + __Host Cookie + exact Origin + CSRF
  v
管理员 API (/admin/v1)
  | fixed endpoints + confidential client + PKCE
  v
auth.kai.com OIDC

管理员 API
  | parameterized SQL + transactions
  v
PostgreSQL admin_* tables

管理员 API --> append-only audit sink / application logs
管理员 API -X-> mobile AccountPrincipal / mobile Bearer authentication
```

反向代理属于信任边界的一部分：它必须保留真实 HTTPS、Host 和受控客户端 IP，限制请求头大小，且不能记录 OIDC callback 查询串。

## 4. 认证流程与安全断言

### 4.1 开始登录

- 后端生成高熵 state、nonce、PKCE verifier 和浏览器绑定 Token。
- 数据库只保存 HMAC；PKCE verifier 使用管理员专用事务密钥加密。
- return path 必须是站内绝对路径，禁止 scheme-relative、反斜杠、fragment 和控制字符。
- 浏览器绑定使用 `__Host-kai_admin_login`，必须带 `Secure; HttpOnly; SameSite=Lax; Path=/` 且无 Domain。

### 4.2 OIDC 回调

- 必须精确校验 `iss`、state、浏览器绑定和一次性事务，再兑换 code。
- Token endpoint、issuer、JWKS、算法、audience 和 redirect URI 均为固定合同。
- ID Token 必须校验 `sub`、nonce、iat、exp、aud；多 audience 时必须校验 azp。
- UserInfo 的 `sub` 必须和 ID Token `sub` 一致。
- ID Token 与 UserInfo 同时携带 Group Claim 时，两者规范化集合必须完全一致。
- 无映射角色、未知角色、异常 Group 类型、过长 Group 或停用身份全部拒绝。
- 回调无论成功失败都清除登录绑定 Cookie；失败只返回固定错误码。

### 4.3 Session

- 登录成功生成全新 Session Token，不能复用 state、code 或登录绑定，防止 fixation。
- Session Cookie 固定为 `__Host-kai_admin_session`。
- 数据库同时保存授权版本、权限定义版本和权限快照摘要。
- 每次请求校验身份状态、授权版本、当前有效角色、权限摘要、idle/absolute TTL 和 User-Agent 绑定。
- Token 轮换必须保证并发请求可预测，不能让旧响应覆盖新 Cookie，也不能延长绝对 TTL。
- 轮换竞争中的 stale `/auth/me` 必须返回固定 409 错误且不得包含 CSRF 或管理员资料；客户端最多重试一次。
- 高风险操作必须验证 `reauthenticatedAt` 未超过服务端 freshness 门槛；普通活动与 Token 轮换不得刷新该时间。

### 4.4 写请求

- 精确匹配管理员 Web Origin，包括 scheme、host 和 port。
- 同时验证与当前 Session 绑定的 CSRF Token。
- CORS 只回显固定管理员 Origin，并设置 `Access-Control-Allow-Credentials: true`。
- 不得把 CORS 当作 CSRF 防线；无 Origin、`null` Origin、相似域名均应拒绝写请求。

## 5. 威胁、控制与验证

| 威胁 | 控制 | 必须验证 |
|---|---|---|
| OIDC mix-up | 固定 issuer/endpoints/client/redirect；回调 `iss`；ID Token aud/azp | 错 issuer、client、aud、azp 全拒绝 |
| code 截获或重放 | confidential client、PKCE、state、绑定 Cookie、单次事务 | 并发回调仅一次成功 |
| nonce 重放 | nonce HMAC 与 ID Token nonce 常量时间比较 | 错/缺失/旧 nonce 拒绝 |
| Group 注入或提权 | Claim 类型/长度校验、双来源一致、角色白名单 | 未映射 Group 不产生任何角色 |
| Session fixation | 回调后生成全新独立 Token | 登录前 Cookie 不能成为登录后 Cookie |
| Session 窃取 | Secure/HttpOnly/SameSite、UA 绑定、idle/absolute TTL、轮换 | UA 变化撤销；过期边界拒绝 |
| CSRF | SameSite + exact Origin + synchronizer Token | 表单、错误 Origin、旧 CSRF 均拒绝 |
| 授权 TOCTOU | 每请求重算角色；authz_version；SQL 条件更新 | 并发撤权后请求失败 |
| Cookie 混淆 | 固定 `__Host-` 名、拒绝重复/畸形 Cookie | 重复安全 Cookie 失败关闭 |
| 日志泄密 | callback URL 查询串安全序列化；Header/Set-Cookie 脱敏 | 捕获日志扫描敏感标记为零 |
| 审计注入 | 稳定 action/status/error code；服务端 request ID；字段白名单 | 控制字符/自由文本/Secret 被拒绝 |
| 审计绕过 | 认证成功前审计；失败补偿撤销 Session | 审计故障不得留下可用 Session |
| SQL 并发竞态 | 行锁、事务、唯一约束、单调时间更新 | 并发 admission/role sync/rotation 测试 |
| 移动凭证越权 | 管理员路由不读取 Authorization；独立 Principal | 移动 Bearer 对所有 admin 路由均 401 |
| 功能越界 | 路由静态边界扫描 | legacy/Vast admin 路由为零 |
| 配置误开 | `ADMIN_AUTH_ENABLED=false` 默认；生产 readiness 失败关闭 | 缺任一配置无法启动 admin auth |

## 6. 日志与审计规则

应用日志允许记录：服务端 request ID、固定 action、固定 outcome、固定错误码、耗时和 HTTP 状态。禁止记录：

- 原始 URL 查询串，特别是 `/admin/v1/auth/callback`；
- Cookie、Authorization、Set-Cookie；
- OIDC Token/code/state/nonce、PKCE；
- Secret、Pepper、加密密钥；
- 原始 Group、完整邮箱、provider `error_description`；
- 任意未经白名单处理的上游响应或异常正文。

审计必须覆盖登录开始、回调成功/拒绝/失败、Session 绑定失败、授权快照失效、登出、全部登出、权限和敏感数据访问。审计失败时认证和高风险操作失败关闭。

## 7. 残余风险与上线前决策

- 当前追加写审计依赖数据库不可变触发器，尚未提供跨事件哈希链或外部 WORM；合规负责人必须明确接受或在上线前补齐。
- SameSite=Lax 不能替代 Origin/CSRF；所有新写路由必须复用统一保护器。
- User-Agent 变化会造成管理员重新登录；这是安全与可用性的显式取舍。
- 管理员 OIDC 依赖 auth.kai.com 可用性。中断期间不得降级到移动登录、共享密码或临时 Bearer。
- subject pepper、PII key 和 audit pepper 不能直接原地替换；轮换必须执行有版本的数据迁移方案。

## 8. 发布安全门禁

只有以下条件全部满足才能上线：

1. `verify-admin-boundary.mjs` 全绿；
2. 管理员认证、路由、Session 并发和日志脱敏测试全绿；
3. 移动 OIDC 和移动后端合同回归全绿；
4. 0058 在全迁移链和备份恢复演练中通过；
5. 生产 OIDC Client 的 redirect URI、scope 和 Group 映射经双人复核；
6. 日志捕获证明 callback code/state 和原始 Group 不出现；
7. 生产 Secret 仅由 Secret Manager 注入；
8. 回滚开关、值班告警和审计查询已演练。
