# 达人返佣独立账本

达人返佣与用户 KAI 卡时钱包、供应商收益、托管收益完全分账。订单完成后，返佣先进入观察期；观察期内发生退款或取消会原路冲正。观察期结束后进入“可转入”，只有用户主动转入时才会形成一笔真实的 KAI 卡时账本交易。

所有公开金额字段均使用 `KAI_CARD_HOUR`，以字符串固定保留两位小数，且只返回卡时相关字段。

## 状态与账本

`attributed → refund_observation → available → transferred`

- `refund_observation`：独立账本 `pending` 增加；退款时冲正。
- `available`：观察期结束，独立账本从 `pending` 转到 `available`。
- `transferred`：用户明确操作后，独立账本从 `available` 转到 `transferred`，同时 KAI 卡时钱包真实入账。
- `reversed`：订单取消或退款，独立账本从原状态冲回平台清算账户。
- 每笔独立账本交易至少两条分录，合计必须为零，且只能精确到两位小数。

奖励事件只在 KAI 卡时交易成功入账后创建，`eventId` 是唯一消费标识。读取接口只返回未消费事件；消费使用带条件的单次状态更新，因此同一奖励无法展示两次。

## 移动端接口

- `POST /mobile/v1/creator/referral-links`：创建第一方签名邀请链接；要求 `Idempotency-Key`。
- `POST /mobile/v1/referrals/attribute`：当前买家绑定邀请归属；同一交易主体只保留一个有效归属，禁止自邀。
- `GET /mobile/v1/creator/commissions`：两位小数卡时余额和订单明细。
- `POST /mobile/v1/creator/commissions/transfer`：将全部可用返佣转入当前主体的 KAI 卡时账户；要求 `Idempotency-Key`。
- `GET /mobile/v1/creator/reward-events`：读取未消费的真实奖励事件。
- `POST /mobile/v1/creator/reward-events/:eventId/consume`：单次消费奖励事件。

第一方邀请链接使用 HMAC-SHA256 签名并带到期时间。抖音与 TikTok 仅保留服务端验签适配器边界，未配置平台密钥时不会接收或伪造第三方归属。

## 服务端配置

```dotenv
CREATOR_REFERRAL_SIGNING_SECRET=<至少 32 个字符的独立密钥>
CREATOR_COMMISSION_POLICY_JSON={"version":"creator-v1","commissionBasisPoints":1000,"attributionTtlDays":30,"refundObservationDays":7}
```

缺少任一配置时，达人返佣能力保持关闭，不影响其他交易服务。
