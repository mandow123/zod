# KAI Compute Data Flywheel V1：审计、Gap Analysis 与接入契约

审计基线：`mandow123/zod` main，commit `4a6236ec9bc3ae04f54713617a388f0b0aed7a6f`。

## 1. 先说结论

- 当前生产运行配置是 `inquiry_only`。它开放正式询价需求，但关闭订单、预留、开通、履约、Vast 和相关 worker。现有数据库结构具备较完整的成交后骨架，不等于现网已经产生这些数据。
- 本次没有获得生产 `DATABASE_URL` 或数据库只读快照，因此没有验证线上行数、来源占比、字段覆盖率或真实完整链。下文“已记录”指代码和 schema 能记录；唯一可确认的生产写入口是 `resource_inquiries`，不能据此声称线上已经存在记录。
- 现有最大缺口在成交前：没有可关联的 demand → impression/candidate → ranking → selection；尤其没有保存未选择候选、候选当时特征、分项分数和策略版本。
- 0062 的 11 项鸿寰目录、0064 的 100 家供应商报价目录，以及 local E2E / staging sandbox 都不能当作真实库存、真实价格或训练标签。
- V1 只新增 4 张追加式表和 2 个只读 view，直接位于现有 PostgreSQL。没有训练模型，也没有另建数据平台。

## 2. 现有数据审计

| 领域 | 已有对象与可用信息 | 当前真实性边界 | 可作为 feature | 可作为 label | 主要缺口 |
|---|---|---|---|---|---|
| GPU inventory | `compute_resources`：supplier、kind、product、region、specifications、capacity、status、verification | schema 存在；inquiry-only 不实例化正式 market service。0062/0064 是 reference/unverified，不是库存承诺 | GPU 型号、显存/规格、区域、容量、验证状态 | 后续可用“是否真实可供给” | 缺历史可用量快照；更新会覆盖当前值 |
| Supplier | `supplier_profiles`、trading subject、验证与状态；0064 supplier directory | 正式 supplier 与 reference directory 是两套语义；目录 100 家均 unverified/inquiry_required | supplier、区域、能力、验证状态 | 审批、后续履约成功/失败 | 缺统一 supplier reliability 时间序列 |
| Pricing | `market_listings.unit_price_*`；Vast quote；0062/0064 reference quote | listing 是当前状态；0064 明确 `reference_only`；Vast 在 inquiry-only 关闭 | 当时挂牌价、配置、区域、有效期、policy | 接受价、最终费用 | 缺每次候选曝光时的历史价格/库存快照 |
| Quote | `vast_external_quotes` 有 provider snapshot、成本、报价、policy、quoted/expires time | full-commerce/Vast 当前关闭 | provider snapshot、duration、quoted price、policy | consumed/stale/expired | 普通撮合没有 demand/ranking 关联 quote |
| Demand | `compute_demands`；生产入口 `resource_inquiries` 记录 candidate、时段、数量、预算、use case、环境、网络、存储、状态 | `resource_inquiries` 是可确认的正式代码路径；实际线上是否有行未验证。`compute_demands` 未见当前 production route | GPU/区域/数量/时长/预算/use case | cancelled/expired/declined（较弱） | inquiry 已先绑定一个 candidate，不能还原完整候选池与排序 |
| Routing / Ranking | Full-commerce Backend 已接入 `POST /mobile/v1/intelligence/recommendations` 规则 baseline | 读取已验真 public listings，先做硬过滤再打分；每次返回前事务性保存 demand、全部 eligible/rejected 候选、原因、component score、最终 rank 和 policy version | 结构化任务/资源/价格/容量/SLA、component score、rank、policy | 后续 selection/fulfillment labels | 当前生产 profile、0066 migration 和真实流量尚未验证；inquiry-only 不暴露该路由 |
| Reservation | `capacity_reservations`、KAI credit reservation、Vast reservation transaction | schema 完整；inquiry-only 关闭执行服务 | 预留量、资源、过期时间 | reservation success/failure | 无 ranking candidate/request 外键；失败原因不统一 |
| Provisioning / fulfillment | `compute_fulfillments`、append-only fulfillment events、provider lease、状态时间、failure code | schema 完整；inquiry-only 关闭执行服务 | supplier/resource/provider、配置、时段 | provisioning success、latency、completion、failure | 与 recommendation/request 不相连；重试 attempt 维度不足 |
| Telemetry | `metering_samples`；`compute_fulfillment_metering` | 有证据摘要与时间，但后一对象每 fulfillment 只有一条最终计量 | observation、usage、unit、source | actual usage、completion cost | 缺统一 uptime/interruption/SLA 样本；部分最新状态会覆盖历史 |
| Settlement | KAI credit supplier settlement、compute fulfillment supplier settlement、fee/payout | schema 完整；inquiry-only 关闭 | fee/policy/supplier/order | settled、settlement latency、final cost | 没有 journey request/ranking/candidate 关联 |
| Failure / refund | fulfillment failure、order events、refund、dispute、issue/decision、Vast failure | 多套业务各自记录 | supplier/GPU/task/time、failure stage | failure、reason、refund、dispute outcome | reason taxonomy 分散，跨业务不可直接比较 |
| Admin | OIDC/RBAC/session/audit；P0 只读 overview、compute orders、device orders、payouts、topups | 正式 Admin 基础存在；不是 Data/Intelligence 面板 | — | — | 当前无漏斗、候选覆盖、supplier reliability、价格/需求分布 |

### Demo / seed / reference 的硬边界

1. `0062_honghuan_supplier_inquiry_catalog.sql`：supplier 和 quote evidence 均 unverified；price 是 `reference_only`；availability 是 `inquiry_required`；`purchasable=false`、`inventory_commitment=false`、`order_creation=false`。
2. `0064_supplier_quote_directory.sql`：用户提供的 100 家 supplier workbook；`verification_status='unverified'`，所有条目默认 inquiry-only、非库存承诺、不可购买。
3. `scripts/local-e2e-demo-catalog.ts`：100 条 local E2E 演示资源，sandbox only、不可购买、模拟审计。
4. `staging-sandbox`：所有业务对象均有 staging/simulation 边界。

这些数据可以测试 schema 和 UI，但禁止进入 business 训练导出，也禁止回填“成功履约”等真实 label。

## 3. Gap Analysis

### P0：没有它就不能训练 Ranking

- 没有一个贯穿全链的 request ID。
- 没有 impression/ranking run。
- 没有保存未选择候选和被过滤候选。
- 没有候选的 point-in-time price、availability、SLA 和 feature snapshot。
- 没有 score、component scores、rank、algorithm/policy version。
- selection、quote、reservation、fulfillment、settlement 不能回连当时的 candidate。

### P1：已有结果数据，但口径不可直接训练

- 失败原因分散在 payment/order/Vast/fulfillment/refund/dispute 多套字段。
- pricing 以“当前 listing”或单次 quote 为主，没有统一历史曝光价格。
- supplier reliability 缺统一的 quote response、provisioning latency、uptime、interruption、SLA 事件。
- telemetry 有 metering 证据，但没有统一高频运行质量快照和中断标签。

### P2：可观测性和治理

- Admin 没有从原始事件可追溯的漏斗和分布指标。
- 没有自动检查候选计数、跨阶段缺父事件、错误时间顺序。
- 没有明确隔离 business / seed_reference / demo / synthetic。

## 4. Event Logging V1

迁移：`0066_compute_data_flywheel_v1.sql`。

只新增以下对象：

1. `compute_data_requests`
   - 一条结构化 demand；保存 source entity、raw structured requirement、parsed requirement、版本、发生/记录时间、source/version、environment、data origin、trace。
   - raw requirement 只用于内部追溯，不进入训练 view。
2. `compute_ranking_runs`
   - 一次可重放排序；保存 request、algorithm/policy version、context、expected candidate count 和幂等摘要。
3. `compute_ranking_candidates`
   - 一次排序的全部候选，包括未选中和不合格候选。
   - 保存 feature snapshot、score、component scores、rank、eligible/rejection、listed/quoted price、quantity/duration、availability/SLA 以及 price/inventory observation time。
4. `compute_journey_events`
   - append-only outcome：viewed/clicked/selected、quote、reservation、provisioning、fulfillment、SLA、telemetry、settlement、failure/refund/feedback。
   - 保存业务 entity IDs、accepted/final price、latency、reason code、payload、source/version/data origin。

### 最小可还原链

```text
compute_data_requests
  -> compute_ranking_runs
     -> compute_ranking_candidates [A, B, C ... 全部候选]
        -> selected(B)
        -> quote_created / quote_accepted
        -> reservation_succeeded | reservation_failed
        -> provisioning_started / succeeded | failed
        -> fulfillment_started / completed | failed
        -> telemetry_observed / sla_violated
        -> settlement_completed | refund_requested / refunded
```

`compute_training_dataset_v1` 每行是“一次 ranking 中的一个 candidate”。因此 A 被推荐但用户选择 B 时，A 和 B 都存在；`selected`、`completion` 等 label 各自落在候选行上。需求预测使用时必须按 request 去重，不能把 candidate 行数当需求数。

`compute_data_quality_issues_v1` 首批检查：

- expected/actual candidate count 不一致；
- ranking 早于 demand；
- outcome 早于 ranking；
- quote accepted 缺 quote created；
- provisioning 缺 reservation；
- settlement 缺 fulfillment completion。

服务层另外拒绝：UUID/金额/时间/候选排名无效、候选或排名重复、负价格、不合格候选无原因、未知 GPU、敏感字段、缺父实体、错误状态迁移、同一 source event 内容冲突、seed/reference 冒充 business label。

## 5. 接入约束

- `ComputeDataFlywheelService.captureRanking()` 已由 Compute Intelligence recommendation domain 调用，并在返回前用一个事务写入 demand、ranking 和全部 candidates。禁止遍历候选逐条异步上报。
- Outcome 没有开放允许客户端任意伪造 success/refund 的通用 HTTP endpoint；`selected/quote/reservation` 由订单事务产生，`provisioning/fulfillment/telemetry/settlement/refund` 由履约事务产生。
- 后续业务事务通过订单既有 `listing_snapshot` 恢复 `requestId/rankingRunId/candidateKey`，并在同一个 PostgreSQL 事务调用 V1 writer；没有新增表、列或投影/outbox 层。找不到 lineage 的历史或非 recommendation 订单保持原业务行为且不伪造标签。
- UI 的 `viewed/clicked` 可在下一步增加一个窄、认证、限流、幂等的客户端入口；`selected` 及之后的 label 必须由服务端业务状态产生。
- 原始自然语言需求、邮箱、手机、姓名、地址、IP、token、cookie、authorization、自由文本 notes/message 等禁止进入 feature/event payload。训练 view 只导出 parsed structured requirement。

## 6. 匿名化导出

先构建，再从受控主机运行：

```bash
npm run build
COMPUTE_DATA_EXPORT_PEPPER='<独立且至少 32 字符的密钥>' \
DATABASE_URL='<只读或受限数据库连接>' \
npm run data:export -- \
  --from 2026-08-01T00:00:00.000Z \
  --to 2026-09-01T00:00:00.000Z > compute-training-v1.ndjson
```

导出规则：

- 只导出 request 和 candidate 都是 `business` 的行；
- request/ranking/candidate/resource/supplier/listing ID 使用按字段域隔离的 HMAC pseudonym；
- 不导出 raw IDs，不导出 raw requirement；
- 最多 50,000 行；超过上限会整次失败并要求缩小时间窗口，禁止静默截断；
- 同一密钥产生稳定匿名 ID；密钥不得写入仓库或导出文件。

## 7. Algorithm Readiness 门槛

达到门槛前继续使用可解释规则 baseline。门槛不是固定“100 条”，而是同时满足覆盖率、时间、标签和多样性。

| 模型 | 进入实验的最低证据条件 |
|---|---|
| Price Prediction | business 历史跨多个价格周期；GPU/region/supplier/quantity/duration/SLA 覆盖可接受；listed→quoted→accepted→final price 链完整；价格与库存 observation time 缺失率受控；supplier/GPU 不被少数主体垄断 |
| Learning-to-Rank | 每个 run 的全部候选覆盖率接近 100%；未选中候选真实保留；view/click/select/quote labels 稳定；多策略版本和足够时间跨度；位置偏差可评估；无 seed/demo |
| Supplier Reliability | 足够多的 completed 与 failed fulfillment；多个 supplier/GPU/task/time bucket；provisioning latency、failure reason、SLA/refund 完整；失败 taxonomy 稳定 |
| Demand Forecasting | 连续、无大段缺口的 demand 时间序列；按 request 去重；GPU/region/use case 覆盖；跨工作日、周末和季节周期；渠道/版本变化可解释 |

进入训练前必须生成 readiness report，至少包含：business sample count、feature non-null coverage、label completeness、time span、supplier diversity、GPU diversity、origin contamination、policy-version distribution 和 temporal split 可行性。

## 8. 当前验收状态与剩余项

已完成并本地验证：

- 0066 schema、append-only/外键/唯一约束；
- 全候选 ranking capture、幂等冲突、状态迁移；
- outcome label 回填与数据质量 view；
- business-only HMAC 匿名 NDJSON 导出；
- schema/readiness/backup/release gate 从 0065 同步到 0066；
- PGlite 端到端测试：A 排第一、用户选择 B、C 不合格，仍保留全部候选并完成 B 的结算链。
- Compute Intelligence 已接到真实 listing store；推荐写失败会 fail closed，不返回无法留痕的排序。
- 推荐 run 绑定买方 subject、候选 listing 和推荐数量；跨主体、篡改数量、重复成功使用同一 run 都不能建立 lineage。
- 订单与 fulfillment 同事务回填已覆盖成功链和 `reservation_failed` 失败链；production-shaped 本地 canary 的 trace、business-only 匿名导出和 quality 0 issue 已通过。

尚未完成、因此不能宣称“现网已经开始产生完整飞轮数据”：

1. 没有生产数据库访问，未执行 0066 migration，也未验证线上数据分布。
2. 当前环境没有生产主机/集群凭据、获准 canary 身份或 export pepper；因此尚未运行真实 production journey，也没有把本地 synthetic/PGlite 结果冒充业务数据。
3. 当前移动端尚未挂载 Compute Intelligence 入口；后端 full-commerce API 可供获准 canary 直接调用，inquiry-only 仍按设计不暴露 ranking。
4. Admin Data / Intelligence 面板与模型训练均按冻结要求未启动。
5. 既有 0065 backup/readiness/app-session 证据在 0066 发布后不再满足门禁，必须重新生成；禁止修改旧证据冒充新版本验证。
6. Backend production dependency audit 为 0；仓库根 Expo/Metro 构建链仍有 5 个 high、11 个 moderate 的既有 npm audit 项。它们不是本次 Backend 变更引入，自动修复建议会把 Expo 57 降到不兼容的 46，因此本次未做破坏性依赖改写；整体移动端发布前仍需单独处置和复验。

生产验收必须额外满足：迁移成功、真实 routing 写入全候选、服务端 outcome 自动回填、一次真实或获准 canary journey 可按 request ID 完整追踪、匿名导出无 demo/seed/PII、质量 issue 为 0 或有受审计豁免。
