# CloudPay 卡时计费边界

本阶段只建立默认关闭的服务端适配骨架，不会调用 `cloudpay.kai.com`，也不会锁定、扣减或结算真实卡时。`DOUJOY_CLOUDPAY_MODE` 只接受：

- `disabled`：默认值。商品目录可由已认证玩家读取；创建订单返回 `503 CLOUDPAY_BILLING_DISABLED`。
- `sandbox`：把模拟订单写入独立的本地 JSON 文件。订单响应始终带有 `simulated: true` 和醒目的沙箱警告。

本地沙箱文件不是生产支付库，不能作为卡时余额、财务收入、交付或退款的权威记录。

## 计量与账本隔离

卡时金额使用十进制字符串和最小单位 `micro-card-hour`，固定精度为 6；例如 `50000` 表示 `0.050000` 卡时。服务端不使用浮点数计算金额。

游戏竞技分、战绩和游戏内免费权益与卡时账本严格隔离：

- 卡时不可兑换竞技分，也不能作为牌桌筹码或胜负奖励。
- 游戏服务不能直接修改 CloudPay 卡时余额。
- 当前游戏 JSON store 与沙箱订单文件物理分离。
- 以后 CloudPay 和 PostgreSQL 分别作为支付余额与游戏订单投影的权威来源。

## 当前 API

所有接口都要求有效的玩家 Bearer 会话：

- `GET /v1/billing/catalog`：读取固定商品目录和当前计费模式。
- `POST /v1/billing/orders`：创建订单；必须提供 8–128 位 `Idempotency-Key`。
- `GET /v1/billing/orders/:id`：只允许读取自己的订单。
- `POST /v1/billing/orders/:id/cancel`：只允许取消自己的可取消订单，重复取消返回原结果。

沙箱创建会在本地模拟 `created → reserved`，并生成以 `sandbox-local:` 开头的 `cloudPayOrderRef`。它不发出任何网络请求。相同玩家使用相同幂等键和相同参数会得到同一订单；同一幂等键更换参数会被拒绝。

完整状态机为：

```text
created  -> reserved | cancelled | failed
reserved -> fulfilled | cancelled | failed
fulfilled -> settled | failed
settled | cancelled | failed -> terminal
```

## 未来 CloudPay S2S 合约

接入真实 CloudPay 前，需要由 CloudPay 团队确认版本化的服务间契约，至少包括：

1. 游戏后端用短期服务身份创建报价/订单，提交玩家 KAI 主体、商品、最小单位金额、币种、过期时间及全局幂等键。
2. CloudPay 返回不可猜测的订单引用、报价快照和 `created` 状态；游戏服务不能自行宣布预留成功。
3. 玩家确认后，游戏后端请求预留卡时；只有 CloudPay 签名 Webhook 或经认证的订单查询可以把投影视为 `reserved`。
4. AI/托管服务实际交付后，游戏提交不可重复的交付引用和真实计量；CloudPay 完成 `fulfilled → settled`，多余预留由 CloudPay 释放。
5. 取消、失败和退款由 CloudPay 生成独立流水；禁止覆盖历史金额或直接修改余额。

S2S 请求必须使用 mTLS 或短期工作负载身份，并包含时间戳、nonce、请求摘要和幂等键。禁止把长期 API 密钥写入仓库或返回客户端。

Webhook 必须包含事件 ID、订单引用、事件类型、发生时间、密钥版本和签名。接收方须校验原始请求体签名、允许的时钟偏差和来源，按事件 ID 幂等落库；乱序事件按明确状态机处理，不能因为重复或旧事件倒退状态。Webhook 返回成功前，事件与订单投影必须在同一数据库事务提交。定时任务还需从 CloudPay 拉取权威订单做链路对账。

## 切换生产模式的硬门槛

增加任何 `production` 模式前必须全部满足：

- 订单、状态事件、幂等键和 outbox/inbox 迁移到 PostgreSQL，使用唯一约束和事务；JSON 存储必须退出支付链路。
- CloudPay S2S 和 Webhook 契约经过双方评审，并在隔离环境完成签名、重放、超时、重复、乱序与补偿测试。
- 商品报价快照、交付证据、预留、结算、取消和退款均可审计并可自动对账。
- 建立单笔/单日限额、异常频率、权限审计、告警、人工退款审批和紧急停止开关。
- 明确数据保留、隐私、税务/财务归集和客服争议流程。
- 完成备份恢复演练、故障注入、并发幂等测试和安全评审。

在这些条件达成之前，配置只允许 `disabled` 或 `sandbox`，从而避免把本地模拟误认为真实扣费。
