# KAI CloudPay Backend

`cloudpay-mobile` 的独立生产后端。移动端与后端按同一产品基线持续演进；所有资源、审核、卡时、交易、履约和账户状态以本服务的 PostgreSQL 记录为准。

## 当前基础能力

- `/mobile/v1/health`：进程存活检查
- `/mobile/v1/readiness`：部署能力与卡时闭环分别检查；卡时闭环只在资源双审、双分录账本、充值验真、卡时扣款和商店政策全部实现后就绪
- KAI 统一身份后端 broker：系统浏览器授权、后端 OIDC PKCE、EdDSA JWKS 验签、issuer/audience/azp/nonce 校验，以及绑定 App PKCE 的一次性登录码
- 生产手机号验证码注册/登录已退役；本机验证码只在受令牌保护的测试验收环境开放，既有手机号账户仍可用于注销二次验证
- 手机号与邮箱 AES-256-GCM 加密、统一身份 issuer+sub 稳定映射、协议版本留痕
- 15 分钟访问令牌、刷新令牌逐次轮换、旧令牌重用时整族撤销、设备会话管理
- 注销前手机二次验证、七天冷静期、未完成交易法定保留和撤销注销
- 供应商实名审核、资源提交和资源验真；公开资源目录不返回未经价格审核的价格字段
- 资源订单人民币直付、供应方自定人民币价格挂牌及旧订单售后路由已从运行时删除
- 用户消息中心支持分类筛选、签名分页游标、未读数、单条/全部已读和严格的账户隔离
- 推送凭证 AES-256-GCM 加密、哈希去重并绑定当前登录设备；关闭推送时立即清除服务端凭证
- 人民币只用于购买卡时：充值单创建不增加余额，支付宝/微信实收金额、币种、商户身份与渠道流水全部验证一致后才写入双分录账本
- 支付回调与主动查询共用唯一入账通道；重复事件、复用渠道流水、金额不一致和未知充值单均不会增加卡时
- 阿里云短信官方 SDK 适配；通道未配置或发送失败时关闭登录入口
- 生产配置缺失时失败关闭；短信、推送和卡时闭环不会返回伪成功
- 统一错误信封、请求 ID、限流、安全响应头和优雅停机；授权凭证、Cookie 与微信签名头在结构化日志中强制脱敏
- 受保护的 Prometheus 指标和运营汇总仍需在后续小批次从早期支付指标迁移到卡时账本、充值对账、双审和卡时预留指标
- PostgreSQL 备份使用客户端 AES-256-GCM 流式加密、SHA-256 复核、独立 S3 凭证和 Compliance Object Lock；恢复只允许空库并执行总账不变量验证
- 反向代理信任层数默认为 0，必须显式配置，避免伪造客户端 IP 绕过限流或污染审计记录

## 本地检查

```bash
npm install
npm run typecheck
npm run contract:verify
npm test
npm run build
npm audit
```

## 监控与运营告警

- `GET /internal/metrics`：Prometheus 文本指标，必须使用 `Authorization: Bearer <METRICS_BEARER_TOKEN>`
- `GET /mobile/v1/operator/operations/summary`：运营或管理员查看不包含个人资料的异常数量汇总
- 生产环境必须为 `METRICS_BEARER_TOKEN` 配置至少 32 个随机字符，否则发布门禁保持关闭
- 建议对 `cloudpay_operational_health < 2`、任意 `*_dead_letters > 0`、`reservation_overdue > 0` 和 `oldest_outbox_age_seconds > 900` 配置即时告警
- `backup_succeeded_24h = 0`、`backup_failures_24h > 0` 或 `restore_drill_succeeded_90d = 0` 必须告警

服务直接监听公网时保持 `TRUST_PROXY_HOPS=0`；只有部署在已知层数的反向代理之后才填写实际层数。

## 数据库迁移

复制 `.env.example` 为本地 `.env` 并填写 PostgreSQL 连接后执行：

```bash
npm run db:migrate
```

迁移使用校验值和 PostgreSQL advisory lock，已执行的迁移不允许静默改写。
readiness 会逐项核对容器内迁移清单与数据库校验值；缺失迁移或已执行 SQL 被改写时，Pod 保持不可接流量。为支持零停机扩展式迁移，数据库中存在更新版本不会让旧 Pod 立即失活，但旧版本代码回滚仍必须通过兼容性检查。

## 备份与恢复

- `npm run db:backup`：生成加密 custom-format 备份、完整性复核后上传不可变备份 Bucket
- `npm run db:backup:inspect -- --input /absolute/file.kcpb`：读取来源指纹、密钥版本、迁移版本和密文摘要
- `npm run db:fingerprint`：打印恢复目标数据库指纹
- `npm run db:restore -- --input /absolute/file.kcpb`：四项显式确认后恢复到空数据库并验证交易总账

备份和恢复运行环境必须安装与生产 PostgreSQL 同主版本的 `pg_dump` 与 `pg_restore`。完整调度、密钥轮换、RPO/RTO、演练和切流步骤见 [生产运行与灾备手册](./docs/production-runbook.md)。

## 生产容器与 Kubernetes

发布前执行 `npm run release:bundle`。命令会先核对手机版与后端路由契约，再运行全量测试与生产编译，最后生成不含密钥、测试数据和依赖目录的部署交付包；交付包同时包含源码、编译产物、38 份数据库迁移、容器与 Kubernetes 配置以及逐文件摘要。

目标机解压后执行 `npm run release:verify`。这一个命令会核对逐文件摘要和迁移集、检查没有密钥文件、安装生产依赖、加载编译入口，并证明 systemd 与容器入口在配置缺失时都会拒绝启动。打包时还会运行 `npm run deployment:verify`，自动比对实际生产门禁、环境示例、Kubernetes 配置来源、工作负载、不可变镜像摘要，以及 ALB、Kubernetes 和上线验证脚本的路由范围。任一门禁未通过时不得继续切流。

- [Dockerfile](./Dockerfile)：固定 Node 24.18.0 基础版本、多阶段构建、非 root 用户、tini 信号转发、容器健康检查及 PostgreSQL 15 客户端
- [应用基线](./deploy/kubernetes/app.yaml)：三副本、零不可用滚动升级、PDB、HPA、readiness、受限安全上下文和入口网络策略
- [迁移任务](./deploy/kubernetes/migrate-job.yaml)：带 advisory lock 的一次性迁移 Job
- [备份任务](./deploy/kubernetes/backup-cronjob.yaml)：整点错峰、禁止并发的小时备份 CronJob
- [部署说明](./deploy/kubernetes/README.md)：Secret 清单、不可变镜像摘要、发布顺序与回滚原则
- [现网 AWS / Ubuntu 接入](./deploy/aws-ubuntu/README.md)：新后端独立端口、ALB 精确路径分流、旧首页与 `/api/*` 保护及上线前后对比检查

清单中的镜像地址是故意不可拉取的占位值。生产流水线必须替换为经过 SBOM、漏洞扫描和签名验证的真实 `@sha256:` 摘要，禁止使用可变标签。

当前 `cloudpay.kai.com` 已有网站和 `/api/*` 交易服务，不能使用整站替换方式发布。现网固定只接管 `/mobile/v1`、`/mobile/v1/*`、`/privacy`、`/terms` 与 `/account/delete`；根路径及 `/api/*` 必须留在原目标组。先用 `npm run production:routing:capture -- https://cloudpay.kai.com <基线文件>` 保存旧站响应，切换精确路径后再运行 `npm run production:routing:verify -- https://cloudpay.kai.com <基线文件>`。检查未通过时不得保留新规则。

## 当前资源接口

- `GET /mobile/v1/market/resources`：只返回已验真的资源事实与公开参数，不返回供应方自定价或人民币交易字段
- `GET/POST /mobile/v1/provider/profile`：读取或提交当前交易主体的提供资格
- `GET/POST /mobile/v1/provider/resources`：读取资源或提交资源进入验真
- `GET /mobile/v1/provider/resources/:resourceId/evidence`：读取三类验真材料和审核进度
- `POST /mobile/v1/provider/resources/:resourceId/evidence/uploads`：登记私有材料并取得上传授权
- `POST /mobile/v1/provider/resources/:resourceId/evidence/:evidenceId/complete`：实检对象信息并进入安全扫描
- `POST /mobile/v1/provider/resources/:resourceId/evidence/submit`：三类材料检查完成后固定快照并进入平台审核
- `POST /mobile/v1/operator/resources/:resourceId/verification`：运营完成资源验真
- `GET/POST /mobile/v1/provider/offer-drafts`：读取上架草稿，或从已验真资源创建一份方案草稿
- `GET/PUT/DELETE /mobile/v1/provider/offer-drafts/:draftId`：断点续填或放弃草稿；放弃只退出工作台并保留审计，不删除已验真资源
- `POST /mobile/v1/provider/offer-drafts/:draftId/submit`：固定当前方案快照并提交资源审与价格审
- `POST/GET/PUT /mobile/v1/provider/offers/:offerId/revision`：审核退回后创建、读取或保存修改稿，原提交版本和审计记录不被覆盖
- `POST /mobile/v1/provider/offers/:offerId/revision/submit`：提交修改并生成下一版资源审与价格审
- `POST /mobile/v1/provider/offers/:offerId/reaudit`：审核有效期结束后重新发起双审
- `POST /mobile/v1/operator/offers/:offerId/audits/:kind/decision`：不同审核员完成资源/价格决定
- `POST /mobile/v1/provider/listings`：双审后只选容量与时段发布
- `GET /mobile/v1/market/listings`：只返回审核有效的卡时挂牌

上架链已使用独立的 Offer Template 与卡时 Listing 模型，供应方只能提交建议人民币价和证据；最终卡时价由服务端按 `1 KAI 卡时 = ¥1.002` 向上取六位小数。算力只能使用卡时购买。

卡时余额已迁移为不可变双分录账本。`GET /mobile/v1/credits/balance` 只返回当前交易主体的可用、预留与供应方待结算卡时；余额由已入账分录实时汇总，不存在可直接修改的余额字段。卡时发行账户是唯一允许承担发行负数的账户，主体账户禁止透支；每笔事务至少两条分录且总和必须为零。

卡时充值接口只接受已登录 App：`POST /mobile/v1/credits/topups` 创建支付宝或微信充值，`GET /mobile/v1/credits/topups` 与 `GET /mobile/v1/credits/topups/:topupId` 查询当前交易主体的记录。生产回调固定为 `/mobile/v1/credits/topups/alipay/notify` 与 `/mobile/v1/credits/topups/wechat/notify`，必须与 `PUBLIC_ORIGIN` 精确一致。换算按实收人民币向下取六位卡时，避免超额发行，例如 `¥100.00 = 99.800399 KAI 卡时`。

卡时订单使用 `POST /mobile/v1/orders`，请求只接受双审挂牌 ID 与购买数量，不接受人民币金额、币种或支付方式。创建订单时在同一数据库事务中固定挂牌快照、预留可售数量并把卡时从可用账户转入预留账户；余额不足、容量不足、自买和重复点击不会产生重复占用。`GET /mobile/v1/orders` 与 `GET /mobile/v1/orders/:orderId` 同时支持买方和提供方视角，但只能查看当前交易主体参与的订单。提供方 30 分钟内未确认时，后台任务用反向双分录退回卡时并恢复容量。

提供方通过 `POST /mobile/v1/provider/orders/:orderId/confirm` 确认接单后，临时预留转为履约担保，不再受 30 分钟超时任务影响；只有具备提供方订单管理权限的成员可以操作。买方在确认前可通过 `POST /mobile/v1/orders/:orderId/cancel` 取消，卡时与容量在同一事务中完整退回。确认、取消和超时竞争时只允许一个最终结果，所有操作均要求幂等标识并写入不可变事件与审计记录。

确认后，提供方通过 `POST /mobile/v1/provider/orders/:orderId/delivery/start` 开始交付，再用 `POST /mobile/v1/provider/orders/:orderId/delivery/ready` 提交连接信息。连接地址、账号和凭证使用 AES-256-GCM 加密保存；普通订单、消息、事件和审计记录只含状态或摘要。订单双方可通过 `GET /mobile/v1/orders/:orderId/delivery` 查看交付详情。只有买方调用 `POST /mobile/v1/orders/:orderId/accept` 明确验收后，担保卡时才以双分录转入提供方待结算账户，并把挂牌数量从预留转为已售；重复验收不会再次扣款。验收满 7 天后，系统自动把订单金额从提供方待结算账户转入可用卡时；提供方也可在到期后调用 `POST /mobile/v1/provider/orders/:orderId/settle` 主动触发，同一订单只产生一笔结算交易。订单双方可通过 `GET /mobile/v1/orders/:orderId/settlement` 查看不可变结算凭证。订单在结算完成前会阻止买卖双方注销账户。

交付不符时，买方可通过 `POST /mobile/v1/orders/:orderId/delivery/issue` 选择“重新交付”或“申请退款”并说明问题。说明文字加密保存，消息、事件和审计只记录摘要；订单双方通过 `GET /mobile/v1/orders/:orderId/delivery/issue` 查看详情。提出异议后，担保卡时不会转给提供方，容量保持预留，原验收接口也不能再扣款，等待后续协商或平台处理。

买方要求重新交付时，提供方通过 `POST /mobile/v1/provider/orders/:orderId/delivery/rework/start` 开始新一轮，再复用交付提交接口提交新结果。每轮交付都是独立且不可修改的版本；`GET /mobile/v1/orders/:orderId/delivery` 保留最新交付兼容字段，并返回完整版本列表。旧版本只会标记为已替代，不会被覆盖；最终验收记录必须绑定实际验收的交付版本。

买方明确申请全额退款后，提供方可调用 `POST /mobile/v1/provider/orders/:orderId/refund/approve` 同意。接口不接受退款金额，服务端只按订单快照与担保余额生成一笔反向双分录，将全部卡时退回买方可用账户，并在同一事务中关闭订单和恢复预留容量。订单双方通过 `GET /mobile/v1/orders/:orderId/refund` 查看已退卡时与完成时间。重复请求不会重复退款。

如果退款申请无法协商，买方或具备争议处理权限的提供方成员可通过 `POST /mobile/v1/orders/:orderId/dispute/escalate` 提交平台处理。独立运营账号从 `GET /mobile/v1/operator/order-disputes` 读取待处理队列，队列包含本次交付版本、交付内容及买方说明，但敏感正文不会写入事件、通知或日志。运营使用 `POST /mobile/v1/operator/order-disputes/:orderId/decision` 只能选择全额退款或恢复待验收，接口不接受金额：全额退款严格按订单担保额退回并恢复容量；恢复验收不移动卡时或容量。订单双方通过 `GET /mobile/v1/orders/:orderId/dispute/adjudication` 查看加密保存的裁定理由与结果凭证。

买方验收后、提供方卡时尚未结算时，仍可在验收后的 7 天内通过 `POST /mobile/v1/orders/:orderId/aftercare/refund` 提交全额退款申请。申请一经受理即暂停自动和主动结算；提供方负责人、管理员或财务负责人可通过 `POST /mobile/v1/provider/orders/:orderId/aftercare/refund/approve` 同意。两个接口都不接受退款金额，服务端固定按原订单金额从提供方待结算账户退回买方。算力已经实际使用，因此退款后容量仍保持已售，不会重新挂牌。订单双方通过 `GET /mobile/v1/orders/:orderId/aftercare/refund` 查看同一张售后凭证。

提供方对验收后退款有异议时，可附理由直接提交平台；提供方 24 小时未处理时，买方可升级。运营队列为 `GET /mobile/v1/operator/aftercare-refunds`，裁决接口为 `POST /mobile/v1/operator/aftercare-refunds/:orderId/decision`，只能选择按原订单全额退款或驳回，不能传入金额。平台全额退款仍保持容量已售；驳回后恢复原结算安排。裁决、升级和退款理由均加密保存，订单参与方通过同一售后凭证查看结果。

售后支持买方按实际影响申请部分或全部卡时补偿；请求金额在提交时锁定，提供方只能同意或提出异议，平台只能按锁定金额支持或驳回。补偿入账、提供方待结算扣减与剩余卡时结算均由双分录账本和数据库约束校验。

## 消息与设备接口

- `GET /mobile/v1/notifications`：分页消息列表，可按类别或未读筛选
- `GET /mobile/v1/notifications/unread-count`：底部“消息”角标数字
- `POST /mobile/v1/notifications/:notificationId/read`：单条已读
- `POST /mobile/v1/notifications/read-all`：全部已读
- `PUT /mobile/v1/devices/push`：为当前登录设备登记推送凭证
- `DELETE /mobile/v1/devices/push`：关闭推送并删除服务端凭证
