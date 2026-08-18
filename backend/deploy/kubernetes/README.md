# Kubernetes 部署说明

这些清单是生产基线，不包含任何真实密钥。镜像字段故意使用不可拉取的域名和全零摘要，发布流水线必须替换为已扫描、已签名镜像的真实 `@sha256:` 摘要；禁止改成 `latest` 或其他可变标签。

## Secret 清单

`cloudpay-backend-secrets` 必须由云密钥管理服务或 External Secrets 创建，不要提交 YAML 明文。至少提供：

- `DATABASE_URL`
- `PII_ENCRYPTION_KEY`、`AUDIT_PEPPER`、`CURSOR_SECRET`（生产不得配置已退役的本地 HS256/refresh/OTP 凭据）
- `KAI_OIDC_SUBJECT_PEPPER`
- `SMS_ACCESS_KEY_ID`、`SMS_ACCESS_KEY_SECRET`、`SMS_SIGN_NAME`、`SMS_TEMPLATE_CODE`
- `ALIPAY_APP_ID`、`ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY`、`ALIPAY_SELLER_ID`、`TOPUP_ALIPAY_NOTIFY_URL`
- `WECHAT_APP_ID`、`WECHAT_MCH_ID`、`WECHAT_API_V3_KEY`、`WECHAT_PRIVATE_KEY`
- `WECHAT_MERCHANT_CERT_SERIAL`、`WECHAT_PLATFORM_CERT_SERIAL`、`WECHAT_PLATFORM_CERTIFICATE`
- `TOPUP_WECHAT_NOTIFY_URL`
- `PUSH_CREDENTIALS_JSON`
- `OBJECT_STORAGE_ENDPOINT`、`OBJECT_STORAGE_REGION`、`OBJECT_STORAGE_BUCKET`、`OBJECT_STORAGE_ACCESS_KEY`、`OBJECT_STORAGE_SECRET_KEY`
- `CLAMAV_HOST`
- `COMPUTE_PROVIDER_TOKEN`
- `NODE_GPU_FINGERPRINT_PEPPER`、`NODE_CLAIM_TOKEN_PEPPER`、`NODE_CLAIM_TOKEN_ENCRYPTION_KEY`
- `METRICS_BEARER_TOKEN`
- `BACKUP_ENCRYPTION_KEY`、`BACKUP_KEY_ID`
- `BACKUP_S3_ENDPOINT`、`BACKUP_S3_REGION`、`BACKUP_S3_BUCKET`、`BACKUP_S3_ACCESS_KEY`、`BACKUP_S3_SECRET_KEY`
- `LEGAL_ENTITY_NAME`、`UNIFIED_SOCIAL_CREDIT_CODE`、`SUPPORT_EMAIL`、`SUPPORT_PHONE`
- `PRIVACY_POLICY_URL`、`TERMS_URL`、`INQUIRY_TERMS_URL`、`ICP_FILING`、`APP_FILING`

TLS 证书使用独立的 `cloudpay-kai-com-tls` Secret。监控应从集群内访问 `cloudpay-backend.cloudpay.svc/internal/metrics`，该路径没有暴露在 Ingress。

Zod App 以公共 client `xUTgWjuzpAz-JT-wDbTJxh9xoh3ssU7K` 直接连接 `https://auth.kai.com/api/auth`，固定回调为 `https://cloud.kai.com/zod/oauth2redirect/kai`，APK 不包含 secret。资源 API 要求 `Authorization` 中的 opaque access token 与 `X-KAI-ID-Token` 成对出现：后端以 JWKS 验 ID token 的 EdDSA、issuer、Zod audience、期限及 `at_hash`，再用当前 access token 实时调用 userinfo 并强制两者 `sub` 相同。任何一步失败均在业务事务前返回 401；ID token 不能单独授权或作为 Bearer。`KAI_OIDC_SUBJECT_PEPPER` 是 issuer+sub 的长期稳定映射键，不能按普通轮换节奏直接替换；如需轮换，必须先完成数据库哈希迁移。旧 `KAI_OIDC_CLIENT_SECRET` broker 只为非生产兼容保留，不属于正式登录依赖。

算力履约的非敏感配置由 `cloudpay-backend-config` 提供：`COMPUTE_PROVIDER=sidecar-v1`、`COMPUTE_PROVIDER_URL`、`COMPUTE_ALLOCATED_ACCELERATOR_COUNT=1`、`COMPUTE_NODE_ACCELERATOR_COUNT=8` 和 `NODE_SUPPORTED_AGENT_VERSIONS=1.0.0`。每项资源优先使用验真通过的 `specifications.gpuCount` 作为槽位上限；该变量只为缺少结构化字段的旧实机提供受控回退，本节点固定为 8 张 H100，不得按挂牌数量或产品名称扩大。示例 URL 是集群私有 DNS 契约，部署时可以替换为实际的私网 HTTPS 地址，但禁止填写公网地址或降级为 HTTP。`COMPUTE_PROVIDER_TOKEN` 只能由 Secret 注入，必须与 H100 sidecar 使用的 bearer token 一致且至少 32 个字符；`NODE_GPU_FINGERPRINT_PEPPER`、`NODE_CLAIM_TOKEN_PEPPER` 与 `NODE_CLAIM_TOKEN_ENCRYPTION_KEY` 必须分别生成独立的生产密钥并由 Secret 注入。以上令牌和密钥不得写入 ConfigMap、镜像或仓库。

容器入口会在 API 进程启动前执行完整生产配置门禁。任何必填项、法务资料、材料存储、安全扫描、备份、推送、真实卡时充值渠道或算力 sidecar 配置缺失时，容器直接退出，不会以半可用状态等待流量。门禁只检查配置合同；开放流量前还必须由运维验证私网 TLS、令牌一致性和 H100 主机证明。

## 发布顺序

1. 构建 `linux/amd64,linux/arm64` 多架构镜像，生成 SBOM、漏洞扫描并签名。
2. 将三个清单中的占位镜像替换为同一个真实不可变摘要。
3. 创建或更新 Secret 与 ConfigMap。
4. 使用 `kubectl create -f migrate-job.yaml` 创建一次性迁移任务，并等待成功。
5. 应用 `app.yaml`，等待三个副本全部 readiness 成功。
6. 应用 `backup-cronjob.yaml`，手动触发一次备份并确认 `backup_runs` 成功。
7. 从不可变备份恢复到隔离空库，完成首次 `restore_drills` 记录后才开放正式流量。

迁移 Job 使用 advisory lock，可避免误触发的并发迁移；API 使用三副本、零不可用滚动升级和 PDB。所有容器均以非 root、只读根文件系统、无 Linux capabilities 和默认 seccomp 运行。

## 数据库版本

当前镜像基于 Debian Bookworm 的 PostgreSQL 15 客户端。生产数据库必须使用 PostgreSQL 15；备份和恢复脚本会比较服务端、`pg_dump`、`pg_restore` 主版本，不一致时失败关闭。如升级数据库，先更新镜像客户端并完成隔离恢复演练。

## 回滚原则

- 应用代码可以回滚到上一已签名镜像摘要。
- 数据库迁移禁止自动向下回滚或删除字段；先部署向后兼容迁移，再分阶段切换代码。
- readiness 失败时保持旧副本服务，不得绕过门禁强行把新 Pod 加入流量。
- 支付回调入口切换前后至少保留 24 小时双向核对，不能依赖客户端支付结果。
