# Android 提供方上架验收记录

验收日期：2026-08-15  
验收应用：`com.kaicloud.marketplace`  
验收安装包：`artifacts/release/KAI-CloudPay-1.0.0-1-local-e2e.apk`

本批安装包 SHA-256：`725c45a9d3d0532ca9f34d6152fe772da9331f0a9f2955cbec211584cad78a21`

主前端源码指纹：`35ec241c92b5e24f43b13b73a6afbc771f2ddb88ca3ab291ba79cd3893d555c2`

## 验收结论

提供方已在 Android App 内完成一条不依赖旧前端的完整上架链路。每一步同时核对手机界面、移动端接口和服务端数据库状态；没有仅在客户端显示成功的步骤。

四步上架草稿已在真实 Android 操作中连续验证：人民币依据 `¥31.20` 按固定汇率换算后，所有用户界面统一显示 `31.14 KAI 卡时`，核价凭证与五项交付边界完整进入确认页；冷启动后服务端仍恢复到同一草稿的“提交确认”。补填会移除本地校验提示，但保存失败和版本冲突不会被掩盖。

## 2026-08-15 主包最终复验

- 使用主包原生页面登记 `NVIDIA-H100-SXM5-98G`，填写 8 张 GPU、单卡 98 GB、上海区域与 800 GPU时。
- 权属、配置、可用性三类材料均经 Android 系统文件选择器上传，送审后手机显示“平台审核中”，审核通过后显示“资料已核验”。
- 资料核验后主动作准确变为“接入节点”；一次性配置恢复路径在本地验收环境可用，正式环境仍只允许 HTTPS 根地址。
- 节点状态为“节点在线，可交付”后，主动作准确变为“创建上架方案”；未就绪资源不能绕过节点检查创建方案。
- 在 Android 四步向导中完成服务、交付边界、价格与确认，人民币依据 `¥31.20 / GPU时` 在页面显示为 `31.14 KAI 卡时 / GPU时`。
- 提交后服务端分别生成资源审、价格审；双审均通过后，App 才出现“发布可售容量”。
- 从手机发布 100 GPU时、立即生效、持续 7 天；App 显示“销售中”，服务端挂牌状态为 `active`。
- 强制结束应用并冷启动后，登录态、提供方视角和挂牌状态均恢复；页面仍显示 `100 GPU时 · 31.14 KAI 卡时`，满售预计成交额为 `3113.77 KAI 卡时`。
- 本轮 28 项设备门禁全部通过：设备内安装物与指定 APK 哈希一致、内置 Android bundle、目标 API 36、五个提供方页面可用，且没有 Metro 或致命运行错误。

## 本次完整路径

1. 同一账号切换到“提供算力”，冷启动后保持提供方视角。
2. 在“资源”准备并验真 `H100-E2E-OFFER`，登记 8 张 GPU、每卡显存与可售时长；商品单位固定为 GPU时。
3. 分别上传权属、配置、可用性三类材料；三份文件通过安全检查后才允许送审。
4. 资源送审后状态进入“平台审核中”；平台通过后 App 自动刷新为“验真已通过”，并生成消息通知。
5. 从已验真资源创建上架方案，填写服务、交付边界、人民币核价依据和可核验凭证。
6. App 根据 `1 KAI 卡时 = ¥1.002` 展示预计卡时价；提交后服务端分别生成资源审与价格审任务。
7. 双审通过后，客户端只允许选择可售容量与时段，不能自行改写最终卡时单价。
8. 发布单卡独享 GPU时商品；买家每笔订单固定取得 1 张 GPU，输入购买时长。8 卡节点最多同时承接 8 笔订单。

## 购买与交付合同

- 购买前先锁定 GPU 槽位；没有空闲槽位时不创建订单，也不预留卡时。
- 下单成功后平台自动确认并立即触发交付，不要求资源方手动接单。
- 交付凭据只在私有后端与 H100 sidecar 之间交换，App 不接触 sidecar 地址或票据。
- sidecar 确认实例与 SSH 连接可用后，订单才进入使用中并开始计费；仅创建实例或交换失败均不计费。
- 5 分钟仍不能完成交付时全额退回卡时，同时释放 GPU 槽位。
- 同一私有票据在有效期内可恢复同一份 SSH 凭据；重试不会生成第二把密钥，也不会重复计费。
- 首次获取连接前再次同步核对容器、GPU 分配和授权密钥；尚未使用即失效时只生成一笔全额退款，访问与失败并发时不会同时计费和退款。
- App 收到下单成功结果后立即打开该订单，账户和列表在后台刷新；此时断网不会把成功订单显示成失败，也不会让同一请求重复冻结卡时。
- 算力订单时间线显示“资源已锁定”，不再使用需要人工操作的“提供方接单”文案。

## 一致性检查

- 资源：手机显示 8 张 GPU、单卡 98 GB、可售总量 100 GPU时且已验真；服务端资源状态为 `verified`。
- 材料：手机三项均为“已完成”；服务端三份证据均为 `verified`。
- 方案：手机显示双审通过；服务端资源审、价格审均为 `approved`。
- 单价：页面建议价不直接成为挂牌价；内部账本保留审核锁定精度，挂牌、市场、订单和资产等用户界面统一显示 `31.14 KAI 卡时 / GPU时`。
- 挂牌：手机显示 100 GPU时、销售中；服务端挂牌状态为 `active`，容量和 7 天时段一致。
- 中断恢复：填写方案时退出 App，重新进入后工作台显示“继续上架方案”，已保存草稿可恢复。
- 表单效率：交付边界支持一键填入五项常用条款，内容仍可逐项编辑，不替资源方作不可修改的承诺。
- 返回键：输入框唤起键盘后按 Android 返回键只收起键盘，上架方案和当前步骤均保持打开。
- 即时保存：从“边界”进入“价格”后 150 毫秒内核对服务端草稿，`current_step` 已同步为 `price`。
- 断点续填：强制结束并冷启动 App 后，工作台显示“上架草稿 · 价格材料”，点击“继续填写”直接恢复价格步骤。
- 草稿退出：关闭上架向导后工作台自动刷新，已保存草稿立即显示，不会短暂表现为丢失。
- 放弃草稿：草稿卡片提供弱化的危险操作并二次确认；成功后手机列表和加密缓存同步移除，服务端标记为 `abandoned` 并保留审计，已验真资源不受影响。
- 放弃回包恢复：请求结果不确定时重新读取服务端草稿列表；只有同一草稿确实不存在才确认放弃并清理页面、内存和加密缓存，无法确认时仍保留草稿。
- 并发保护：只有版本一致的 active 草稿可放弃；旧版本、已提交和已放弃草稿均被服务端拒绝。
- 包冲突：验收发现废弃 App 与主 App 共用 `com.kaicloud.marketplace` 但签名不同；已从模拟器移除旧安装。固定预览命令今后只在模拟器上自动替换不兼容签名，真机则拒绝自动卸载，避免清除用户数据。
- 主包身份：设备验收同时核对源码指纹、主前端标记、分发渠道、接口环境和设备内实际 APK 哈希；仅包名与版本号相同的历史包不能通过。
- 固定预览入口：`npm run preview:android:provider` 只安装当前 `local-e2e` 主包并切入“提供算力”，不会默认选择历史正式候选物。
- 审核退回：价格审核要求补充近三个月成交合同；消息和上架卡片显示同一条具体意见，点击后直接回到价格步骤，原方案内容没有丢失。
- 修改重提：人民币输入由服务端 `31.200000` 转成可编辑的 `31.20`；换成成交合同后重提，第 1 版审计记录保留，第 2 版重新生成资源审和价格审。
- 工作台同步：进入提供工作台、App 回到前台时立即同步；存在审核中方案时每 10 秒同步。双审通过后冷启动直接显示“发布可售容量”，不会继续展示旧审核状态。
- 价格可读性：服务端与结算继续保留 `31.137725` 六位卡时精度；挂牌、管理、市场和购买界面统一显示 `31.14`，并在挂牌确认页展示核价依据 `¥31.20 / GPU时`。
- 挂牌闭环：本轮发布 100 GPU时、立即生效、持续 7 天；服务端状态为 `active`，购买视角立即出现 1 个挂牌，并识别为“我的挂牌”而不是购买按钮。
- 销售开关：提供方暂停后服务端变为 `paused`，购买市场立即归零；恢复后服务端回到 `active`，市场重新出现同一挂牌，容量和审核锁价均未改变。
- 销售状态回包恢复：暂停、恢复或结束销售回包丢失时，App 回读同一挂牌；状态精确等于目标值才确认成功。确认结果会同时更新当前页面和本地主体缓存，无法确认时明确要求先同步而不继续展示伪成功。
- 消息直达：资源审单独通过的通知显示“查看方案”；双审均通过的通知才显示“去上架”，并一步打开对应方案的容量时段发布页。
- 首次注册承接：从“成为资源伙伴”发起注册后，客户端会等待旧页面刷新结束，再读取新会话；注册完成即回到入驻表单，不会回到未登录页面或要求重启。
- 本地登录验收：使用预置资源方手机号请求验证码后，App 只在本机验收构建读取同一手机号刚生成的六位验证码并自动带入；点击验证后显示已认证主体，并直接进入空白 H100 资源表单。正式构建默认关闭该能力。
- 入驻表单：主体名称、18 位统一社会信用代码和联系人完整前，“提交入驻审核”保持不可用，并显示缺少内容。
- 入驻补件：审核具体原因在原表单展示；企业名称和联系人跨冷启动恢复，完整信用代码不从服务端回传，用户重新确认后才可重提。
- 入驻状态：提交、退回、冷启动恢复、重新提交和审核通过均已同时核对 Android 页面与服务端状态；通过后可直接进入“提交待验真资源”。
- 入驻回包恢复：提交后发生网络或网关中断时，App 回读主体资料；仅公司名称、联系人、脱敏信用代码完全一致且状态为“等待审核”或“已认证”时提示“已经提交，无需重复操作”，其他情况继续保留原表单。
- 首次资源：资产编号、型号、地区、有效容量和单位完整前，“保存资源，继续”保持不可用，避免首次用户先撞服务端错误。
- 工作台直达：主体审核通过且没有资源时，“添加第一份算力资源”直接打开原资源发布表单；存在待补材料资源时，“继续准备审核材料”使用服务端返回的资源 ID 直接打开该资源，不经过资源列表二次选择。
- 保存衔接：`H100SXM80G · Shanghai` 在服务端创建成功后，App 自动切到“资源”并打开权属、配置、可用性三项清单；再次提交同一资产时恢复既有资源并进入同一清单，资源总数保持 1。
- 创建方案直达：`H100-E2E-OFFER` 验真通过且没有方案时，工作台直接打开绑定该资源的四步上架向导，不经过资源选择页；服务端草稿 `resource_id` 与资源 ID 完全一致。
- 默认名称恢复：新向导生成的 `H100-E2E-OFFER 算力服务` 会作为第一笔草稿内容写入服务端；强制结束并冷启动后名称仍存在，草稿数量保持 1，未生成第二份草稿。
- 首份资源材料：权属、配置、可用性三类文件均完成选择、上传、对象存储和安全检查；冷启动后仍能恢复“材料已齐，可以提交”。
- 提交防重：连续两次点击“提交平台审核”只生成一份资源和一个审核批次；服务端三类材料各一份且状态均为 `verified`。
- 回包丢失恢复：材料上传确认、材料送审、方案送审和挂牌发布只对网关或传输层不确定结果执行安全重试；重试后仍未收到回包时，再读取服务端材料清单、已提交草稿、方案版本或挂牌列表。只有权威状态匹配才展示成功，不能确认时保留原表单和同一请求标识供用户继续确认。
- 文件续传：材料登记后若上传中断，页面显示“继续上传”；同一文件复用服务端原任务和校验摘要，不同文件自动撤销旧任务后重新登记，不会把另一份文件接到旧记录上。
- 草稿保存恢复：普通上架草稿和审核补件草稿保存回包丢失时，会读取各自的服务端草稿；更高版本的步骤和内容与本次编辑完全一致才恢复为“已保存”。网络持续不可用时输入仍留在页面，顶部“未保存”可手动重试；不同内容的真实版本冲突不会被误判成功。
- 状态分流：服务端与 App 将“待提交材料”和“审核中”分别统计；同一账号并列资源实测显示“待提交 1、审核中 1”，未提交材料不再冒充审核进行中。
- 审核详情：正式提交后详情页标题为“审核进度”，只展示三类已完成材料和审核状态，不再继续提示上传格式。
- 退回补件：资源卡冷启动后仍保留具体审核原因；仅被退回的配置材料可重新选择，已接受的权属和可用性材料继续保留，重新送审只新增一份替换材料。
- 半成品草稿：核价凭证只填写“来源”、尚未填写说明时也会即时保存；退出并重新进入后来源原样恢复，正式提交仍要求来源和说明完整。
- 方案防重：确认页连续点击两次“提交审核”，服务端只生成一份方案、一个提交版本，以及资源审和价格审各一条任务。
- 过期方案重审：同一重审请求可安全重放；回包丢失后只在服务端同一方案进入审核中、方案版本和提交版本各精确增加一版时确认成功，不会重复生成双审任务。
- 买卖闭环：双审通过后从 Android 发布 100 GPU时、立即生效、持续 7 天；切回“使用算力”后市场立即出现同一挂牌，并标记为“我的挂牌”。
- 重新交付：买方从 Android 提交明确原因后，订单进入争议状态；提供方在同一订单看到原始原因并提交新的地址与说明，订单回到待验收且买方预留卡时保持 `62.27545`，没有重复扣款或重复订单。
- 待办准确性：争议订单即使列表摘要没有操作数组，也会计入提供工作台“需要处理”，显示“1 笔待处理”并排在普通记录之前。
- 接单与交付回包恢复：确认接单和开始交付自动重试时复用同一请求标识；仍收不到回包时，只在同一订单出现服务端接单时间或交付开始时间且进入对应后续状态后确认成功，其他设备产生的无关更新不会冒充本次完成。
- 全额退款：提供方确认页明确显示退回 `62.27545 KAI 卡时`；确认后订单为已退款，买方可用卡时恢复、对应预留清零、可售容量恢复，提供方待结算仍为 0。
- 金额边界：全额或超额补偿后的剩余金额统一显示 0，不出现负卡时或六位小数减法误差。
- 验收后售后：买方申请 20 卡时补偿后，提供方 `62.27545` 卡时待结算立即暂停；提供工作台显示“1 笔待处理”，不会因订单主状态仍是“已验收”而漏单。
- 三方裁决：提供方提交异议后，平台移动端可同时核对买方说明、提供方异议和最后一次交付记录；支持补偿的确认页锁定为 20 卡时，提供方和平台都不能擅自改数。
- 部分补偿入账：平台确认后买方可用卡时增加 20，提供方待结算从 `62.27545` 减为 `42.27545`；订单仍为已验收、已售容量不恢复，防止同一算力重复出售。

## 验收截图

- `artifacts/android-provider-evidence-ready.png`
- `artifacts/android-provider-evidence-submitted.png`
- `artifacts/android-provider-evidence-approved.png`
- `artifacts/android-provider-draft-resumed2.png`
- `artifacts/android-provider-terms-template.png`
- `artifacts/android-provider-draft-resume-entry.png`
- `artifacts/android-provider-draft-resumed-price.png`
- `artifacts/android-provider-draft-abandon-action.png`
- `artifacts/android-provider-draft-abandon-confirm.png`
- `artifacts/android-provider-offer-review.png`
- `artifacts/android-provider-offer-submitted.png`
- `artifacts/android-provider-offer-approved.png`
- `artifacts/android-provider-listing-confirm.png`
- `artifacts/android-provider-listing-published.png`
- `artifacts/android-provider-price-changes-card.png`
- `artifacts/android-provider-price-revision-open.png`
- `artifacts/android-workspace-approved-auto-refresh.png`
- `artifacts/android-listing-price-readable.png`
- `artifacts/android-provider-listing-live.png`
- `artifacts/android-buyer-market-own-listing.png`
- `artifacts/android-listing-paused.png`
- `artifacts/android-market-paused-hidden.png`
- `artifacts/android-market-restored-live.png`
- `artifacts/release/smoke/android-production-home.png`
- `artifacts/release/smoke/android-production-market.png`
- `artifacts/release/smoke/android-production-publish.png`
- `artifacts/release/smoke/android-production-messages.png`
- `artifacts/release/smoke/android-production-profile.png`
- `artifacts/android-first-provider-form-locked.png`
- `artifacts/android-first-provider-submitted.png`
- `artifacts/android-first-provider-rejected.png`
- `artifacts/android-first-provider-rejected-resumed.png`
- `artifacts/android-first-provider-resubmitted.png`
- `artifacts/android-first-provider-approved.png`
- `artifacts/android-first-resource-form-locked.png`
- `artifacts/android-first-resource-form-locked-bottom.png`
- `artifacts/android-first-resource-evidence-ready.png`
- `artifacts/android-first-resource-under-review.png`
- `artifacts/android-metrics-current.png`
- `artifacts/android-resource-review-progress-final.png`
- `artifacts/android-resource-approved-next-action.png`
- `artifacts/android-resource-rejected-specific-reason.png`
- `artifacts/android-resource-correction-targeted.png`
- `artifacts/android-resource-correction-ready.png`
- `artifacts/android-resource-correction-resubmitted.png`
- `artifacts/android-resource-correction-card-final.png`
- `artifacts/android-offer-partial-evidence-resumed-fixed.png`
- `artifacts/android-offer-review-ready.png`
- `artifacts/android-offer-submitted.png`
- `artifacts/android-offer-approved.png`
- `artifacts/android-listing-ready.png`
- `artifacts/android-listing-published.png`
- `artifacts/android-market-after-provider-publish.png`
- `artifacts/android-provider-approved-message-direct-listing.png`
- `artifacts/android-current-main-market.png`
- `artifacts/android-listing-restored-market.png`
- `artifacts/android-buyer-rework-order.png`
- `artifacts/android-buyer-rework-detail.png`
- `artifacts/android-buyer-rework-submitted.png`
- `artifacts/android-provider-rework-workspace.png`
- `artifacts/android-provider-rework-submitted.png`
- `artifacts/android-provider-refund-action-count.png`
- `artifacts/android-provider-full-refund-confirm.png`
- `artifacts/android-provider-full-refund-complete.png`
- `artifacts/android-buyer-aftercare-pending.png`
- `artifacts/android-provider-aftercare-action-count.png`
- `artifacts/android-provider-aftercare-detail.png`
- `artifacts/android-provider-aftercare-contested.png`
- `artifacts/android-operator-aftercare-review.png`
- `artifacts/android-operator-aftercare-confirm.png`
- `artifacts/android-operator-aftercare-complete.png`

设备门禁报告：`artifacts/release/android-device-smoke-report.json`，本轮 28 项全部通过，无 Metro 或致命运行错误。

Google Play 隔离测试包另以 `artifacts/test/android-store-provider-smoke-report.json` 记录 29 项真机门禁：商店能力关闭、提供方能力保留、五个提供方页面逐页渲染、设备内 APK 哈希一致，且无 Metro 或致命运行错误。验收结束后已重新安装国内主包并停留在“上架”页。

本轮 Google Play 隔离测试 APK SHA-256：`654b3242578d87371faa7adef147e2021df520cacedab57be28a3cd555f5522f`；隔离测试 AAB SHA-256：`368becceb523fed27abaa3dd31cbd71ccc7aaa56c3bc879f34a4ba98ff64eff1`。两者连接本地验收后端，仅用于渠道能力验证，不得提交商店。

## 上线前仍需完成

本记录证明本地 Android 与本地完整后端的业务闭环可用，不替代生产发布门禁。正式上线仍需部署 `cloudpay.kai.com` 后端、绑定真实 Expo 项目 UUID、配置正式推送与运营凭据，并让 `release:preflight` 返回通过。
