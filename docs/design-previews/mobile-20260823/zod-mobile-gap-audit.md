# Zod 移动端 HTML 预览功能差距审计

审计日期：2026-08-20  
审计对象：`kai-mobile-v2-preview.html` 与远端最新 `origin/main`  
远端提交：`b2adcc088543a25725ed46bb8287454478150c85`（`establish complete phase 0 quality baseline`）

## 1. 同步方式与保护结论

- 原工作区：`D:\ZOD\zod-main`，分支 `main`，HEAD `e081dd539bcd212ec1be739cb5cd72de0ad2e470`。
- 原工作区比 `origin/main` 落后 4 个提交：管理员 P0 只读控制台、管理员发布门禁修复、安全本地演示模式、Phase 0 质量基线。
- 已执行 `git fetch --prune origin`，未执行 `stash`、`commit`、`reset`、合并或变基。
- 计划路径 `D:\ZOD\zod-main-latest-20260820` 的父目录 ACL 仅允许当前非提升令牌读取，Windows 拒绝创建目录。未改 ACL、未移动或删除任何文件。
- 安全替代工作树位于 `C:\Users\Administrator\.codex\visualizations\2026\08\19\01a0193e-85b4-7fc0-960a-61287a7852dd\zod-main-latest-20260820`，以 detached HEAD 固定在同一 `origin/main` 提交。
- 同步前后原工作区 HEAD、分支及 `git status --porcelain=v2 --branch` 完全一致；fetch 只更新远端跟踪引用。

## 2. 仓库证据与产品导航现状

远端仓库存在两层事实，需要在预览中明确区分：

1. `README.md` 和 `docs/KAI_CLOUD_MASTER_EXECUTION_PLAN.md` 定义目标双视角：
   - 使用算力：`首页 / 市场 / 订单 / 消息 / 我的`
   - 提供算力：`工作台 / 资源 / 上架 / 消息 / 我的`
2. 当前 `src/components.tsx` 的实际 `BottomNav` 仍固定为：`首页 / 市场 / 上架 / 消息 / 我的`。`App.tsx` 已接入订单、资产、卡时、工作台、资源等 Screen，但通过二级路由映射到底栏选中态，尚未完成目标双视角底栏。
3. `docs/ZOD_PRODUCT_CONTRACT.md` 仍记录另一套旧约束：`首页 / 市场 / 我的资产 / 消息 / 我的`，并要求切换器只放“我的”。该文档与最新 README、主执行方案冲突。

因此，HTML 预览第三轮采用 README/主执行方案的双视角作为“目标态预览”，不能声称它已经在真实 App 底栏上线；报告和预览备注需保留这一差异。

## 3. 移动端 Screen / Sheet 覆盖矩阵

状态定义：

- **已有**：HTML 已有可识别结构。
- **部分**：只有文案或入口，缺少真实 App 的核心状态/流程。
- **缺失**：HTML 未表示。
- **本轮目标**：第三轮预览应补齐的结构态，不接真实 API。

| 优先级 | 远端模块与代码证据 | 当前 HTML | 本轮目标 | 结论 |
|---|---|---|---|---|
| P0 | `HomeScreen`：卡时入口、市场、定向需求、Spark 设备 | 部分 | 保留视频焦点，补双视角切换和卡时/订单/市场去向 | 补齐导航语义，不制造余额 |
| P0 | `MarketScreen`：算力租用、预约算力、设备采购；平台保障/Vast.ai 即时；我的询期 | 部分 | 三类市场入口、手动轮播、登录后查看结构 | 轮播不能替代三类真实业务模式 |
| P0 | `OrdersScreen` + `OrderDetailSheet` + `ComputeFulfillmentCard` | 缺失 | 买方一级“订单”、提供方订单入口、代表详情页 | 显示状态结构，不放虚构订单 |
| P0 | `ProviderWorkspaceScreen` | 缺失 | 提供侧“工作台”：资格、待办、订单、上架步骤、同步失败 | 使用登录/空状态代替虚构指标 |
| P0 | `ProviderResourcesScreen` + `ResourceEvidenceSheet` + `NodeEnrollmentSheet` | 仅核验清单 | 提供侧“资源”：资产、材料、节点接入、审核/离线状态 | 材料清单升级为完整资源入口 |
| P0 | `PublishScreen` + `OfferWizardSheet` + `ListingPublishSheet` + `ListingManageSheet` | 部分 | 保留上架页，增加草稿、双审、挂牌和只读权限结构 | 不把“提交材料”误写为已上架 |
| P0 | `UnifiedAssetsScreen`：我购买的/我提供的、算力/Vast/设备 | 缺失 | “我的资产”二级页，双分段空状态 | 不能用订单数量推算资产 |
| P0 | `CreditScreen` + `CreditWalletSheet` + `CreditPayoutSheet` | 仅账户名称 | 钱包二级页：余额、预留、待结算、充值/兑付入口 | 全部金额显示登录后查看 |
| P0 | `MessagesScreen`：消息列表、全部已读、订单/资源/方案深链 | 部分 | 保留一级页，补买方/提供方语义和深链说明 | 不虚构未读数 |
| P0 | `ProfileScreen` + `AccountSecuritySheet`：主体切换、资产、订单、卡时、供给经营、安全 | 部分 | 通俗角色入口、主体/账户/钱包/资产二级去向 | “我是买家/卖家”是预览视角，不猜权限 |
| P1 | `DeviceOrderSheet` + `DeviceOrderDetailSheet` | 只有市场文案 | 预留设备订单详情入口 | 本轮不展开地址、物流、收货全流程 |
| P1 | `InquiryComposerSheet` + `MyInquiriesSheet` | 只有市场概念 | 预留“发布需求/我的询期”入口 | 不创建询期记录 |
| P1 | `AftercareReviewSheet` | 只有消息文案 | 在订单详情标明售后/评价去向 | 本轮不展开争议证据流程 |
| P1 | `CreatorCollaborationScreen` + `CreatorRewardSheet` | 缺失 | 钱包或“我的”预留达人合作入口 | 不虚构返佣与奖励 |
| P1 | `SparkProductDetailSheet` | 首页/市场入口已有 | 保留设备说明入口 | 不承诺库存、不伪装算力租赁 |
| 独立系统 | `admin/`、`backend/src/admin/*` | 缺失 | 不放入客户移动端预览 | 管理员认证、RBAC、只读控制台独立审计 |

## 4. API 合约覆盖结论

远端 `backend/src/app.ts` 实际注册的客户移动能力包括：

- 账户与主体：KAI OIDC、OTP、会话、账号注销、主体切换、提供方 bootstrap。
- 市场与供给：公开资源/挂牌、供应资格、资源材料、节点接入、方案草稿、双审、挂牌管理。
- 交易：KAI 卡时余额/明细/充值、算力订单、履约、退款与售后状态、提供方结算/兑付。
- 资产与扩展市场：统一资产、设备商品/订单/收货地址、Vast.ai、预约询期。
- 消息与增长：通知、设备推送、达人返佣与奖励事件。

HTML 预览不得连接这些写接口，也不得把结构预览表述为可交易能力。以下代码存在但没有在 `backend/src/app.ts` 注册为当前主应用路由：独立 `disputes`、`refunds`、`invoices` 模块；它们不应作为第三轮 HTML 的“已上线”功能加入。

## 5. 第三轮实现优先级

### P0：必须进入本轮 HTML

1. 双视角切换及两套五栏导航。
2. 买方订单一级页和代表订单详情。
3. 提供方工作台、资源、上架三页结构。
4. KAI 卡时钱包与统一资产二级页。
5. 市场三类业务模式及真实数据占位原则。
6. 消息深链、登录、离线/恢复、只读权限等关键状态说明。

### P1：只留入口与职责

- 设备订单/物流/收货、售后评价、预约询期管理、达人合作/佣金。
- 入口必须写“登录后查看”或说明字段职责，不显示模拟数量、余额、库存或收益。

### 独立系统

- 管理员认证、RBAC、审计、P0 只读控制台保持桌面管理产品边界；如需预览，应另建桌面 HTML，不进入客户 App 底栏。

## 6. 验收清单

- 预览中两套底栏与角色切换的 URL 状态一致，返回键能恢复原页面与焦点。
- 所有金额、库存、订单、资产、待办和消息数量均来自真实接口前保持空态或“登录后查看”。
- 市场明确区分算力租用、预约算力、设备采购，并区分平台保障与 Vast.ai 即时来源。
- 订单详情区分购买方/提供方动作，不从视角名称推断服务端权限。
- 提供方流程保留主体认证、资源验真、节点接入、方案/价格双审、挂牌、交付、结算的顺序。
- 管理员模块不出现在客户移动端导航。
- 报告发布时再次核验远端 HEAD；若 `origin/main` 变化，先更新审计基线再继续实现。

