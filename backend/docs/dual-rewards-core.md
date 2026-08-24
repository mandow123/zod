# 双返佣 B0/B1 后端核心

本批只建立后端经济基础，不开放主播、邀请、收益或转入的公开 API，不修改 App，也不启用生产开关。

## 域边界

- 主播域使用 `streamer_*` 表；普通邀请域使用 `invite_*` 表。
- `reward_order_claims` 对同一订单全局唯一。精确商品的主播归因优先，未命中才评估邀请。
- 0057 的 `creator_*` 历史数据、账本和余额保持原样，不复制、不回填、不与新域合并。
- 新域共享双录实现，但 `reward_accounts`、`reward_transactions`、`reward_entries` 全部带 `domain`，数据库触发器禁止跨域分录。

## 经济事件

新域不轮询或推测订单状态，只接受持久 Outbox 的以下事件：

- `commerce.order.net_settled.v1`
- `commerce.order.net_revised.v1`

首次事件必须给出大于零、两位小数精度的最终净消耗卡时。修订事件只允许降低净消耗。事件由
`(domain, source, event_id)` 幂等收件，并按订单 `sourceVersion` 单调处理。没有下单时归因快照的订单不会事后补发奖励。

状态为：

`attributed → observation → available → transferred`

观察期或可用阶段的退款通过反向双录冲正。已转入后的负修订进入 `recovery_required`，冻结该用户在对应域的
`pending` 和 `available` 账户，等待后续人工追偿；系统不会制造负余额或跨域扣款。

## 运行模式

| 配置 | 值 | 行为 |
|---|---|---|
| `LEGACY_CREATOR_COMMISSION_MODE` | `off` / `drain` | 缺省关闭；drain 只收口旧订单、旧余额和旧奖励，不接受新归因或发现新订单 |
| `STREAMER_REWARDS_MODE` | `off` / `shadow` / `on` | 主播新域；shadow 只做旁路资格和审计，不能占用全局订单归属 |
| `INVITE_REWARDS_MODE` | `off` / `shadow` / `on` | 邀请新域；shadow 只做旁路资格和审计，不能占用全局订单归属 |

新域的策略 JSON 必须严格匹配服务端结构，签名密钥分别至少32字符且不得相同。缺省或非法模式按 `off` 处理；
生产声明 `shadow/on` 但策略、密钥或0061数据库迁移不完整时，readiness 和 release 门禁失败关闭。B0/B1 尚未把
`claimForOrderWithClient` 接入三类真实订单创建事务，也没有发布权威 final-net Outbox，因此 `shadow/on` 都带有明确的
`pending atomic commerce claim and final-net producer` blocker，不能进入 ready；新域 worker 只交付未实例化骨架，
服务进程不会启动它。成熟任务对主播域和邀请域使用各自独立的批次配额，任一域的积压不会饿死另一域。

## 当前明确未做

- 不生成推广码、不接收点击、不新增公开路由。
- 不接抖音/TikTok，不做固定新客奖金、月封顶、税务处理或现金提现。
- 不启动新域 worker，不修改现有订单创建事务或上线生产 flag。
- 不自动追偿已消耗卡时；只冻结并生成审计/Outbox 证据。
