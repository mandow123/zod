# KAI 管理员后台生产运行手册

本手册用于首次发布、日常值班、密钥轮换、事故响应和回滚。所有命令在仓库根目录执行；不得把生产 Secret 写入命令行、工单、聊天、终端历史或日志。

## 1. 责任与变更控制

- 发布负责人：执行构建、迁移和发布门禁。
- 身份负责人：维护 auth.kai.com 管理员 Client、scope 和 Group。
- 安全复核人：独立核对 Origin、redirect URI、角色映射和 Secret 隔离。
- 值班负责人：观察登录失败、权限拒绝、Session 撤销和审计写入告警。

OIDC 注册、Group-role 映射、管理员 Secret、数据库迁移和生产开关均要求双人复核。禁止在事故处理中临时启用移动 Bearer、共享管理员密码或 legacy 管理路由。

## 2. 生产前置条件

### 2.1 OIDC 注册

管理员必须使用独立 confidential client：

- redirect URI 精确为管理员 API 的 HTTPS `/admin/v1/auth/callback`；
- 不得复用移动 Client ID、Client Secret 或移动 callback；
- scope 必须包含 `openid`，不得包含 `offline_access`；
- Group Claim 名和 Group-role 映射由身份负责人确认；
- 如果身份服务尚不能签发应用专用 Group Claim，可显式设置 `ADMIN_OIDC_GROUP_CLAIM=email`，
  并以经过验证的全小写完整邮箱作为精确角色白名单；必须同时请求 `email` scope，禁止域名、
  通配符、未验证邮箱或仅在单一 Token 来源出现的邮箱。提供方恢复专用 Group Claim 后应迁回 Group 模式；
- Token/JWKS/UserInfo endpoint 必须使用代码中固定的 auth.kai.com 合同；
- redirect URI 不允许通配符、query 或 fragment。

### 2.2 配置清单

以下变量通过生产 Secret/配置系统注入，只核对“存在、来源和版本”，不要输出值：

```text
ADMIN_AUTH_ENABLED
ADMIN_WEB_ORIGIN
ADMIN_API_ORIGIN
ADMIN_OIDC_CLIENT_ID
ADMIN_OIDC_CLIENT_SECRET
ADMIN_OIDC_REDIRECT_URI
ADMIN_OIDC_SCOPE
ADMIN_OIDC_GROUP_CLAIM
ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON
ADMIN_OIDC_FLOW_PEPPER
ADMIN_OIDC_SUBJECT_PEPPER
ADMIN_OIDC_GROUP_PEPPER
ADMIN_OIDC_TRANSACTION_ENCRYPTION_KEY
ADMIN_SESSION_TOKEN_PEPPER
ADMIN_CSRF_TOKEN_PEPPER
ADMIN_PII_ENCRYPTION_KEY
ADMIN_AUDIT_PEPPER
ADMIN_LOGIN_TRANSACTION_TTL_SECONDS
ADMIN_SESSION_IDLE_TTL_SECONDS
ADMIN_SESSION_ABSOLUTE_TTL_SECONDS
ADMIN_SESSION_ROTATION_SECONDS
ADMIN_SESSION_PREVIOUS_TOKEN_GRACE_SECONDS
ADMIN_REAUTH_FRESHNESS_SECONDS
```

首次部署先保持 `ADMIN_AUTH_ENABLED=false`。确认 Schema、路由、日志和监控后再单独变更为 `true`。

### 2.3 密钥规则

- 管理员所有 Secret 必须彼此不同，也必须不同于移动端和通用后端 Secret。
- Pepper 至少 32 个字符；加密密钥为规范 Base64 编码的 32 字节随机值。
- Secret Manager 权限只授予生产运行身份和受控轮换流程。
- 不允许通过 `.env` 文件上传、容器镜像层、CI 输出或 Kubernetes ConfigMap 保存 Secret。

## 3. 发布门禁

在目标提交构建后执行：

```powershell
Set-Location backend
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test -- test/config.test.ts test/admin-permissions.test.ts test/admin-schema.test.ts test/admin-stores-postgres.test.ts test/admin-audit-postgres.test.ts
npm test -- test/kai-oidc-core.test.ts test/kai-oidc.test.ts
npm run build
Set-Location ..
node backend/scripts/verify-admin-boundary.mjs --root .
Set-Location backend
npm run contract:verify
npm run deployment:verify
```

还必须运行管理员 auth-service、routes、Cookie、CORS、CSRF、并发轮换和日志捕获专项测试。任何跳过项都要记录负责人、原因、风险接受人和补测截止时间；安全边界脚本、迁移链和日志脱敏测试不允许跳过。

检查工作树，确认发布只包含审核过的文件。不得使用 `git clean`、`git reset --hard` 或覆盖并发改动。

## 4. 数据库发布

1. 验证备份可读取并完成一次隔离恢复演练。
2. 运行完整迁移 readiness，确认 0060 顺序和校验和正确。
3. 执行迁移；确认六张 `admin_*` 表（包括 Session Token registry）为空或仅含批准数据。
4. 验证审计不可变触发器拒绝 UPDATE/DELETE。
5. 确认没有预置管理员、角色或 Session。
6. 迁移失败时停止应用发布，不手工创建弱化约束的替代表。

0060 为前向兼容安全 Schema。应用回滚时默认保留空表和数据，不反向删除迁移。

## 5. 分阶段启用

### 阶段 A：代码上线、认证关闭

- 保持 `ADMIN_AUTH_ENABLED=false`。
- 验证移动 health/readiness、移动登录、订单和结算合同不变。
- 验证 `/admin/v1` 未错误接受移动 Bearer。
- 检查日志管道已对 query、Cookie、Authorization 和 Set-Cookie 脱敏。

### 阶段 B：配置校验

- 注入管理员配置和 Secret，仍保持开关关闭。
- 使用不打印变量值的生产环境验证器确认 readiness。
- 双人核对管理员 Web Origin、API callback origin、Client ID 标识、scope 和映射版本。

### 阶段 C：小范围启用

- 设置 `ADMIN_AUTH_ENABLED=true` 并滚动发布一个实例。
- 确认 readiness 中 `adminAuth.available=true`，且响应不含 Secret 或 Group。
- 使用专用测试管理员完成一次登录、`/auth/me`、登出和全部登出。
- 检查审计数量和稳定 action，不查看或输出敏感值。
- 扩容前观察至少一个登录事务 TTL 周期。

### 阶段 D：全量

- 逐步扩大实例比例。
- 验证负载均衡不需要粘性 Session；状态必须完全在 PostgreSQL 中。
- 确认所有实例使用同一版本的权限定义和同一组 Secret 版本。

## 6. 生产 Smoke Test

使用真实浏览器和最低权限测试账号：

1. 从管理员 Web 发起登录，确认只跳转到固定 auth.kai.com authorization endpoint。
2. 完成登录，确认浏览器中只有固定 `__Host-` 管理员 Cookie，且属性正确。
3. `/admin/v1/auth/me` 返回预期最小角色和权限，不返回邮箱、subject、Group 或 Token hash。
4. 使用错误 Origin、无 CSRF 和错误 CSRF 调用写端点，均应 403。
5. 使用移动 Bearer 调用管理员端点，应 401；管理员 Cookie 调用移动端点不能产生管理员权限。
6. 等待或测试缩短的轮换窗口，验证并发请求不导致 Cookie 回退、误登出或绝对 TTL 延长。
7. 登出后原 Cookie 立即失效；全部登出使同一身份的其他浏览器 Session 失效。
8. 停用测试身份或移除 Group，现有 Session 立即失败关闭。
9. 在日志和审计中搜索本次专用 canary 标识，确认不存在 code、state、Cookie、原始 Group 或 provider 描述。

禁止使用生产 Secret 作为 canary 搜索字符串。

## 7. 监控与告警

至少建立以下指标和告警：

- 登录开始、成功、拒绝、失败的速率与比例；
- transaction invalid、binding mismatch、nonce、issuer、subject mismatch；
- Group Claim missing/invalid/mismatch、零映射角色；
- Session stale、UA binding、授权快照失效和 CSRF 拒绝；
- 审计 append 延迟和失败；
- auth.kai.com Token/JWKS/UserInfo 超时和非成功响应；
- 管理员路由 401/403/429/5xx；
- 活动 Session 总量、异常增长和全部撤销次数；
- 管理员数据库连接、Schema readiness 和迁移校验。

告警内容只包含稳定错误码、计数、服务端 request ID 和时间，不附带请求 URL 查询串或上游正文。

## 8. 常见故障处理

### OIDC 不可用

1. 确认固定 endpoint 的网络、TLS、DNS 和 auth.kai.com 状态。
2. 保持已有 Session 的本地校验；不得绕过登录验证签发新 Session。
3. 若错误率持续升高，关闭管理员认证入口并通知管理员，不切换到移动认证。
4. 恢复后使用测试身份完成全流程并检查审计。

### Group 映射异常

1. 立即冻结映射变更；必要时设置 `ADMIN_AUTH_ENABLED=false`。
2. 对比批准的映射版本，不在日志或工单粘贴原始生产 Group 列表。
3. 修复后重新登录触发原子同步，并验证 authz_version 增加和 Session 撤销。
4. 查询审计中的角色代码和变更标记，不查询原始 Group。

### 审计写入失败

1. 将其视为认证/管理操作不可用事故，而不是可忽略的观测故障。
2. 关闭管理员认证或阻止高风险操作。
3. 检查数据库连接、容量、触发器和权限。
4. 确认失败期间没有留下可用但无成功审计的 Session。
5. 恢复后执行不可变性和摘要一致性测试。

### Session 或 Cookie 异常

1. 检查实例权限定义版本和 Secret 版本是否一致。
2. 检查负载均衡 HTTPS、Host、代理头和 Cookie 属性，不降低 Secure/SameSite/HttpOnly。
3. 若怀疑 Session Token 泄露，轮换 Session/CSRF Pepper 并撤销全部管理员 Session。
4. 执行并发轮换测试，确认旧响应不会覆盖新 Cookie。

## 9. Secret 轮换

不同 Secret 的轮换影响不同，不能统一原地替换：

| Secret | 影响与步骤 |
|---|---|
| OIDC Client Secret | 与 IdP 协调双 Secret 或维护窗口；验证 Token exchange 后删除旧值 |
| OIDC flow pepper | 使所有在途 state/nonce/binding 失效；等待 transaction TTL 或通知重新登录 |
| OIDC transaction key | 旧在途 PKCE 无法解密；先关闭入口并等待 transaction TTL，再轮换 |
| Session/CSRF pepper | 使现有 Session 全部失效；先撤销 Session，再统一滚动全部实例 |
| Group pepper | Group/assignment 摘要变化并触发授权同步；监控 authz_version 和撤销量 |
| Subject pepper | 不能直接替换，否则同一 subject 会生成新身份；必须设计双版本查找和数据迁移 |
| PII encryption key | 必须提供密钥版本和受审计的重加密迁移，不能直接丢弃旧 key |
| Audit pepper | 会影响摘要可比性；使用明确 key version 并保留审计验证能力 |

轮换后运行边界脚本、认证回归、一次真实登录和日志脱敏检查。

## 10. 紧急关闭与回滚

紧急停止管理员入口的首选动作：

1. 设置 `ADMIN_AUTH_ENABLED=false`；
2. 滚动所有实例并确认管理员路由不可用；
3. 必要时在数据库撤销所有活动管理员 Session；
4. 保留 admin 表和审计事件，不删除迁移或证据；
5. 验证移动 API、移动 OIDC 和交易功能仍正常。

应用版本回滚必须满足：旧版本不会注册不安全的 admin 路由；权限定义和 Schema 兼容；部署后重新运行边界脚本。不得为快速恢复启用 refunds、disputes、invoices 或 Vast 管理路由。

## 11. 交班记录

每次发布或事故交班至少记录：

- 应用版本、迁移版本和权限定义版本；
- 管理员认证开关状态；
- OIDC Client/Group 映射/Secret 的版本标识，不记录值；
- 测试命令及真实结果；
- 活动告警、风险接受和后续负责人；
- 回滚点和最近一次备份恢复演练时间。
