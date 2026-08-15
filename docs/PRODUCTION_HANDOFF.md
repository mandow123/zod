# KAI CloudPay 生产交接

更新时间：2026-08-15

## 当前结论

Android 本地完整后端已完成统一身份、提供方上架与算力履约闭环验收；生产环境尚未接管移动接口，且 `auth.kai.com` 尚未登记独立的 CloudPay mobile broker client，因此当前不得提交商店。

正式预检当前有四类阻塞：

1. `cloudpay.kai.com` 的移动 API、法务页和账户删除页仍由旧网站返回 HTML；新的上架后端尚未切流。
2. `auth.kai.com` 需要登记独立 confidential client，固定回调为 `https://cloudpay.kai.com/mobile/v1/auth/kai/callback`，并把 client ID/secret 只注入后端 Secret。
3. `com.kaicloud.marketplace` 尚未绑定真实 Expo 项目 UUID，正式 AAB 无法配置推送。
4. 缺少当前主前端源码指纹的历史 APK/AAB 已移出项目；生产配置齐全后仍需重新生成正式候选物。

## 已交付

- 后端部署包：`artifacts/release/KAI-CloudPay-backend-1.0.0-production.tar.gz`
- 后端 SHA-256：`83cb363962f893b7a82dd18d7f9e8c63cabaab782292e2eb1f2822213436f270`
- H100 节点执行端：`artifacts/release/KAI-CloudPay-H100-sidecar-1.0.0.tar.gz`
- H100 节点执行端 SHA-256：`2abb3a58b92380606a1807a6b5424b2ab87147f6ea0fdd9e86740f6c62f6a541`
- 数据库迁移：45 份，最新为 `0045_kai_oidc_mobile_broker.sql`
- 后端验证：55 个测试文件、244 项测试
- 部署包会在生成时从隔离目录执行生产依赖安装并独立加载编译入口；不能只依赖源码目录已有的开发环境。
- systemd 与容器两种入口都会在 API 启动前执行生产配置门禁；材料存储、安全扫描、推送、备份、法务或充值渠道不完整时直接拒绝启动。
- 目标机解压后只需运行 `npm run release:verify`；最新部署包已从全新临时目录实测 8 项全部通过，包括文件摘要、38 份迁移、生产依赖和两种失败关闭入口。
- 部署与路由契约作为打包门禁自动执行，当前 15 项全部通过：67 个环境变量均有来源，Kubernetes 明确覆盖 19 个公开设置和 57 个敏感设置，H100 令牌只进 Secret；API、迁移和备份任务使用同一配置来源和同一不可变镜像摘要；ALB 与 Kubernetes 只接管手机版 API 和三个法务页，失败报告只允许撤回这五条移动路由。
- 2026-08-14 再次读取线上：旧首页和 `/api/health` 的状态、内容类型与 SHA-256 仍逐字节匹配保存基线；所有手机版路径仍返回旧首页 HTML，因此当前没有误伤旧站，也尚未完成移动接口切流。
- 当前线上验证报告的机器判定为 `remove_mobile_routes`；实际切流后只有报告变为 `keep_mobile_routes` 才允许保留新规则。
- 移动接口合同：104 个前端调用、93 条后端路由
- Android 本地验收包：`artifacts/release/KAI-CloudPay-1.0.0-1-local-e2e.apk`
- Android 本地验收包 SHA-256：`8e83df6b6824584d21010df164f95173937b990454b32ddab8550a9b2b1d962b`
- 当前源码包：`artifacts/release/KAI-CloudPay-source-1.0.0.zip`
- 当前主前端源码指纹：`13937a08123b65b5e610d8edb4e44785f0c6f14d354228baa436d8343392cd72`
- 当前主前端源码指纹覆盖 App 入口、页面、原生分发代码、插件、配置和锁定依赖；旧包无法通过 `frontend_source_current`。
- 设备安装门禁 28 项全部通过；同时核对候选包与设备内 APK 的 SHA-256，历史同包名应用不能冒充当前主包。
- 正式登录页和本地验收登录页已在打包期物理隔离：正式包只含 `auth.kai.com` broker start/exchange/精确 App 回调，不含旧登录验证码接口、本地 E2E 路径或模拟器地址；本地包只显示明确的本机验收登录。
- 首次上架验收已覆盖注册承接、入驻必填锁定、审核退回原因、补件中断恢复、重新提交、审核通过和首份资源必填锁定。
- 入驻提交回包丢失时，App 会单独读取服务端主体资料；公司名称、联系人、脱敏信用代码和状态全部匹配才恢复成功提示，避免重复提交或把旧资料误判为本次成功。
- 提供工作台的“下一步”使用服务端返回的具体资源 ID：首次新增直接打开原资源发布表单，待补材料直接打开对应资源的三项材料清单，不再停在列表页让用户二次查找。
- “保存资源，继续”成功后立即衔接对应资源的验真材料页；相同资产的恢复请求复用既有资源，不会创建第二份资源或停留在已清空表单。
- 资源验真通过后，工作台按服务端资源 ID 直接创建该资源的上架方案，不显示资源选择页；新草稿的默认服务名称会先写入服务端，冷启动恢复后不变空，且只保留一份草稿。
- 首份资源已在 Android 完成三类材料上传、安全检查、冷启动恢复和提交审核；连续点击只生成一个审核批次，待提交与审核中状态已前后端分流。
- 资源退回后只替换被拒材料，具体原因跨冷启动保留；上架方案半成品核价凭证也可跨退出恢复，提交时仍执行完整校验。
- 同一主包已实测完成方案双审、100 GPU时挂牌和购买视角市场可见，方案提交与挂牌连续点击均只生成一条服务端记录。
- 资源创建、重新送审、方案创建、方案提交、挂牌发布及挂牌状态切换均只在服务端支持安全重放时自动重试；提交回包丢失后，App 会读取材料清单、已提交草稿、方案版本或挂牌列表确认真实结果，不把超时直接当成失败，也不会重复创建。
- 材料文件在登记后、上传完成前断网时，App 会保留同一材料任务；重新选择同一文件取得新上传许可后继续，选择不同文件则先安全撤销旧任务再重建，避免弱网下反复生成残留记录。
- 方案自动保存也执行服务端版本回读：保存回包丢失或返回版本冲突时，只有服务端出现更高版本且步骤、内容与本地本次编辑完全一致才显示“已保存”；否则保留当前输入，网络恢复后可点“未保存”重试，真实跨设备修改继续阻止覆盖。
- 放弃草稿回包丢失时，App 会重新读取服务端草稿列表；只有原草稿确实不再存在才同步移除页面、内存和加密缓存，否则继续保留，避免用户误以为已经放弃。
- 过期方案重新送审支持同一请求安全重放；回包仍丢失时，App 只在服务端返回同一方案、状态为审核中且方案版本与提交版本均恰好增加一版后确认成功，避免重复生成审核任务。
- 提供方确认接单和开始交付会在自动重试及用户再次点击时复用同一请求标识；回包仍丢失时，只有同一订单出现服务端接单时间或交付开始时间并进入对应后续状态才确认完成，其他订单变化不会被误判为本次成功。
- 本机 Android 验收模式会按请求手机号读取本地后端刚生成的六位验证码并自动带入，已实测从手机号登录直达空白 H100 资源表单；该能力由构建时本地验收开关隔离，正式构建默认关闭。
- 双审消息已按整份方案状态给出下一步：资源审单独通过时仍显示“查看方案”，只有资源审与价格审均通过才显示“去上架”，并直接打开该方案的容量时段发布页。
- 已实测挂牌暂停与恢复：暂停后购买市场从 1 条变为 0 条；恢复后重新显示同一挂牌，挂牌 ID、100 GPU时容量和 `31.137725` 卡时审核锁价均不变，没有重复发布。
- 挂牌暂停、恢复或结束连续两次收不到回包时，App 会读取该主体挂牌列表；只有同一挂牌达到目标状态才更新页面，并立即同步内存与加密缓存，避免后续弱网读取把页面退回旧状态。
- Android 已实测买方发起重新交付、提供方读取原始原因并二次交付；订单回到待验收时，买方预留卡时保持不变且没有重复订单。
- Android 已实测提供方处理全额退款；确认页展示准确退款数，完成后买方卡时和可售容量同步恢复，提供方待结算不增加，全额退款后的剩余金额显示为 0。
- 有争议的订单即使列表摘要未携带操作按钮，也会计入提供工作台“需要处理”并排在普通记录之前，避免退款或重交付请求被隐藏。
- 当前回归结果：前端 109 项、后端 244 项、H100 sidecar 41 项、移动接口合同 104 个调用/93 条路由、Android 设备门禁 28 项全部通过。
- 本地算力闭环已从干净数据库实测：8×H100、每卡 98GiB 的资源通过资源审与价格审后挂牌；首单冻结 `31.137725` 卡时，`ready` 阶段计费为 0，首次成功访问后才进入 `running`；停止后按 `0.600000 GPU时` 结算 `18.682635` 卡时并退回 `12.455090` 卡时。
- 并发门禁已实测：8 笔单卡订单同时开通，第 9 笔返回 `LISTING_CAPACITY_UNAVAILABLE`；拒绝前后余额、预留额和订单数不变。模拟开通失败超过 5 分钟后订单全额退款，释放的槽位可立即承接下一单。
- 正式 Android 构建现在要求 EAS 登录查询结果与显式项目 UUID 一致，并要求二选一提供商店最高 `versionCode` 或“从未上传”声明；缺失、冲突或候选版本不更高时在 Gradle 启动前失败。
- 已生成隔离的 Google Play 本地测试 APK/AAB；测试 APK 已在 Android 逐页通过 29 项门禁，确认充值和新增购买关闭，同时工作台、资源、上架、消息、我的及完整提供方接口均可用。测试物位于 `artifacts/test`，不属于正式候选物。
- 算力订单不进入通用商品的 7 天售后：实例与连接验真成功后才开始计费；验收前计量异常可申诉，验收后不能按通用商品规则退款。
- 算力订单无需资源方手动接单。购买事务在锁定可售 GPU 槽位后自动确认并触发交付；5 分钟仍未成功交付时原子化全额退款并恢复容量。
- App 不接触 H100 sidecar 地址或访问票据；私有后端可在票据有效期内重放同一请求恢复同一份 SSH 凭据，不会生成第二把密钥或重复启动计费。
- 首次取 SSH 前若节点同步健康检查明确失败，且订单尚未进入使用，系统只会产生一笔全额退款并释放 GPU 槽；与首次访问并发时由行锁保证“成功使用”或“失败退款”二选一。
- 停止算力采用两阶段处理：先固定首次停止时的计费截止并撤销凭据，再停止容器；容器停止失败后的重试不会继续累计费用。
- 下单创建成功后先打开该订单，再后台刷新账户与列表；刷新阶段断网不会覆盖成功结果，原请求键仍阻止重复下单和重复冻结。

## 生产配置分层

### 上架核心

这些能力缺失时，资源方无法稳定完成登录、材料上传、验真和上架：

- PostgreSQL：`DATABASE_URL`，生产建议启用 `DATABASE_SSL=true`
- 访问与数据保护：`ACCESS_TOKEN_SECRET`、`REFRESH_TOKEN_PEPPER`、`OTP_PEPPER`、`PII_ENCRYPTION_KEY`、`AUDIT_PEPPER`、`CURSOR_SECRET`
- 统一身份：`KAI_OIDC_CLIENT_ID`、`KAI_OIDC_CLIENT_SECRET`、独立的 flow/subject pepper、32 字节事务密钥，以及 `kaicloudpay://auth/kai/callback` 精确白名单
- 私有材料存储：`OBJECT_STORAGE_PROVIDER=s3`、HTTPS endpoint、region、bucket 与最小权限凭据
- 材料安全扫描：`CLAMAV_HOST`、`CLAMAV_PORT`
- 节点接入：三把彼此独立的 `NODE_GPU_FINGERPRINT_PEPPER`、`NODE_CLAIM_TOKEN_PEPPER`、
  `NODE_CLAIM_TOKEN_ENCRYPTION_KEY`（32 字节 Base64），以及明确的 `NODE_SUPPORTED_AGENT_VERSIONS`
- 生产入口：`NODE_ENV=production`、`HOST=127.0.0.1`、`PORT=4100`、`PUBLIC_ORIGIN=https://cloudpay.kai.com`

### 运营可靠性

- 推送：`PUSH_PROVIDER=expo` 与包含有效 access token 的 `PUSH_CREDENTIALS_JSON`
- 指标：长度至少 32 的 `METRICS_BEARER_TOKEN`
- 加密备份：32 字节 base64 密钥、key id、本地暂存目录、独立 S3 bucket/凭据和对象锁
- 法务及客服：运营主体、统一社会信用代码、支持邮箱/电话、隐私与协议地址、ICP备案和 APP 备案

### 卡时交易闭环

至少配置并验真一个真实充值渠道：支付宝或微信。回调必须精确指向：

- `https://cloudpay.kai.com/mobile/v1/credits/topups/alipay/notify`
- `https://cloudpay.kai.com/mobile/v1/credits/topups/wechat/notify`

配置值不完整、证书不一致或回调地址不精确时，`release.ready` 保持关闭。

## 切流顺序

1. 在隔离数据库运行 45 份迁移并通过 schema readiness。
2. 解压部署包后先运行 `npm run release:verify`，8 项全部通过；安装目标机单元与生产配置后，再运行 `npm run production:host:preflight -- --private-ip 172.31.x.x --baseline /absolute/cloudpay-before.json --report /absolute/host-preflight.json`。21 项全部通过才允许迁移和旁路启动。
3. 完成一次加密备份与恢复演练记录。
4. 运行 `npm run production:sidecar:verify -- --private-ip 172.31.x.x --report /absolute/sidecar-probe.json`；回环与 VPC 入口的十个关键路径完全一致后，才允许注册 ALB 目标。
5. ALB 接管 `/mobile/v1`、`/mobile/v1/*`、节点签名通道 `/node/v1/*`、`/privacy`、`/terms`、`/account/delete`；首页和 `/api/*` 保持原目标组。节点通道不得记录 Authorization 或请求体。
6. 运行包内 `deploy/aws-ubuntu/verify-routing.mjs`。它会同时检查旧首页、旧 `/api/health`、release readiness、法务页以及五组关键上架接口。
7. 绑定真实 Expo 项目 UUID，查询商店已用最高 `versionCode`，重新构建正式 APK/AAB。
8. 运行 `npm run release:preflight`，只有报告 `ready=true` 才能提交。

## 当前需要外部提供

- AWS 香港区账户或由现网运维执行上述部署；当前工作机没有 AWS 登录身份，未改动线上 ALB。
- auth.kai.com 管理方登记独立 CloudPay mobile broker client，提供后端专用 client ID/secret，并确认与主站 client 的 `sub` 对同一账号保持一致。
- Expo/EAS 项目所有者登录并绑定 `com.kaicloud.marketplace`，提供真实项目 UUID 和推送凭据。
- Google Play/国内商店中该包名已使用的最高版本码；如果版本码 1 已被任何轨道占用，主包必须先升到 2 或更高。
- 运营主体、备案、短信、对象存储、扫描、监控、备份和至少一个充值渠道的生产凭据。

任何密钥都只写入 `/etc/kai-cloudpay/backend.env` 或受管 Secret，不进入项目目录、部署压缩包、聊天记录或命令行。
