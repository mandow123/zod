# KAI H100 执行端

这是部署在 H100 节点上的最小执行端。它把已确认的卡时订单变成独占 GPU 租约，签发一次性 SSH 凭据，按实际运行时长计量，并在到期、容器异常或人工停止时生成可重放的签名回执。

当前交易口径固定为：一个订单分配 1 张 GPU，单位只能是 `GPU时`。8 卡节点最多同时运行 8 个租约；GPU 以 `nvidia-smi` 返回的 UUID 独占锁定，不能超卖。

## 网络边界

- `9443` 控制面只绑定节点 RFC1918 私网 IP，同时再校验 backend 私网 IP 白名单。安全组只允许 backend 私网 IP 访问。
- App 不连接 sidecar，也不会收到 sidecar 地址或 ticket。backend 在私网内创建并兑换 ticket，然后只把最终 SSH 资料通过登录态 mobile 接口返回 App。
- SSH 端口段绑定节点批准的私网地址，可由独立公网入口/NAT 映射给买方；不要把 `9443` 一起暴露。
- 租户容器使用 Docker `internal` bridge、关闭 IPv6 和容器互访，默认完全禁止出站。这会阻止访问云元数据、VPC、数据库，也意味着容器内不能直接下载软件。以后如需联网，应增加受控代理，不要直接打开 VPC 出站。

## 上机前需要你提供

在 H100 上执行并把结果交给部署人员：

```sh
findmnt -no FSTYPE,OPTIONS,TARGET --target /实际数据目录
df -B1 --output=size,used,avail,target /实际数据目录
nvidia-smi --query-gpu=uuid,name,driver_version --format=csv,noheader
```

还需要：

- 节点私网 IP、backend 私网 IP、用户实际连接 SSH 的域名/IP及端口映射；
- 受信 TLS 证书与私钥；
- 平台真实 `resourceId` 与允许分配的 GPU UUID；
- 经审核的 CUDA 基础镜像 digest、镜像仓库地址；
- 至少 32 字符的当前 provider token、ticket secret；token 轮换期可短时保留 previous token。

执行端不会自动格式化磁盘、修改挂载或迁移现有约 3.4TB 数据。workspace 必须位于已启用 `pquota`/`prjquota` 的 XFS 文件系统；若现有 7TB 盘不满足，需要新建独立卷或由运维制定无损迁移方案。

默认每个活跃租约预留 250GiB，宿主保留量取 `500GiB` 与文件系统总量 `15%` 中较大者。preflight 和每次开通都会检查：

```text
可用空间 >= 活跃租约数 × 单租约配额 + 宿主保留量
```

## 构建工作镜像

基础镜像必须用真实 digest 固定。构建机必须安装 Trivy：

```sh
cd /opt/kai-h100-sidecar
./scripts/build-workload.sh \
  'nvidia/cuda:<实际版本>@sha256:<真实64位摘要>' \
  '你的仓库/kai-h100-workload:<审核标签>'
```

脚本在存在 CRITICAL 漏洞时失败。审核后手动 push，再从仓库取得 `RepoDigest`，把 `仓库@sha256:...` 填入 `SIDECAR_WORKLOAD_IMAGE`。本仓库不会放置假 digest，也不能把本地 image ID 当成发布 digest。

镜像内固定用户 `kai`（UID/GID 1000），禁用 root、密码认证、PAM、端口转发和隧道。用户只能写 `/workspace/data`；`.access/authorized_keys` 和租约 host key 始终由 root 控制。

## 安装

```sh
cd h100-sidecar
sudo ./deploy/install.sh
sudoedit /etc/kai-h100-sidecar/sidecar.env
sudoedit /etc/kai-h100-sidecar/resource-policies.json
```

在 `sidecar.env` 中先填写平台给出的生产 HTTPS 根地址 `SIDECAR_BACKEND_BASE_URL`。认领 JSON 中的
`backendBaseUrl` 必须与这个受保护配置完全一致；Sidecar 不会把一次性 token 发送到仅由认领文件指定的地址。

### 一次性认领节点

后台/App 生成的节点认领资料是一次性秘密。不要把 JSON 放在命令参数、`printf` 或 shell history 中。
安装后只运行下面一条命令，在隐藏回显的提示中粘贴 App 给出的单行 JSON并回车：

```sh
sudo kai-h100-sidecar-enroll
```

导入器只接受后台协议 v1 的完整 JSON：`protocolVersion`、HTTPS `backendBaseUrl`、`deploymentId`、
`claimId`、`claimToken`、`challenge`、`expectedPolicyDigest`、`expiresAt`、`consumePath`。不允许额外字段，
`consumePath` 必须与 claimId 精确一致。文件以 root:root 0600 原子写入
`/var/lib/kai-h100-sidecar/node-claim.json`。systemd 启动前会使用持久 Ed25519 身份完成认领和首个心跳；
成功持久化后台返回的 node/binding/deployment 后才删除 token。响应丢失可安全重放，不会生成假节点。

认领完成后，再根据后台返回的真实 node/binding/policy 信息填写资源策略，然后执行：

```sh
sudo node /opt/kai-h100-sidecar/scripts/preflight.mjs
sudo systemctl restart kai-h100-sidecar.service
sudo systemctl status kai-h100-sidecar.service
```

出站只接受严格校验的 HTTPS（最低 TLS 1.2），默认使用系统信任链；私有 CA 才设置
`SIDECAR_BACKEND_CA_FILE`。网络错误和 5xx 会指数退避并加入抖动；401/409/410、过期 claim、TLS
证书错误或响应身份不一致会立即封闭失败。日志不写 claim token、签名、请求正文或 GPU UUID。
心跳返回 `checking` 时仍会确认已消费的证据并继续上报，但执行端拒绝新租约；只有后台明确返回 `ready`
才允许开通新算力。后续任何策略、驱动、CUDA 或 GPU 证据漂移都会立即恢复为拒绝新租约状态。
平台确认断开旧 deployment 后，可在同一服务器再次运行 `sudo kai-h100-sidecar-enroll` 导入新 claim。
执行端保留稳定 Ed25519 身份，只在后台确认新 deployment 后清除旧心跳进度并从新节点序列 1 开始；
新 claim 被拒绝时不会覆盖磁盘上的旧 enrollment。

每条资源策略除 GPU UUID 和硬件约束外，必须填写平台审核生成的 `bindingId`、`bindingGeneration`、
`policyDigest`、`nodeId`。sidecar 会在启动预检和每次开通前逐项精确核对；任一字段缺失、格式不合法或与
backend 请求不一致都会在创建容器前拒绝。四个字段同时写入租约持久状态，并由开通 attestation 的 HMAC
签名覆盖，旧绑定上的同一租约标识不能重放到新绑定。

preflight 全绿后才可启动：

```sh
sudo systemctl enable --now kai-h100-sidecar
sudo systemctl status kai-h100-sidecar
```

如果已经存在名为 `kai-h100-leases` 的旧网络且策略不符，preflight/sidecar 会失败关闭；不要在有活跃租约时直接删除网络，应先停单并按维护窗口处理。

## 真实验收

登录尚未接好时先不要伪造通过。登录可用并创建真实测试订单后，在受控机器上提供一次性测试用户 token：

```sh
KAI_ACCEPTANCE_BACKEND_URL=https://你的backend \
KAI_ACCEPTANCE_ORDER_ID=<真实测试订单UUID> \
KAI_ACCEPTANCE_USER_TOKEN=<测试用户短期token> \
KAI_ACCEPTANCE_EXPECTED_GPU_UUID=<本单审计分配的GPU-UUID> \
npm run acceptance
```

验收会通过 backend 取得一次性凭据，并用 `StrictHostKeyChecking=yes` 核对每租约 Ed25519 host fingerprint，真实 SSH 后检查：UID=1000、`/workspace/data` 可写、只能看到分配的 GPU、`authorized_keys` 不可修改。

首次兑换凭据前会同步复核容器健康、容器安全策略、实际可见 GPU 和该会话公钥。任一项失效都不会写入计费起点；从未成功进入的租约直接进入失败退款链。停止采用两阶段处理：先持久化首次停止请求的计量截止点并撤销全部公钥，再停止容器和生成签名回执；Docker 停止重试期间不会继续累计用量。

若 access 响应在网络中丢失，App 继续复用同一 access 请求标识；backend 在有效期内以同一私有 session/ticket 安全重放兑换，恢复完全相同的 SSH 凭据，不新建会话、不重置计费起点。ticket 始终不进入 App；错误、过期或已撤销的 ticket 必须拒绝。private key 和 ticket 不写日志，sidecar 只持久化不可直接使用的 ticket 摘要与加密私钥封装，mobile 响应使用 `Cache-Control: no-store, private`。

租约停止后进入 24 小时验收窗。买方可在窗内确认实耗或提交计量/接入异议；无异议且买方未操作时，backend worker 在截止后按 sidecar 签名计量自动执行同一套“实耗卡时结算、未用卡时退回”。开放异议不会自动结算。接口在 `fulfillment` 中返回 `acceptanceDueAt` 和 `acceptanceMode`（`pending|buyer|system|operator|disputed`）。

## 当前不能在开发机宣称完成的门禁

- H100 上的 Docker/NVIDIA Container Toolkit/驱动实测；
- 实际数据盘的 XFS project quota 与总空间预算；
- 工作镜像真实 registry digest 与漏洞扫描；
- 私网安全组和 SSH 公网映射；
- 真实订单的端到端 SSH、GPU、配额写满拒绝测试。

这些项目由 preflight/acceptance 在目标 H100 上给出结果；任何一项未通过，资源都不应上架。
