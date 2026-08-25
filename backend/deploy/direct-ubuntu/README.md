# cloudpay.kai.com 手机版询期入口（18 → 43 私网）

这是当前唯一生产接入方案。它不创建 AWS/Cloudflare 入口，不改 DNS，不改 `cloud.kai.com`，也不替换旧 CloudPay 网站。

## 固定拓扑与边界

- 旧站源机：`18.163.148.84`，私网 `172.31.33.227`。现有 Nginx 在 Docker 容器 `kai-transaction-edge` 内运行，宿主配置 `/home/ubuntu/kai-transaction-v1/nginx-kai.conf` 只读挂载为容器 `/etc/nginx/nginx.conf`，源站监听 `8081`。
- 手机版后端机：`43.198.97.0`，私网 `172.31.31.78`。应用只监听 `127.0.0.1:4100`；`systemd-socket-proxyd` 只监听 `172.31.31.78:4154`。
- 43 号机 nftables 只允许源地址 `172.31.33.227/32` 访问 `4154`，其他来源全部丢弃。PostgreSQL、应用 `4100` 和内部 metrics 均不得公开监听。
- 18 号机只新增 `location = /mobile/v1`、七相 notify 精确 location、KAI callback 精确 location、`location ^~ /mobile/v1/`、七相同步返回页和四个法务页精确 location。无 URI rewrite，`/`、`/api/*` 及其旧配置保持不变。
- 七相 notify 精确 location 在 18 号机关闭 access log，禁止 `$request_uri`/`$args`；应用只记录路径。签名回调的完整查询、签名和交易号不得进入边缘或应用日志。
- 九个新增 location 各自启用 `ngx_http_realip_module`，只信来自 VPC `172.31.0.0/16` 的现有 ALB peer 所追加的 XFF，并递归取最后一个不受信地址；从公网直接访问 `18:8081` 时，来访者不在可信 CIDR，伪造 XFF 不生效。随后把清洗后的单值 `$remote_addr` 传给 43。43 固定 `TRUST_PROXY_HOPS=1`，只信直接相连的 socket-proxyd 一跳，因此不同客户端独立限流，审计 IP 表示该受控代理链确认的客户端地址。
- `PUBLIC_ORIGIN` 必须是 `https://cloudpay.kai.com`。`/internal/metrics` 不进入公网路由。

inquiry-only 采用本机 AES-256-GCM 备份和同机隔离 PostgreSQL 恢复演练；没有站外备份、高可用或灾备，readiness 必须如实返回 `offsiteBackup=false`、`highAvailability=false`、`disasterRecovery=false`、`riskAccepted=true`。

## 43 号机安装与 Stage A

安装本目录的 backend、migration、backup、edge、firewall、paired-probe 及 revoke units。生产环境文件只能放在 `/etc/kai-cloudpay/backend.env`（`root:root 0600`），并固定：

```text
NODE_ENV=production
MOBILE_API_PROFILE=inquiry_only
HONGHUAN_SUPPLIER_CATALOG_MODE=inquiry
HOST=127.0.0.1
PORT=4100
PUBLIC_ORIGIN=https://cloudpay.kai.com
TRUST_PROXY_HOPS=1
BACKUP_LOCAL_DIRECTORY=/var/lib/kai-cloudpay-backup
ICP_FILING_STATUS=not_obtained
APP_FILING_STATUS=not_obtained
INTERNET_SERVICE_CLASSIFICATION_STATUS=not_assessed
```

当前权威事实是 ICP 与 App 备案均尚未取得、互联网服务分类尚待合资格法务确认，因此对应编号与 evidence ref 必须留空。法务页面可正常公开并诚实显示“尚未取得”，但 public release 必须保留 `ICP_FILING_NOT_APPROVED`、`APP_FILING_NOT_APPROVED`、`INTERNET_SERVICE_CLASSIFICATION_REQUIRED` 三个 blocker；这三项未解决前禁止长期 Stage B。

PostgreSQL 必须是该服务独立的本机回环数据库。先运行 host preflight，再迁移到 `0065`、启动后端、执行本地加密备份和隔离恢复演练。此时公网尚未接管手机版路径，真实公网 KAI/App 证据不可能存在，备案与互联网服务分类也未完成；Stage A 只允许 readiness 返回受审计的精确 blocker 集合：

首次安装时由 root 运行 `npm run production:probe-static-credentials:provision`，为 paired probe 创建独立、最小权限 PostgreSQL 登录角色，并生成两份 host-key 加密 credential（回环数据库 DSN 与独立 audit pepper）。轮换由主机文件锁串行执行，先落两份候选密文和事务记录，再在单个数据库事务中更新密码/权限，最后原子提交两份密文；进程中断后再次执行会验证新旧数据库身份并完成或安全回退未提交事务。随后运行 `npm run production:probe-static-credentials:verify`，用探针自身身份验证只读表集合、审计插入回滚和禁止交易写权限，并写入绑定两份密文摘要的 24 小时验收证据；host preflight 会复核该证据。命令不会生成或接收 KAI refresh state；第三份 refresh credential 必须由专用测试账号完成真实授权后单独注入，禁止复用普通用户会话或伪造。

第三份 credential 只能由操作者在受信工作站运行 `npm run production:probe-refresh:authorize-enroll -- --identity-file <SSH私钥>` 创建。授权前必须先由两名运营人员确认永久专用测试账号，并把其 subject SHA-256 写入 43 号机 root:root 0600 的 `/etc/kai-cloudpay/probe-expected-subject.sha256`。命令先确认目标机没有旧 credential，再在系统浏览器强制重新登录；账号密码只提交给 `auth.kai.com`。本机固定使用已登记的 IPv4 loopback 回调、PKCE/state/nonce，校验 discovery 的默认 HTTPS 端口、EdDSA ID token、`at_hash`、userinfo subject、完整 scope，并先实测 refresh 强制轮换。最终 refresh state 仅通过固定主机和固定脚本的 SSH stdin 送入 43 号机，root helper 还会对比预批准 subject 指纹；不进入聊天、环境、命令参数、日志或明文磁盘。helper 是 create-only，需要换账号时必须先远端确认撤销旧 family。

## 完整商业模式的额外门禁

询期版本与真实充值物理分离。只有 ICP 与 App 备案均已签发给实际运营主体、`cloudpay.kai.com` 与 `com.kaicloud.marketplace` 已绑定、合资格法务完成互联网资源协作/交易处理/信息服务分类结论、七相完成新 Key 签发与旧 Key 吊销并批准实际域名、Android H5 支付场景、算力卡时类目、退款 API 和金额上限后，才允许准备完整商业模式。

### 当前 Key 单笔技术闭环（不等同完整商业开通）

当操作者只提供当前商户 Key、尚不能提供旧 Key 与外部审批材料时，只能启用显式的 `QIXIANG_TECHNICAL_CANARY_MODE=on`。该模式不声称旧 Key 已吊销，也不声称域名/App 场景、服务类目或退款 API 已获七相批准；完整商业发布门禁继续失败关闭。它只允许预绑定的一个真实用户、其个人主体、一个预留 v4 topup UUID 和固定 `501` 分创建唯一一笔七相真实订单，退款与其他交易写入全部关闭。仅当数据库、身份能力、统一登录和该笔七相技术验收均可用时，readiness HTTP 状态允许为 `200`，供现有 APK 读取受限能力；响应体仍必须保持 `ok=false`、`release.ready=false`、`commerce.ready=false` 并公开全部发布 blocker。任一技术验收能力失效时 HTTP 状态恢复为 `503`。

密钥通过 `production:qixiang-technical-canary:enroll-host` 的 stdin 一次性输入。helper 仅创建当前商户 Key、随机 checkout 键以及 Ed25519 签名/验签密钥四份 host-key 加密 credential，拒绝覆盖既有 credential，不接收或记录旧 Key。`production:qixiang-technical-canary:issue` 每次实时查询 PID 4611 当前 Key 状态、绑定发布摘要与 PostgreSQL 实例/迁移摘要，并核对预绑定用户和个人主体；通过后签发十分钟 `bootstrap_canary`。专用 timer 每五分钟续签，任一核验失败后旧票据最多十分钟自动失效。首笔订单成功后签发器拒绝继续续签；只有完成真实回调、主动核单、账本、364 天 lot 和用户可见到账核验后，才能形成技术闭环报告。此报告不能升级为 `full_commerce`，也不能替代政府、法务或支付机构批准。

技术验收进程的环境预检只容忍代码内固定列出的非本单能力缺失（短信、Push、对象存储/杀毒、站外备份、传统充值与算力供应商）以及三项如实的备案/分类 blocker。数据库、KAI 身份、七相当前 Key/checkout credential、技术 canary 三个 UUID、固定 501 分上下限或恢复核单能力任一不可用，仍会阻止进程启动；未知的新 blocker 也不会被容忍。

七相现网的未支付查单响应与旧文档存在类型差异：`status` 可能为字符串，并会返回 nullable 的 `bill_trade_no`、`payurl` 等字段。适配器只接受已观测并受测试锁定的这一精确结构；必须再次核对 PID、商户订单号、金额、支付方式、商品名和业务扩展参数。若首次下单结果不确定但查单确认订单存在，核单 worker 只从七相系统订单号恢复同源 `/pay/submit/<trade_no>/` 收银台并加密保存，不得再次创建第二笔渠道订单。人工核对状态经用户显式“重新核对”后必须清除 dead-letter 锁，才能进入该恢复流程。

新的七相 Key 不得写入 `backend.env`、聊天、命令参数或代码。root helper 只从 stdin 接收旋转后的当前 Key 与已退役旧 Key，在 43 号机内部生成 checkout 加密键与 Ed25519 验收签名密钥对，并将五份凭据用 host key 加密、解密回读、fsync 后原子创建；若已有 credential 会拒绝覆盖。主服务只获得当前 Key、checkout 键、验签公钥和已签名的短时票据，永不获得旧 Key 或签名私钥。

完整商业模式启动前必须依次运行：

```bash
npm run production:qixiang-evidence:verify -- --report /var/lib/kai-cloudpay-public-gates/qixiang-production-gate.json
npm run production:full-commerce:preflight -- --report /var/lib/kai-cloudpay-deploy/full-commerce-preflight.json
```

第一条命令会实时调用七相商户查询：当前 Key 必须返回 PID 4611 且账号正常，已退役 Key 只有在七相返回精确 `code=-3` 与“商户密钥错误”时才算拒绝；限频、网络或其他业务错误一律失败关闭。合规与验收材料必须是结构化的 Ed25519 签名证据，签名公钥指纹、可签证据种类、签发主体和权限角色必须预先固定在受审发布内的 `qixiang-evidence-trust-policy.mjs`；运行时 trust 目录不能自行授权。当前发布的信任策略为空，在收到并审核政府、法务、七相和验收方的公钥指纹前，验证器必然拒绝开门。

在外部合规材料、专用探针、App 会话、双人复核和数据库绑定先通过、但尚无首笔真实交易时，验证器只能签发 `bootstrap_canary`：它只允许预绑定用户和主体创建预留 UUID 的唯一 ¥5.01 订单，不允许其他金额、用户、订单或退款。该订单完成并获得有效签名回执、364 天权益、lot、履约和对账签名报告后，才可签发 `full_commerce`。两种票据都只有 10 分钟有效期。systemd 启动、创建订单和提交退款复用同一验证器；且在真正调用七相前紧邻地再查当前数据库 system identifier、database OID 和迁移摘要。本工具不代替政府、法务或支付机构的真实性责任。
安装并启用 `cloudpay-mobile-qixiang-gate-refresh.timer` 后，root oneshot 每 5 分钟重新执行全部实时核验并原子替换可公开验签的票据。应用每次创建订单或提交退款都从 root 只读目录重新读取票据：同一阶段内的续期和关闭无需重启，任一次刷新失败后，旧票据最多 10 分钟即自动关闭新扣款与外部退款。`bootstrap_canary` 进程虽载入完整路由表，但服务器全局前置隔离只放行身份变更、唯一¥5.01 验收单创建和该预留 topup ID 的手动核单；其他交易变更返回 503。此阶段只启动严格按预留 topup ID 领取的七相核单 worker，其他交易 worker 和 lot 到期 worker 均不启动；回调也必须通过同一签名验收单绑定。当票据升级为 `full_commerce` 后必须由受审发布流程重启服务，才会启动完整交易 worker 并移除 bootstrap 路由隔离。

```text
UNIFIED_IDENTITY
APP_STORED_SESSION
INQUIRY_OPERATIONAL_EVIDENCE
KAI_PAIRED_PROBE_30M
APP_STORED_SESSION_PROBE_24H
ICP_FILING_NOT_APPROVED
APP_FILING_NOT_APPROVED
INTERNET_SERVICE_CLASSIFICATION_REQUIRED
```

数据库、服务集合、账号安全、本地备份、恢复、法务、监控、公开 origin 和 11 项正式目录必须全部 ready；任何第六个 blocker 都停止切流。43 号机先执行：

```bash
npm run production:sidecar:preflight -- --report /var/lib/kai-cloudpay-deploy/sidecar-host-$(date +%s).json
npm run production:sidecar:verify -- --report /var/lib/kai-cloudpay-deploy/sidecar-probe-$(date +%s).json
```

## 18 号机基线与预检

18 号机不安装 43 号机的后端发布树。只把本目录中的 `cutover-watchdog.mjs`、`verify-routing.mjs`、`verify-rollback.mjs`、`verify-nginx-config.mjs`、`preflight-origin.mjs`、`probe-inquiry.mjs` 安装到专用只读目录 `/opt/kai-cloudpay-origin`（`root:root 0755`，文件 `0644`），并安装 `cloudpay-mobile-cutover-watchdog.service`。unit 的唯一写权限是 active Nginx host 配置、`/var/lib/kai-cloudpay-deploy` 和 Docker socket；不得在 18 号机安装或启动 CloudPay backend/migration/backup units。

每次切流都重新生成同一时刻的公网/直连基线；2026-08-21 观测到的首页 `23026B` 和 SHA-256 `2d0347e75baaf93bebe0a0a79a4640d6102ec399a10a1d0c2a0941d7ae3e07b2` 只作为参考，不是永久发布值。基线要求公网与 `18.163.148.84:8081` 的 `/`、`/api/health` 当前逐字节一致，并确认旧 API 身份仍是 `kai-transaction`。

```bash
/usr/bin/node /opt/kai-cloudpay-origin/verify-routing.mjs capture https://cloudpay.kai.com /var/lib/kai-cloudpay-deploy/before-$(date +%s).json
/usr/bin/node /opt/kai-cloudpay-origin/preflight-origin.mjs \
  --baseline /var/lib/kai-cloudpay-deploy/before-<timestamp>.json \
  --nginx-config /home/ubuntu/kai-transaction-v1/nginx-kai.conf \
  --report /var/lib/kai-cloudpay-deploy/origin-preflight-<timestamp>.json
```

origin preflight 必须证明：当前主机确为 `172.31.33.227`、Docker 容器运行、host/container 配置摘要一致且挂载只读、私网 `4154` 可访问、health/目录/401/404 正确，并且只有上述八个预期 blocker。

## Stage B：10 分钟技术验收（固定回滚）

当前验收模式在代码中锁死为 `acceptance_mode=always_rollback`，没有“验收后保持公网路由”的可选开关。登录成功、登录失败或 10 分钟内未完成报告都会恢复旧配置；技术报告只记录结果，不能解除 watchdog。长期保留新路由必须另行取得备案、法务和发布批准，并使用另一套受审计的生产切流实现。

1. 把 active Nginx 配置以 `root:root 0600` 备份到 `/var/lib/kai-cloudpay-deploy/`，并保存修改前 `docker exec kai-transaction-edge nginx -T` 的完整输出。
2. 创建 `/etc/kai-cloudpay/cutover.env`（`root:root 0600`），设置 `CUTOVER_SAVED_NGINX_CONFIG`、`CUTOVER_BASELINE_PATH`、`CUTOVER_SUCCESS_REPORT`、`CUTOVER_DEADLINE_PATH` 和 `CUTOVER_AUDIT_DIRECTORY=/var/lib/kai-cloudpay-deploy`。deadline 文件必须使用本次唯一文件名；watchdog 首次启动以不可覆盖方式写入固定 10 分钟窗口，服务重启也不能延长窗口。
3. 先用 `systemctl start --no-block cloudpay-mobile-cutover-watchdog.service` 启动 10 分钟自动回滚，再把 `cloudpay-mobile-nginx-routes.conf` 六个 location 加入现有 `cloudpay.kai.com` 的 HTTP `:8081` server block。不得增加默认路由、`/api` 路由或 `cloud.kai.com` 配置。
4. 先执行 `docker exec kai-transaction-edge nginx -t`，保存候选 `nginx -T` 输出，用 `production:nginx:verify` 比较修改前后 `/`、`/api` 和 `cloud.kai.com` 配置块；通过后执行 `docker exec kai-transaction-edge nginx -s reload`。
5. 用正式签名 APK 和真实 KAI 账号完成授权、`/me`、法务同意、StoredSession 落盘、强杀和重启恢复。测试端生成的精确 JSON 报告必须是 `0600`，再在 43 号机运行 `npm run production:app-session:record -- --report <absolute-report>`；不得手工伪造成功。
6. 探针使用独立无登录用户 `kai-cloudpay-probe`，不得继承 `/etc/kai-cloudpay/backend.env`。systemd 只注入三份机器加密 credential：refresh state、专用最小权限 probe 数据库 DSN、HMAC audit pepper。数据库角色只允许读取 schema/交易守恒快照并向 `audit_events` 插入探针证据，不能修改订单、卡时或账本；本机回环 PG 使用 `DATABASE_SSL=false`，不得把该设置用于远程数据库。每轮先向 `auth.kai.com` 用 refresh grant 换取且强制轮换新的 refresh，并验证 access/ID 的 EdDSA、subject 与 `at_hash` 配对。新 refresh 先写 tmpfs `/run` 的 `0600` 原子 handoff，再由 root 窄化 helper 通过 stdin 调用 `systemd-creds encrypt --with-key=host`，临时密文成功后原子替换旧 refresh credential；只有持久化成功才启动业务探针。access/ID 仅短暂存在同一 `0700` tmpfs RuntimeDirectory，以内存文件传入下一阶段，随即读取到进程内并删除；不进入持久磁盘、环境、命令行、refresh handoff 或日志。
7. readiness 必须保持诚实的 `503`、`release.ready=false`，且 blocker 精确只剩 `ICP_FILING_NOT_APPROVED`、`APP_FILING_NOT_APPROVED`、`INTERNET_SERVICE_CLASSIFICATION_REQUIRED`。原五项技术 blocker 必须全部消失，`kaiPairedProbe.ready=true` 与 `appSessionProbe.ready=true`；任一技术 blocker、额外 blocker 或证据未 ready 都记为技术验收失败。达到该技术状态后立即执行公网验证，并把技术报告写到 watchdog 的 `CUTOVER_SUCCESS_REPORT` 精确路径：

```bash
/usr/bin/node /opt/kai-cloudpay-origin/verify-routing.mjs verify https://cloudpay.kai.com \
  /var/lib/kai-cloudpay-deploy/before-<timestamp>.json \
  /var/lib/kai-cloudpay-deploy/cutover-success-<timestamp>.json
```

报告由 18 号机本地验证器直接以 `0600`、不可覆盖方式写入 watchdog 的精确路径，不从 43 号机复制，也不接受聊天或手工 JSON。报告只会写 `decision=technical_acceptance_passed|technical_acceptance_failed`；两者都会让 watchdog 立即回滚。它同时复核旧首页和 `/api/health` 与切流前基线、`cloud.kai.com` 基线、公网 11 项目录、法务页、未登录 401、非白名单 404、无缓存以及全部 readiness 证据。

paired KAI 证据 30 分钟过期；`cloudpay-mobile-paired-probe.timer` 每 15 分钟以最新持久 refresh family 运行真实轮换链。同一 rotation lock 防止并发刷新；崩溃后若存在 refresh handoff，root helper 会先持久化新 refresh，若只遗留上一轮 access/ID pair，则在下一次远端刷新前先安全删除，旧 credential 和孤儿 pair 都不会阻塞或重复执行探针。refresh 被拒绝、token 未轮换、配对失败或持久化失败都会失败关闭，系统不会回退到静态 300 秒 access/ID。

## 自动与人工回滚

技术报告成功、失败，或 10 分钟内没有完整报告时，18 号 watchdog 都会在宿主配置文件中恢复已保存字节，确认容器挂载看到相同 SHA-256，再执行容器内 `nginx -t` 和 `nginx -s reload`。随后必须验证旧首页、3051 对应的 `/api/health`、旧 `/mobile/v1/health` HTML fallback 和 `cloud.kai.com` 均与基线一致。它不会调用不存在的 host Nginx systemd，也不会回滚 43 号数据库、迁移或本地备份。

回滚报告只会把测试 refresh family 远端撤销和 App StoredSession 清理标记为待完成；没有真实凭据、auth 端明确撤销确认及设备清理证据时，禁止写“已撤销”或“已清会话”。

18 号机不能撤销 43 号机凭据。任何失败回滚后，必须在 43 号机独立执行：

```bash
node deploy/direct-ubuntu/verify-paired-probe-systemd.mjs --report /var/lib/kai-cloudpay-deploy/probe-systemd-$(date +%s).json
systemctl start cloudpay-mobile-paired-probe-revoke.service
```

该 unit 显式停止 timer 并与正在运行的 probe service 冲突，同时与轮换共用独占锁；任何 refresh handoff 必须先原子持久化。目标 Ubuntu 上必须先运行 systemd 验收脚本，报告证明主进程以 78 退出时 `NRestarts=0`、仅启动一次且网络分支计数为零。每次调用撤销/验证前，root helper 还会先把本次 `attempt_pending` 状态机器加密落盘，之后才允许网络请求。RFC 7009 的空 `200` 本身不算撤销完成：只有此前没有悬而未决的请求、且本次同步验证收到 `application/json` 的明确 `invalid_grant`，才写确认 marker、清理孤儿 pair，并由 root finalizer 删除机器密文。若主进程已经写入有效 `remote-revocation-confirmed`、但在 finalizer 前崩溃，下次 prepare 会优先识别 marker，清理临时文件，主进程不发网络并由幂等 finalizer 完成密文删除。若 `2xx` 返回新的 refresh，无论 access/ID 配对是否有效，都只把该 refresh 机器加密隔离为 `revoke_only`，绝不交给业务探针，并继续撤销该候选。若响应丢失、HTML、缺候选或进程在请求期间中断，则持久化 `manual_admin_required`；prepare 会写受保护的人工接管 marker 并正常结束，随后由主进程在任何网络调用前以 78 退出，`RestartPreventExitStatus=78` 阻止重启风暴。此后旧 refresh 的 `invalid_grant` 不能自动完成删除，必须由 auth 管理员按 subject/family 接管。绝不以本机 `rm`、空 `200` 或歧义后的旧 token 失效冒充撤销。随后执行 `production:rollback:verify`，确认旧首页和 `/api` 已恢复、手机版路径不再指向新后端。DNS 和 `cloud.kai.com` 始终不变。
