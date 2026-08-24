# Zod staging sandbox

这是独立模拟交易环境，不会注册到生产 API 进程，也不连接生产数据库、支付、节点、对象存储或推送服务。

服务器 `54.46.95.112` 使用独立目录 `/opt/zod-staging-4187`。容器采用 host network，但应用只监听 `127.0.0.1:4187`，验收通过 SSH 隧道进行：

```sh
ssh -L 4187:127.0.0.1:4187 <staging-user>@54.46.95.112
```

`/etc/zod-staging-sandbox.env` 仅由服务器管理员创建，权限 `0600`，至少包含五个彼此独立的随机值（不小于 32 字节）：`STAGING_BUYER_TOKEN`、`STAGING_CREATOR_TOKEN`、`STAGING_OPERATOR_ACCESS_TOKEN`、`STAGING_SUPPLIER_TOKEN`、`STAGING_OPERATOR_CONTROL_TOKEN`。可运行 `sudo node backend/staging-sandbox/generate-env.mjs /etc/zod-staging-sandbox.env` 一次性生成；脚本拒绝覆盖既有文件且不会打印值。这些值不得提交、截图、写入 App 正式 bundle 或日志。测试装置只把对应的用户 token 写入 staging App SecureStore；运营控制 token 永不进入 App。

部署：

```sh
docker compose -f backend/staging-sandbox/docker-compose.yml build
docker compose -f backend/staging-sandbox/docker-compose.yml up -d
STAGING_BUYER_TOKEN='<从服务器安全读取>' node backend/staging-sandbox/verify.mjs
```

所有请求必须携带 `X-Zod-Client-Environment: staging` 与 `x-kai-e2e-session`。运营请求还要求映射到本地 operator/admin 的 session，并携带独立 `X-Zod-Staging-Operator-Token`。

## 供应商资源草稿（测试环境）

仅 seeded supplier 可访问以下私有接口：

- `POST /mobile/v1/staging/supplier/resource-drafts`
- `GET /mobile/v1/staging/supplier/resource-drafts?limit=20&cursor=...`
- `GET /mobile/v1/staging/supplier/resource-drafts/:id`
- `PATCH /mobile/v1/staging/supplier/resource-drafts/:id`

POST 与 PATCH 必须带 `Idempotency-Key`；PATCH 还必须带 `expectedVersion`。草稿始终返回
`status=draft`、`visibility=private`、`purchasable=false`、`allowedActions=[edit]`。即使
`completeness.complete=true`，也不会进入目录、订单、审核或发布流程。卡时拟定价使用
`KAI_CARD_HOUR_PER_GPU_HOUR` 且严格保留两位小数，不支持人民币字段或换算。
