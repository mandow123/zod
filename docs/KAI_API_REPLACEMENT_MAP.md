# KAI Cloud 接口直接替换地图

版本：V1.0  
日期：2026-08-12  
原则：卡时闭环是唯一交易模型；废弃接口从客户端与运行时直接删除，不设置 legacy、兼容开关或旧客户端旁路。

## 1. 本批已经删除

| 已删除能力 | 原接口 | 当前替代 |
|---|---|---|
| 公开人民币挂牌 | `GET /mobile/v1/market/listings` | `GET /mobile/v1/market/resources`，只返回已验真资源事实，不含人民币价格 |
| 供应方自定人民币价并挂牌 | `POST /mobile/v1/supplier/listings` | 删除；后续由上架申请、资源审计、价格审计、平台发布四段接口替代 |
| 人民币资源订单创建 | `POST /mobile/v1/orders` | 删除；后续由卡时订单原子预留/扣款接口替代 |
| 算力订单收银台 | `POST /mobile/v1/orders/:orderId/payments` | 永久无对应接口；人民币不能支付算力订单 |
| 算力订单人民币支付查询 | `GET /mobile/v1/orders/:orderId/payment` | 永久无对应接口；卡时订单查询直接返回账本预留/扣款结果 |
| 旧订单、交付、退款、争议、发票运行路由 | `/mobile/v1/orders/**` 及其售后子路径 | 删除；随卡时订单、卡时退款和新交付状态机重新建立 |

## 2. 目标接口族

名称是实施基线；在对应领域模型和迁移落地时固化最终路径与请求结构。

### 2.0 同账号交易主体与提供工作区（已落地）

- `GET /mobile/v1/subjects`：自动确保一个个人主体，并返回当前账号可访问的个人/组织主体、成员角色、权限和当前选择。
- `POST /mobile/v1/subjects/organizations`：幂等创建组织主体；创建者成为 owner，不创建第二套登录账号。
- `PUT /mobile/v1/me/current-subject`：在同一登录会话内切换当前交易主体；服务端验证有效成员关系，客户端不能自行提升权限。
- `GET /mobile/v1/provider/bootstrap`：提供侧唯一启动入口，返回当前主体、资格、资源/方案/挂牌计数、最相关可恢复草稿和下一动作；明确 `requiresRelogin: false`。

供应资格、资源、商品方案与挂牌的读写授权已改为当前主体隔离。`owner/admin/provider_manager/provider_operator/viewer` 由服务端映射权限；viewer 可查看工作区但不能修改主体、资源、方案或挂牌。

### 2.1 资源与上架

- `GET /mobile/v1/market/resources`：已验真资源事实；无价格、无购买动作。
- `GET /mobile/v1/provider/profile` / `POST /mobile/v1/provider/profile`：读取或提交当前交易主体的提供资格。
- `GET /mobile/v1/provider/resources`：读取当前主体资源与验真状态；不返回原始资产编号或内部指纹。
- `POST /mobile/v1/provider/resources`：幂等创建 Resource Asset 并提交验真。硬件序列号/云资源 ID 以服务端带密钥指纹做跨主体权属保护，企业内部编号只在当前主体内去重；网络重试或同主体重复提交返回原资源和已有进度，不创建第二条验真任务。
- `GET /mobile/v1/provider/resources/:resourceId/evidence`：读取权属、配置、可用性三类材料状态和本轮验真进度；只返回文件名、大小与检查状态，不返回私有对象地址或下载地址。
- `POST /mobile/v1/provider/resources/:resourceId/evidence/uploads`：幂等登记资源材料并签发 10 分钟私有上传授权；仅支持 JPG、PNG、PDF，单份上限 20MB。
- `POST /mobile/v1/provider/resources/:resourceId/evidence/:evidenceId/upload-grant`：为仍未上传的同一材料续签上传授权。
- `POST /mobile/v1/provider/resources/:resourceId/evidence/:evidenceId/complete`：核对对象大小、类型、SHA-256 后进入安全扫描；客户端声明不能代替对象存储实检。
- `POST /mobile/v1/provider/resources/:resourceId/evidence/:evidenceId/discard`：仅允许删除未上传或未通过检查的材料；已送审材料不可替换。
- `POST /mobile/v1/provider/resources/:resourceId/evidence/submit`：权属、配置、可用性材料均通过安全检查后，固定本轮材料快照并把验真任务从“材料准备”推进到“平台审核”。重复请求只重放同一轮审核。
- `GET /mobile/v1/operator/resources/:resourceId/evidence`：运营读取当前送审材料包的脱敏目录；只有送审快照内的文件会出现。
- `GET /mobile/v1/operator/resources/:resourceId/evidence/:evidenceId/download`：运营取得 5 分钟私有下载地址；每次查看写入审计记录。
- `GET /mobile/v1/provider/offer-drafts`、`GET /mobile/v1/provider/offer-drafts/:draftId`：读取当前主体尚未提交的原生上架向导草稿，用于跨启动、跨设备恢复。
- `POST /mobile/v1/provider/offer-drafts`：只为当前主体已验真的资源创建不完整草稿；不生成正式商品，也不进入公开市场。
- `PUT /mobile/v1/provider/offer-drafts/:draftId`：以 `expectedVersion` 原子保存当前步骤和部分字段；版本落后时返回冲突，不静默覆盖其他设备内容。
- `POST /mobile/v1/provider/offer-drafts/:draftId/submit`：一次事务内校验完整性、生成正式商品并同时创建资源真实性与价格两份不可变审核；断线重放不重复生成商品。
- `GET /mobile/v1/provider/offers`、`GET /mobile/v1/provider/offers/:offerId`：读取已形成正式版本的商品方案及双审时间线。
- `POST /mobile/v1/operator/offers/:offerId/audits/:kind/decision`：资源或价格审核；两环必须由不同审核员完成，审核员不能审核自己的供应资源。
- `POST /mobile/v1/provider/listings`：双审通过后，供应方只选容量与时段并发布；服务端校验审核有效期、真实容量和时段冲突。
- `GET /mobile/v1/market/listings`：只返回双审有效的卡时挂牌、人民币参考价和审核标识，不恢复供应方自定人民币字段。

### 2.2 卡时账户与充值

- `GET /mobile/v1/credit-account`：可用、预留、待入账卡时。
- `GET /mobile/v1/credit-ledger`：签名游标分页的双分录账单。
- `POST /mobile/v1/topups`：按当前分发渠道创建人民币购买卡时请求。
- `POST /mobile/v1/topup-events/:channel`：只接收渠道验真的充值事件，再发行卡时。
- `POST /mobile/v1/topups/:topupId/reconcile`：主动核对不确定充值，不把客户端返回当成功。

### 2.3 卡时订单与交付

- `POST /mobile/v1/credit-orders`：校验已发布 Listing、审计版本、库存和卡时余额，原子预留容量与卡时。
- `GET /mobile/v1/credit-orders`、`GET /mobile/v1/credit-orders/:orderId`：返回卡时快照、账本引用和履约状态。
- `POST /mobile/v1/credit-orders/:orderId/cancel`：释放容量与卡时预留。
- `POST /mobile/v1/provider/orders/:orderId/delivery/start`：提供侧开始交付。
- `POST /mobile/v1/provider/orders/:orderId/delivery/ready`：提交交付凭证并进入验收。
- `POST /mobile/v1/credit-orders/:orderId/accept`：验收并按规则捕获/结算卡时。
- `POST /mobile/v1/credit-orders/:orderId/refunds`：卡时退回、供应收入和平台佣金冲正；满足充值原路退款条件时再走充值渠道退款。

## 3. 字段替换

| 已删除字段/语义 | 新字段/语义 |
|---|---|
| `unitPriceCents` / `unitPriceCny` 由供应方填写 | `referenceCnyMicros` 由价格审计保存，`unitCreditMicros` 由固定换算版本向上取整生成 |
| 订单 `currency: CNY`、`totalCents` | `creditCurrency: KAI_CREDIT`、`totalCreditMicros` |
| `payment_pending` / `paid` | `credit_reserving` / `credit_reserved` / `credit_captured` |
| `paymentIntentId` | `ledgerTransactionId`、`reserveEntryId`、`captureEntryId` |
| 支付渠道退款直接改变资源订单 | 先做卡时冲正；只有充值来源满足条件时才触发人民币原路退款 |
| 供应方挂牌即 `active` | `resource_audit_pending` → `price_audit_pending` → `approved` → `published` |

换算基线：`1 KAI 卡时 = ¥1.002`，统一使用人民币 micros 与卡时 micros 运算，最终卡时价格向上取整到 `1e-6`。

## 4. 数据处理原则

- 尚无生产交易数据：删除旧表和旧迁移，建立正确的卡时领域基线，不携带旧订单模型。
- 已存在真实交易数据：先只读导出、核对、归档，再执行一次性迁移；迁移完成后仍删除旧运行接口。
- 不允许双写旧订单与卡时订单，不允许用旧表作为新交易的事实源。
- 支付验签、幂等、事件去重、主动对账、退款补偿等安全算法可以抽取并重新命名，但不得保留“人民币直接购买算力”的领域语义。

## 5. 防回归覆盖

- 旧资源下单、供应方自定价挂牌、算力支付创建和查询路由必须为 `404 NOT_FOUND`。
- 公开资源接口响应不得出现 `unitPriceCents`、`unitPriceCny` 或 `currency`。
- 卡时闭环 readiness 不能通过环境开关开启，只能由五项实现状态共同决定。
- 新 Listing 接口已经覆盖资源审核和价格审核均通过、不同审核员、固定换算版本、有效期、容量与时段冲突；卡时账本与订单完成前仍不能交易。
- 同一账号重复启动只创建一个个人主体；组织创建幂等，切换不换登录会话；未加入的主体不可选择。
- 当前组织 A 不能读取或修改组织 B 的供应资格、资源、商品方案和挂牌；审核员只要属于被审主体就禁止自审。
- 提供侧启动接口优先恢复需补件/草稿/审核中方案，并给出可直接跳转的下一动作。
- 资源创建必须带幂等标识和不公开的资产编号类型；原值不落库、不回传、不进入公开市场或审计元数据。
- 资源创建后先进入材料准备；运营审核接口只能处理已固定材料快照的审核任务，不能越过缺件或安全扫描直接通过。
- 不同交易主体不能读取、续签、完成或删除对方材料；上传对象的大小、类型或摘要任一不符即拒绝进入扫描。
- 每轮送审固定三类材料的证据 ID 与摘要；驳回后的新一轮可以沿用仍有效材料，但新送审不能修改上一轮快照。
- 未完成向导与正式商品分表保存；输入即自动保存，但只有最终确认才允许生成两份审核记录。
- 同一草稿的过期版本不能覆盖新版本；最终提交重复调用只能重放同一正式商品，不能出现单边审核或重复商品。
