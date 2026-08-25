# KAI Play（算力局）

一个由 KAI 算力能力驱动的原创多游戏产品。普通对局免费开放；历史字段 `balance` 在产品中统一解释为“竞技分”，不可充值、提现、转让或兑换。KAI 卡时只购买可明确交付的 AI、托管和个性化服务，不参与牌局输赢。

## 当前闭环

- 游客身份与 10,000 初始竞技分
- 当前可玩的“三人争先”：一名玩家和两名服务端机器人完成三人牌局
- KAI 象棋、三张竞技和 AI 挑战场的诚实预览入口
- 六位房间号好友房、三名真人对局和机器人补位
- 定主位、三张公共牌、组合牌型、特殊组合翻倍和结算
- 服务端权威校验，客户端不能指定发牌或结算结果
- 双向零和积分账本、幂等动作请求、完整对局事件
- 开局牌序哈希承诺，结束后公开 nonce 与牌序供复核
- Expo SDK 57 原生移动端大厅、牌桌、选牌、战绩和规则说明
- 零依赖浏览器界面，连接同一套服务端完成快速局、好友房与战绩浏览
- 默认关闭的 CloudPay 卡时计费骨架；显式沙盒模式也不会发起真实支付或访问 CloudPay

## 运行

要求 Node.js 22.18+。在两个终端中运行：

```powershell
cd game
npm run server
```

```powershell
cd game/mobile
npm ci
npx expo start
```

Android 模拟器默认访问 `http://10.0.2.2:4310`；iOS 模拟器默认访问 `http://127.0.0.1:4310`。真机调试时设置 `EXPO_PUBLIC_DOUJOY_API_URL=http://你的电脑局域网IP:4310`。

本地浏览器预览可让服务端运行在 `4320`，再从 `game/web` 启动静态服务器：

```powershell
$env:DOUJOY_PORT='4320'
$env:DOUJOY_CORS_ORIGIN='http://127.0.0.1:8081'
npm run server
```

```powershell
cd game/web
python -m http.server 8081 --bind 127.0.0.1
```

打开 `http://127.0.0.1:8081/`。浏览器通过同源 `/api` 代理连接 `DOUJOY_WEB_UPSTREAM`，避免跨域配置不一致。

也可以用容器启动服务端：

```powershell
cd game
docker compose up --build
```

容器同时启动游戏服务端和浏览器界面。默认仅绑定本机：界面为 `http://127.0.0.1:8081`，API 为 `http://127.0.0.1:4310`；状态写入独立的 `doujoy-data` 卷。公网部署必须使用 HTTPS 反向代理，并将 `DOUJOY_CORS_ORIGIN` 设置为实际 Web 来源；生产模式缺少该变量时服务端会拒绝启动。

单机存储会写入带版本与校验和的原子快照，并默认保留三代滚动备份。部署、备份、故障恢复和旧格式升级步骤见[单机部署与数据恢复](docs/DEPLOYMENT.md)。该模式只支持一个服务端实例；多实例或跨机器容灾必须迁移到事务数据库。

## 验证

```powershell
cd game
npm test
npm run check
```

本仓库不包含真实卡时扣减、充值、提现、链上 Token、玩家间转账或随机现实价值奖励。真实 CloudPay 接入前必须迁移到 PostgreSQL 事务账本、完成服务间认证/Webhook 签名、关闭沙盒完成入口，并取得产品、安全和法务批准。

更多资料：

- [产品范围](docs/PRODUCT.md)
- [KAI Play 第一阶段产品规范](docs/KAI_PLAY_PRODUCT.md)
- [CloudPay 计费边界](docs/CLOUDPAY_BILLING.md)
- [安全与公平](docs/SECURITY.md)
- [单机部署与数据恢复](docs/DEPLOYMENT.md)
- [隐私说明](docs/PRIVACY.md)
- [用户规则](docs/TERMS.md)
