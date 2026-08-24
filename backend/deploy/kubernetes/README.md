# 非当前生产入口：Kubernetes 参考模板

> 这不是 `cloudpay.kai.com` 当前上线门禁。当前唯一生产契约见 `deploy/direct-ubuntu/README.md`。

# Kubernetes 部署说明（参考）

这些清单是生产基线，不包含任何真实密钥。镜像字段故意使用不可拉取的域名和全零摘要，发布流水线必须替换为已扫描、已签名镜像的真实 `@sha256:` 摘要；禁止改成 `latest` 或其他可变标签。

本清单固定使用 `MOBILE_API_PROFILE=inquiry_only`。该 profile 只启动 KAI 配对身份、主体选择、上海鸿欢正式目录、买家询期、法务页与内部监控；支付、卡时、订单、上架、供应经营、运营、推送、节点和返佣能力不注册路由，也不构造 worker。

## Secret 清单

`cloudpay-backend-secrets` 必须由云密钥管理服务或 External Secrets 创建，不要提交 YAML 明文。至少提供：

- `DATABASE_URL`
- `PII_ENCRYPTION_KEY`、`AUDIT_PEPPER`、`CURSOR_SECRET`（生产不得配置已退役的本地 HS256/refresh/OTP 凭据）
- `KAI_OIDC_SUBJECT_PEPPER`
- `OBJECT_STORAGE_ENDPOINT`、`OBJECT_STORAGE_REGION`、`OBJECT_STORAGE_BUCKET`、`OBJECT_STORAGE_ACCESS_KEY`、`OBJECT_STORAGE_SECRET_KEY`
- `METRICS_BEARER_TOKEN`
- `BACKUP_ENCRYPTION_KEY`、`BACKUP_KEY_ID`
- `BACKUP_S3_ENDPOINT`、`BACKUP_S3_REGION`、`BACKUP_S3_BUCKET`、`BACKUP_S3_ACCESS_KEY`、`BACKUP_S3_SECRET_KEY`
- `LEGAL_ENTITY_NAME`、`UNIFIED_SOCIAL_CREDIT_CODE`、`SUPPORT_EMAIL`、`SUPPORT_PHONE`
- `PRIVACY_POLICY_URL`、`TERMS_URL`、`INQUIRY_TERMS_URL`、`ICP_FILING`、`APP_FILING`

管理员认证使用独立的可选 `cloudpay-admin-auth-secrets`。阶段 A 保持
`ADMIN_AUTH_ENABLED=false` 时该 Secret 可以尚未创建；启用管理员认证前必须由 External
Secrets 或同等受控流程创建，并至少提供：

- `ADMIN_OIDC_CLIENT_ID`、`ADMIN_OIDC_CLIENT_SECRET`
- `ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON`
- `ADMIN_OIDC_FLOW_PEPPER`、`ADMIN_OIDC_SUBJECT_PEPPER`、`ADMIN_OIDC_GROUP_PEPPER`
- `ADMIN_OIDC_TRANSACTION_ENCRYPTION_KEY`
- `ADMIN_SESSION_TOKEN_PEPPER`、`ADMIN_CSRF_TOKEN_PEPPER`
- `ADMIN_PII_ENCRYPTION_KEY`、`ADMIN_AUDIT_PEPPER`

真实邮箱或 Group-role 映射只能放在该 Secret 中，不能放入 ConfigMap、镜像或发布日志。
管理员 Web/API origin、精确 callback、scope、claim 名和 TTL 是
`cloudpay-backend-config` 中的非敏感发布合同。`ADMIN_AUTH_ENABLED` 在仓库基线中必须显式为
`false`，只有完成独立配置验证、监控和小范围验收后才允许单独变更。

移动端 TLS 证书使用独立的 `cloudpay-kai-com-tls` Secret。管理员入口分别使用
`cloudpay-admin-kai-com-tls` 和 `cloudpay-admin-api-kai-com-tls`，证书 SAN 与 Ingress host
必须精确对应 `admin.kai.com` 和 `admin-api.kai.com`。监控应从集群内访问
`cloudpay-backend.cloudpay.svc/internal/metrics`，该路径没有暴露在任何 Ingress。

短信、支付宝、微信、推送、恶意文件扫描、算力 sidecar、节点接入、Vast 和返佣配置不属于 inquiry-only 上线依赖；即使环境中误填，也不会实例化对应服务或 worker。只有未来经独立审计切换到 `full_commerce` 时，才按完整商城门禁重新配置这些渠道。

Zod App 以公共 client `xUTgWjuzpAz-JT-wDbTJxh9xoh3ssU7K` 直接连接 `https://auth.kai.com/api/auth`，固定回调为 `https://cloud.kai.com/zod/oauth2redirect/kai`，APK 不包含 secret。资源 API 要求 `Authorization` 中的 opaque access token 与 `X-KAI-ID-Token` 成对出现：后端以 JWKS 验 ID token 的 EdDSA、issuer、Zod audience、期限及 `at_hash`，再用当前 access token 实时调用 userinfo 并强制两者 `sub` 相同。任何一步失败均在业务事务前返回 401；ID token 不能单独授权或作为 Bearer。`KAI_OIDC_SUBJECT_PEPPER` 是 issuer+sub 的长期稳定映射键，不能按普通轮换节奏直接替换；如需轮换，必须先完成数据库哈希迁移。旧 `KAI_OIDC_CLIENT_SECRET` broker 只为非生产兼容保留，不属于正式登录依赖。

ConfigMap 中残留的算力 sidecar 非敏感字段仅用于保留未来 `full_commerce` 配置模板，在 inquiry-only profile 下不参与 readiness、服务实例化或 worker 启动，也不表示已有真实算力履约能力。

容器入口会在 API 进程启动前执行 inquiry-only 生产配置门禁。专用 PostgreSQL、0065、账号安全、KAI paired 身份、公开 HTTPS、真实法务配置、对象存储、监控、备份恢复或正式供应商目录任一不完整时，容器或 readiness 失败关闭；支付、短信、推送、算力、Vast、节点、broker 与返佣不会被误列为依赖。

## 发布顺序

1. 分别构建后端和管理员 Web 的 `linux/amd64,linux/arm64` 多架构镜像，生成 SBOM、漏洞扫描并签名。管理员 Web 必须以 `VITE_ADMIN_API_ORIGIN=https://admin-api.kai.com` 构建。
2. 将 `app.yaml`、`migrate-job.yaml`、`backup-cronjob.yaml` 和暂不应用的
   `admin-api-canary.yaml` 后端占位镜像替换为同一个真实不可变摘要；将 `admin-app.yaml` 替换为
   独立管理员 Web 摘要。
3. 创建或更新后端 Secret 与 ConfigMap；首次部署仍保持 `ADMIN_AUTH_ENABLED=false`。
4. 使用 `kubectl create -f migrate-job.yaml` 创建一次性迁移任务，并等待成功。
5. 应用 `app.yaml`，只等待 Pod 进程通过 startup/liveness；此时 readiness 必须保持关闭，不能绕过。
6. 应用 `backup-cronjob.yaml`，手动触发一次备份并确认对象键、大小、摘要和0065版本均完整。
7. 使用同一份有效备份恢复到数据库指纹不同的隔离空库，确认0065及全部账本不变量为零。
8. 通过临时 Secret 向同镜像的一次性受控 Job 注入 paired KAI 测试令牌，运行 `npm run production:readiness:record`。Job 的探针地址指向指定 API Pod 的私网地址；任务结束立即删除临时 Secret 与 Job，不把令牌写入清单、日志或长期环境。
9. 确认对象存储 Put/Head/Get/Delete/删除确认、真实身份 `/me`→同意→主体选择→正式询期→取消以及交易账本零变化证据已写入，再等待三个副本全部 readiness 成功，最后开放 Ingress 流量。
10. 应用 `admin-app.yaml`，等待两个 Web 副本通过 `/healthz` readiness，并核对两个管理员 Ingress 的 TLS host 与后端服务边界；管理员 API 仍保持关闭。
11. 确认 Prometheus 已抓取管理员指标后应用 `admin-monitoring.yaml`，并验证规则加载成功。

对象存储证据15分钟、KAI paired 成功链证据30分钟后自动过期。常规发布必须在窗口内完成流量验证；持续运行后的告警不应通过伪造审计行消除，而应重新执行受控 Job。未登录 `401` 只证明路由受保护，不能替代真实测试身份的成功链。

此时管理员 API Ingress 必须仍指向主 Service `cloudpay-backend`，主 ConfigMap 中
`ADMIN_AUTH_ENABLED=false`，因此 `/admin/v1` 失败关闭。`admin-api-canary.yaml` 不属于阶段 A
常驻资源，只能在完成 Secret、监控和双人复核后按下述阶段 C 顺序临时应用。

迁移 Job 使用 advisory lock，可避免误触发的并发迁移；API 使用三副本，管理员 Web 使用两副本，二者均采用零不可用滚动升级和 PDB。所有容器均以非 root、只读根文件系统、无 Linux capabilities 和默认 seccomp 运行。管理员 Web 仅把 Nginx 启动所需的配置、缓存、运行时和临时目录挂载为有大小限制的 `emptyDir`。

## 管理员监控

管理员指标继续通过集群内受 Bearer 保护的 `/internal/metrics` 暴露，不增加公网 Ingress。
`admin-monitoring.yaml` 提供基于真实数据库聚合的 `PrometheusRule`，应用前必须确认
Prometheus 已从 `cloudpay-backend.cloudpay.svc/internal/metrics` 成功抓取：

- `cloudpay_admin_login_events_24h{result="succeeded|denied|failed"}` 只有三个固定结果标签；
- `cloudpay_admin_security_denials_24h` 汇总固定的 Origin、Session、CSRF 和权限拒绝；
- `cloudpay_admin_operation_failures_24h` 汇总近 24 小时 `outcome=failed` 的管理员操作，不能把它解释为审计存储故障；
- `cloudpay_admin_audit_append_failures_total` 是无标签、按进程累积的真实审计 append 异常 counter；
- `cloudpay_admin_http_5xx_total` 是无标签、按进程累积的 `/admin/v1` 最终 5xx 响应 counter；404、401、403 和非管理员路径不会计入；
- `cloudpay_admin_active_sessions` 只统计尚未过期的 active Session；
- `cloudpay_admin_revoked_sessions_24h` 汇总近 24 小时撤销量。

这些指标不得包含邮箱、Group、identity/session ID、request ID、请求 URL 或任意错误正文。
数据库 gauge 在每个后端副本上值相同，告警使用 `max` 去重，不能跨实例直接求和；只有进程级
审计 append 与管理员 HTTP 5xx counter 使用 `sum(increase(...))` 聚合真实的各实例增量。
阈值必须结合批准的管理员人数和正常登录基线复核，但不得通过加入身份标签来区分人员。

## 数据库版本

当前镜像基于 Debian Bookworm 的 PostgreSQL 15 客户端。生产数据库必须使用 PostgreSQL 15；备份和恢复脚本会比较服务端、`pg_dump`、`pg_restore` 主版本，不一致时失败关闭。如升级数据库，先更新镜像客户端并完成隔离恢复演练。

## 回滚原则

- 应用代码可以回滚到上一已签名镜像摘要。
- 数据库迁移禁止自动向下回滚或删除字段；先部署向后兼容迁移，再分阶段切换代码。
- readiness 失败时保持旧副本服务，不得绕过门禁强行把新 Pod 加入流量。
- 支付回调入口切换前后至少保留 24 小时双向核对，不能依赖客户端支付结果。
- 管理员入口失败时先恢复 `ADMIN_AUTH_ENABLED=false` 并完成后端滚动更新。需要立即撤回公网入口时，只删除 `ingress/cloudpay-admin-web` 和 `ingress/cloudpay-admin-api`；不得删除或修改 `ingress/cloudpay-mobile-api`、后端 Deployment、数据库迁移或管理员审计数据。
- `admin-routing-contract.json` 是机器可读的管理员 host/path/TLS 与回滚边界，发布流水线必须通过 `npm run deployment:verify` 核对后再应用管理员 Ingress。

## 管理员路由 canary

管理员 Ingress 变更后，以当前开关状态运行独立 canary。报告路径必须是新的受控绝对路径；验证器使用不可覆盖写入，已存在的报告会使验证失败：

```bash
npm run production:admin-routing:verify -- \
  --web-origin https://admin.kai.com \
  --api-origin https://admin-api.kai.com \
  --auth-state disabled \
  --report /var/lib/kai-cloudpay-reports/admin-routing-disabled.json
```

设置 `ADMIN_AUTH_ENABLED=true` 并完成后端滚动更新后，将 `--auth-state` 改为 `enabled` 并写入另一个新报告。验证器检查管理员 Web 的 HTTPS 页面、`/healthz` 和安全响应头；检查未认证 `/admin/v1/auth/me` 在关闭时为本后端 `404 NOT_FOUND`、启用时为 `401 ADMIN_AUTH_REQUIRED`；还会探测管理员 Host 上的 mobile 与旧 API 路径，防止跨 Host 接管。

报告只包含固定路径、状态、Content-Type、安全检查布尔值和稳定错误码，不保存响应正文、请求或响应 Cookie、Token、query、request ID 或任意 Header 值。只有 `decision=keep_admin_routes` 才能保留管理员入口；`decision=remove_admin_routes` 时只删除 `ingress/cloudpay-admin-web` 与 `ingress/cloudpay-admin-api`，必须保留 mobile Ingress、后端 Deployment、数据库迁移和管理员审计数据。

### 阶段 C：隔离单副本

`admin-api-canary.yaml` 创建独立的单副本 Deployment 和 Service。它使用与主后端完全相同的
不可变镜像摘要、ConfigMap 和 Secret 来源，但以容器级 `env` 显式覆盖
`ADMIN_AUTH_ENABLED=true`；管理员 Secret 在该工作负载中不是 optional。其 Pod/Service selector
与 `cloudpay-backend` 不相交，禁止把 canary 标签加入主 Service selector。

严格按以下顺序执行，任何命令失败都停止，不得继续切换：

```bash
kubectl apply -f backend/deploy/kubernetes/admin-api-canary.yaml
kubectl rollout status deployment/cloudpay-admin-api-canary -n cloudpay --timeout=5m
canary_pod="$(kubectl get pod -n cloudpay -l app.kubernetes.io/name=cloudpay-admin-api-canary -o jsonpath='{.items[0].metadata.name}')"
test -n "$canary_pod"
test "$(kubectl exec -n cloudpay "$canary_pod" -- printenv ADMIN_AUTH_ENABLED)" = "true"
kubectl exec -n cloudpay "$canary_pod" -- node scripts/verify-production-env.mjs --admin-only
kubectl patch ingress cloudpay-admin-api -n cloudpay --type=json -p='[{"op":"test","path":"/spec/rules/0/http/paths/0/backend/service/name","value":"cloudpay-backend"},{"op":"replace","path":"/spec/rules/0/http/paths/0/backend/service/name","value":"cloudpay-admin-api-canary"}]'
npm --prefix backend run production:admin-routing:verify -- \
  --web-origin https://admin.kai.com \
  --api-origin https://admin-api.kai.com \
  --auth-state enabled \
  --report /var/lib/kai-cloudpay-reports/admin-routing-stage-c-enabled.json
```

Ingress 切换前必须核对 canary Deployment 与主 Deployment 的 `.spec.template.spec.containers[0].image`
完全相同；不得用标签、不同摘要或本地重建镜像替代。阶段 C 只有
`cloudpay-admin-api` 切到 canary Service，Web Ingress 与 mobile Ingress 均不得修改。

### 阶段 D：主后端全量启用

ConfigMap 的 `envFrom` 值只在进程启动时读取，修改 ConfigMap 本身不会触发 Pod 更新。必须显式
restart、等待 rollout，并在切回主 Service 前逐 Pod 运行管理员离线门禁：

```bash
kubectl patch configmap cloudpay-backend-config -n cloudpay --type=merge -p='{"data":{"ADMIN_AUTH_ENABLED":"true"}}'
kubectl rollout restart deployment/cloudpay-backend -n cloudpay
kubectl rollout status deployment/cloudpay-backend -n cloudpay --timeout=10m
main_pods="$(kubectl get pod -n cloudpay -l app.kubernetes.io/name=cloudpay-backend -o name)"
test -n "$main_pods"
for pod in $main_pods; do
  test "$(kubectl exec -n cloudpay "$pod" -- printenv ADMIN_AUTH_ENABLED)" = "true" || exit 1
  kubectl exec -n cloudpay "$pod" -- node scripts/verify-production-env.mjs --admin-only || exit 1
done
kubectl patch ingress cloudpay-admin-api -n cloudpay --type=json -p='[{"op":"test","path":"/spec/rules/0/http/paths/0/backend/service/name","value":"cloudpay-admin-api-canary"},{"op":"replace","path":"/spec/rules/0/http/paths/0/backend/service/name","value":"cloudpay-backend"}]'
npm --prefix backend run production:admin-routing:verify -- \
  --web-origin https://admin.kai.com \
  --api-origin https://admin-api.kai.com \
  --auth-state enabled \
  --report /var/lib/kai-cloudpay-reports/admin-routing-stage-d-enabled.json
kubectl delete -f backend/deploy/kubernetes/admin-api-canary.yaml --ignore-not-found
```

必须确认逐 Pod 循环至少运行一次，且 `kubectl rollout status` 成功。路由复验失败时先把 API
Ingress 切回仍在运行的 canary Service；只有阶段 D 新报告为 `decision=keep_admin_routes` 才删除
canary 清单。

### 紧急关闭的确定顺序

无论 API Ingress 当前指向主 Service 还是 canary，都先使主后端确定回到关闭状态，再撤回公网
入口并删除 canary。不能只修改 ConfigMap：

```bash
kubectl patch configmap cloudpay-backend-config -n cloudpay --type=merge -p='{"data":{"ADMIN_AUTH_ENABLED":"false"}}'
kubectl rollout restart deployment/cloudpay-backend -n cloudpay
kubectl rollout status deployment/cloudpay-backend -n cloudpay --timeout=10m
main_pods="$(kubectl get pod -n cloudpay -l app.kubernetes.io/name=cloudpay-backend -o name)"
test -n "$main_pods"
for pod in $main_pods; do
  test "$(kubectl exec -n cloudpay "$pod" -- printenv ADMIN_AUTH_ENABLED)" = "false" || exit 1
done
kubectl delete ingress/cloudpay-admin-web ingress/cloudpay-admin-api -n cloudpay --ignore-not-found
kubectl delete -f backend/deploy/kubernetes/admin-api-canary.yaml --ignore-not-found
```

上述删除边界不得扩展到 mobile Ingress、主后端 Deployment、迁移或管理员审计数据。
