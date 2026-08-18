# KAI CloudPay 生产运行与灾备手册

本手册面向生产值班人员。目标是数据库恢复点不超过 1 小时（RPO ≤ 1h），确认事故后 60 分钟内恢复核心交易查询（RTO ≤ 60m）。任何恢复都先在隔离环境演练，禁止直接覆盖现有数据库。

## 上线前门禁

1. 使用与生产 PostgreSQL 同主版本的 `pg_dump` 和 `pg_restore`。
2. 为备份单独创建 S3 凭证和 Bucket，禁止与用户证据、发票 Bucket 共用凭证。
3. Bucket 必须启用 Object Lock；脚本使用 `COMPLIANCE` 模式并按 `BACKUP_RETENTION_DAYS` 设置不可变保留期。未启用时上传会失败关闭。
4. `BACKUP_ENCRYPTION_KEY` 必须是 32 字节随机值的 Base64，存放在密钥管理系统，不得写入仓库、镜像或日志。
5. 每次轮换密钥同时更新 `BACKUP_KEY_ID`，旧密钥至少保留到对应备份全部超过保留期。
6. `BACKUP_LOCAL_DIRECTORY` 必须为绝对路径，权限仅限运行账户；成功上传后本地副本会删除。
7. 生产发布前执行 `npm run db:migrate`，确认 readiness 的 `backup` 与 `observability` 均为 `true`。
8. Zod App 使用 `auth.kai.com` 公共 client `xUTgWjuzpAz-JT-wDbTJxh9xoh3ssU7K` 和 PKCE，固定回调为 `https://cloud.kai.com/zod/oauth2redirect/kai`；APK 不得包含 secret。旧 CloudPay confidential broker 不得作为生产登录入口。
9. 实测 access token 为 opaque，初次 exchange 与 refresh 的新 ID token 均包含 `at_hash=base64url(SHA-512(access_token) 左半32字节)`。设置 `KAI_RESOURCE_ACCESS_TOKEN_FORMAT=opaque`；每个资源 API 请求必须同时携带 opaque Bearer 与 `X-KAI-ID-Token`。上线前验证后端严格校验 ID token 的 EdDSA、issuer、Zod audience、期限、`at_hash`，并以当前 Bearer 实时调用 userinfo 且 `sub` 一致。两头缺一、重复、错配、撤销、非 JSON 或超时均应在业务事务前返回 401。刷新必须原子替换 access/refresh/id 三件套，缺新 ID token 即失败关闭。
10. 密钥系统还必须注入 `KAI_OIDC_SUBJECT_PEPPER`。它用于长期 issuer+sub 身份键且兼容既有映射，不得直接轮换；需要轮换时先在隔离库演练 subject 哈希迁移，再双读/回填并核对身份数量，禁止只换环境变量。
11. 实物商品唯一主数据为 `02672000-0000-4000-8000-000000000200`：`NVIDIA DGX Spark`、200 台、供应商展示名仅该 SKU 使用“白鸽在线”、含税原价 ¥40,750、售价 ¥32,600（8 折）、预计 90 天发货。生产可展示但必须保持 `pending_activation`；只有绑定真实供应商交易主体、完成法律资料摘要核验并激活公司收款档案后，才能切换为 `active` 并被用户购买。本地演示数据不得覆盖这一状态、价格、库存或主数据 ID。

## 自动备份

由调度器每小时执行一次，禁止并发：

```bash
npm run db:backup
```

脚本会：

1. 使用 `pg_dump` custom 格式和一致性快照读取数据库。
2. 在数据离开进程前使用 AES-256-GCM 流式加密，不生成明文临时文件。
3. 对完整密文计算 SHA-256，并再次解密验证认证标签。
4. 上传到独立 S3 Bucket，开启服务端加密和 Compliance Object Lock。
5. 成功后写入 `backup_runs` 和不可变审计事件，再删除本地密文。

监控必须满足：过去 24 小时至少一次成功备份，任何失败立即告警。建议每天保留小时备份 35 天；更长期归档通过 Bucket 生命周期另行配置，但不得缩短 Object Lock 保留期。

## 下载与检查备份

从备份 Bucket 下载对象时，同时从 `backup_runs` 取得 `encrypted_sha256_digest`。检查文件头和密文摘要：

```bash
npm run db:backup:inspect -- --input /absolute/path/cloudpay-postgres-....kcpb
```

输出包含：

- `databaseFingerprint`：来源数据库指纹；
- `keyId`：需要从密钥管理系统取用的密钥版本；
- `schemaVersion`：备份时最后一条数据库迁移；
- `sha256Digest`：恢复前必须与 `backup_runs` 记录一致。

读取文件头不需要解密密钥，但不能代替完整认证验证。

## 恢复演练

恢复目标必须是新建且 `public` schema 内没有任何表、视图或序列的空数据库。先配置目标 `DATABASE_URL`，再取得目标指纹：

```bash
npm run db:fingerprint
```

由密钥管理系统注入正确的 `BACKUP_ENCRYPTION_KEY`，然后设置四项显式确认：

```bash
export RESTORE_EXPECTED_SHA256='sha256:...'
export RESTORE_CONFIRM_SOURCE_FINGERPRINT='来源指纹'
export RESTORE_CONFIRM_TARGET_FINGERPRINT='目标指纹'
export RESTORE_CONFIRM_KEY_ID='备份 keyId'
npm run db:restore -- --input /absolute/path/cloudpay-postgres-....kcpb
```

恢复程序按以下顺序失败关闭：

1. 校验密文 SHA-256；
2. 完整解密一遍并验证 GCM 认证标签，不向数据库写入；
3. 再次确认目标数据库为空；
4. 使用 `pg_restore --single-transaction --exit-on-error` 原子恢复；
5. 核对迁移版本、容量总账、订单金额、重复成功付款、退款上限，以及卡时验收、协商退款、平台裁定退款、验收后售后退款和提供方结算凭证与双分录的一致性；
6. 写入 `restore_drills` 与不可变审计事件。

任何一步失败都不得切换流量。恢复后的服务先只读验证，再运行 API 冒烟测试，最后才更新流量入口。

## 演练频率与值班动作

- 每月至少执行一次完整恢复演练；`restore_drill_succeeded_90d` 必须持续大于 0。
- `backup_failures_24h > 0`、`backup_succeeded_24h = 0` 或 `cloudpay_operational_health < 2` 立即通知值班人员。
- 支付、退款或备份死信不得通过直接改数据库“修复”，必须通过运营补偿流程和审计事件处理。
- 事故期间保存请求 ID、对象键、支付渠道流水号和时间窗口；不得在工单或群聊粘贴手机号、令牌、数据库地址或密钥。

## 灾难切换后的验收

1. `/mobile/v1/health` 返回 200。
2. `/mobile/v1/readiness` 返回 200 且 blockers 为空。
3. `/internal/metrics` 能被监控口令抓取，所有 dead-letter 指标为 0。
4. 使用专用主站账户从 App 打开系统浏览器登录，确认回调只到 `kaicloudpay://auth/kai/callback`、首次登录写入当前用户协议与隐私版本，并能浏览挂牌、创建及取消未确认的卡时订单。
5. 确认生产 `/mobile/v1/auth/otp/request` 和 `/mobile/v1/auth/otp/verify` 对 `login/register` 返回 410，且 APK 中不存在 OIDC client secret 或 auth.kai.com token。
6. 在充值沙箱完成一次人民币充值，确认人民币只换入卡时；再完成一笔算力订单的接单、交付和验收。
7. 将专用测试订单推进到结算到期时间，确认待结算卡时扣除手续费后只转入提供方独立的“可兑付供应收益”账户一次，且订单、凭证和双分录金额完全一致。再用只含充值卡时的账户申请兑付，必须失败；充值、退款和平台赠送均不得计入可兑付供应收益。
8. 完成一笔验收前的协商全额退款，确认卡时退回买方、容量恢复且提供方不能结算该订单。
9. 完成一笔退款申请升级与平台裁定，分别验证全额退款会恢复卡时和容量、驳回退款会恢复待验收且不移动卡时。
10. 验收一笔订单后，在 7 天保护期内提交售后全额退款：确认申请立即暂停结算，负责人同意后原订单卡时全部退回买方，提供方待结算余额归零，已经消耗的容量仍保持已售。
11. 验证私有证据和发票下载地址仍为短时签名且越权账户返回 404。
12. 确认移动端当前最低支持版本和 API 兼容版本后再恢复全部流量。
