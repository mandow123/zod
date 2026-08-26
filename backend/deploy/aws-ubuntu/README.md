# 已停用：旧 AWS/ALB 路由模板

> 本目录仅作历史留档，不是当前生产门禁，不得用于 `cloudpay.kai.com` 上线。当前唯一契约在 `deploy/direct-ubuntu/README.md`：18 号 Docker Nginx 精确分流到 43 号私网 `4154`。不得创建 ALB 规则，不得照本目录执行。

# cloudpay.kai.com AWS / Ubuntu 路由接入（历史）

本目录用于把 KAI CloudPay 手机版后端接到现有 `cloudpay.kai.com`，不替换网站首页，也不接管现有 `/api/*` 交易服务。

## 固定边界

- 新后端只在宿主机回环地址 `127.0.0.1:4100` 监听。
- `systemd-socket-proxyd` 只把 VPC 内网端口 `4154` 转发到 `127.0.0.1:4100`。
- AWS Application Load Balancer 只把以下路径转发到 `4154`：
  - `/mobile/v1` 与 `/mobile/v1/*`
  - `/privacy`
  - `/terms`
  - `/inquiry-terms`
  - `/account/delete`
- `/`、静态网页以及 `/api/*` 必须继续使用现有目标组。
- ALB 健康检查固定为 `/mobile/v1/health`。它只证明进程存活；切换业务流量前还必须人工确认 `/mobile/v1/readiness` 返回 `200` 且 `release.ready=true`。

端口 `4154` 是手机版后端的专用 VPC 入口。安装前必须在目标主机执行 `ss -ltnp`，确认 `4100` 与 `4154` 均未被占用；实际私网 IP 必须由目标主机读取，不能沿用其他服务的地址。

## 文件

- `cloudpay-mobile-edge.socket`：VPC 私网监听模板，安装时替换 `PRIVATE_IPV4`。
- `cloudpay-mobile-edge.service`：转发到回环后端。
- `cloudpay-mobile-edge-firewall.service` 与 `cloudpay-mobile-edge.nft`：只允许 AWS VPC `172.31.0.0/16` 访问 `4154`。
- `cloudpay-mobile-backend.service`：以独立低权限用户运行后端，异常退出后自动恢复。
- `cloudpay-mobile-migrate.service`：启动新版本前执行带校验值和数据库锁的迁移；失败时后端不会启动。
- `cloudpay-mobile-backup.service` 与 `.timer`：每小时执行一次加密备份，systemd 保证同一服务不并发。
- `cloudpay-mobile-alb-routes.json`：必须配置到 ALB 的精确路由契约，不包含首页或旧 API。
- `verify-routing.mjs`：上线前后对比检查；证明旧首页和 `/api/health` 未被替换，同时检查新 API 与法务页面。

## 主机安装约定

- Node.js 必须为 `22.18.0` 或更高版本，并固定在 `/usr/bin/node`。
- 创建无登录 shell 的 `kai-cloudpay` 系统用户；发布目录为 `/opt/kai-cloudpay/releases/<版本>`，`/opt/kai-cloudpay/current` 只指向已经完整安装的版本。
- 代码、依赖和发布目录归 `root:root` 且对服务用户只读；只有 `/var/lib/kai-cloudpay-backup` 归 `kai-cloudpay:kai-cloudpay`，权限 `0700`。
- 生产配置固定为 `/etc/kai-cloudpay/backend.env`，归 `root:root` 且权限 `0600`。不得把它放进发布目录、压缩包、日志或命令行。
- `backend.env` 必须设置 `NODE_ENV=production`、`MOBILE_API_PROFILE=inquiry_only`、`HONGHUAN_SUPPLIER_CATALOG_MODE=inquiry`、`HOST=127.0.0.1`、`PORT=4100`、`PUBLIC_ORIGIN=https://cloudpay.kai.com`、`BACKUP_LOCAL_DIRECTORY=/var/lib/kai-cloudpay-backup`，其余项目按 `.env.example` 和 readiness 补齐。
- inquiry-only 不实例化算力、支付、短信、推送、Vast、节点、broker、上架、供应经营、运营或返佣服务与 worker；环境中即使残留这些变量，也不会开放对应路由。只有未来经独立审计显式切换 `full_commerce`，才重新执行完整商城门禁。
- `cloudpay-mobile-backend.service` 启动前会运行 `scripts/verify-production-env.mjs`。它只输出缺少或不合规的配置项名称，不输出配置值；专用 PostgreSQL、账号安全、KAI paired 身份、对象存储、监控、备份配置、法务资料或公开 HTTPS 未就绪时直接拒绝。进程启动后，readiness 还必须验证 0066、有效加密备份、独立目标恢复演练、正式供应商目录、对象存储真实读写删除及 KAI paired 测试身份成功链的近期证据。

后端与迁移已启动但尚未接入 ALB 时，先用临时环境变量运行受控就绪探针。令牌只能通过当前 shell 的临时环境或受控密钥注入，不能写入命令行、报告或 `backend.env`：

```bash
INQUIRY_READINESS_PROBE_ORIGIN=http://127.0.0.1:4100 \
INQUIRY_READINESS_ACCESS_TOKEN='<temporary paired access token>' \
INQUIRY_READINESS_ID_TOKEN='<temporary paired id token>' \
npm run production:readiness:record
unset INQUIRY_READINESS_ACCESS_TOKEN INQUIRY_READINESS_ID_TOKEN INQUIRY_READINESS_PROBE_ORIGIN
```

该探针实际执行对象存储 Put/Head/Get/Delete/删除确认，并以真实测试身份完成 `/me`、法务版本、同意、主体读取与选择、正式询期和取消；它同时断言订单、预留、卡时及返佣账本均未变化。只有完整成功后才写入不可变审计证据，readiness 会在对象存储证据超过15分钟或 KAI 链证据超过30分钟后自动关闭。随后再运行 sidecar 与公网路由验证；未登录 `401` 只验证保护状态，不被当作统一身份可用证明。
- 支付私钥或证书中的换行以字面量 `\\n` 保存；进程只在内存中还原 PEM。

首次安装或发布新版本时，在新目录只运行 `npm run release:verify`。它会核对逐文件摘要、67 份迁移（含两个已发布分支各自的 0060 迁移，最新为 `0066_compute_data_flywheel_v1.sql`）、不含密钥文件、Node 版本，执行干净的生产依赖安装和编译入口加载，并验证 systemd/容器在缺配置时都能拒绝启动。全部通过后才能原子更新 `current` 软链接。安装本目录的三个 `.service`、两个 `.timer/.socket` 和防火墙单元后执行 `systemctl daemon-reload`。

任何 CloudPay 单元启动前，以目标主机实际 VPC 私网地址和 24 小时内保存的旧站基线运行：

```bash
npm run production:aws-host:preflight -- \
  --private-ip 172.31.x.x \
  --baseline /var/lib/kai-cloudpay-deploy/cloudpay-before.json \
  --report /var/lib/kai-cloudpay-deploy/host-preflight.json
```

该报告使用只创建不覆盖方式写入，且不记录环境变量值。它会核对 Linux/root 操作上下文、Node 与主机工具、无登录服务账户、真实 VPC 地址、4100/4154 空闲、`current` 指向本发布、发布树权限、0600 生产配置、完整能力门禁、安装后的 systemd/防火墙文件、0700 备份目录以及旧站基线时效。只有 `readyForMigrationAndSidecarStart=true` 才能继续迁移和旁路启动；报告已存在时必须换用新的带时间戳文件名，禁止覆盖旧审计记录。

## 无中断接入顺序

1. 保存旧站基线并运行目标主机预检；失败时不得启动迁移、后端或入口 socket。
2. 在隔离的 PostgreSQL 15 实例创建 CloudPay 数据库与最小权限账户，注入生产 Secret。
3. 启动 `cloudpay-mobile-migrate.service`，确认 67 条迁移均成功、两个 0060 分支迁移均已登记且最新为 `0066_compute_data_flywheel_v1.sql`；任何校验值不一致都会失败关闭。
4. 启动 `cloudpay-mobile-backend.service`，保持 `127.0.0.1:4100`，先检查 health、readiness 和业务冒烟。
5. 安装本目录的防火墙、socket 与 relay，目标安全组只允许 ALB 安全组访问 TCP `4154`。
6. 手动运行一次 `cloudpay-mobile-backup.service`，确认加密对象、不可变保留期和审计记录，再启用 `cloudpay-mobile-backup.timer`。
7. 运行旁路验收：`npm run production:sidecar:verify -- --private-ip 172.31.x.x --report /var/lib/kai-cloudpay-deploy/sidecar-probe.json`。它会比对回环与 VPC 入口的 health、readiness、四张法务页、正式11项目录、未登录身份/询期401以及非白名单404；只有 `readyForAlbTargetRegistration=true` 才能继续。
8. 新建独立目标组，健康检查 `/mobile/v1/health`；注册实例的私网地址和端口 `4154`。
9. 按 `cloudpay-mobile-alb-routes.json` 的六条精确 path condition 配置新规则。禁止使用 `/*`、`/api/*`、`/internal/metrics` 或默认转发。
10. 运行路由验证脚本；只有 readiness、法务页面和旧站保护全部通过才允许保留规则。
11. 验证报告只有 `decision=keep_mobile_routes` 时才允许保留新规则。出现 `decision=remove_mobile_routes` 时，按报告的 `rollback.removeOnly` 删除手机版路径规则；不得修改旧网站、旧 `/api/*` 或回滚已执行的向前兼容迁移。

每次更新版本都必须先停止流量切换，安装到新的只读版本目录，更新 `current`，再重启迁移与后端服务。若启动或验证失败，将 `current` 指回上一个完整版本并重启；数据库迁移均要求向前兼容旧版本，禁止回滚 SQL。

## 验证

上线前保存旧站基线：

```bash
node deploy/aws-ubuntu/verify-routing.mjs capture https://cloudpay.kai.com ./cloudpay-before.json
```

六条 ALB 规则启用后：

```bash
node deploy/aws-ubuntu/verify-routing.mjs verify https://cloudpay.kai.com ./cloudpay-before.json
```

验证会失败关闭，要求：

- `/mobile/v1/health` 是 `kai-cloudpay-backend` JSON；
- `/mobile/v1/readiness` 为 `200`，`deployment.ready` 与 `release.ready` 均为 `true`；
- `/mobile/v1/supplier-inquiry-catalog?limit=50` 返回精确11项，`/mobile/v1/me` 与买家询期列表未登录返回 CloudPay JSON `401`；
- provider、market、credits、orders 与 operator 等非白名单接口返回 CloudPay JSON `404 NOT_FOUND`，证明完整商城没有被误开放；
- 隐私、用户协议、询期规则和账户删除四张页面返回 CloudPay HTML，且删除页不调用 OTP；
- `/` 与 `/api/health` 的状态、内容类型和响应摘要与切换前一致。

报告同时给出机器可读的 `decision`。失败报告中的 `rollback.removeOnly` 固定为手机版 API 和四个公开页面路径，`rollback.preserve` 固定包含旧首页、旧 `/api/*` 和数据库迁移，避免现场把移动端回滚扩大成整站回滚。
