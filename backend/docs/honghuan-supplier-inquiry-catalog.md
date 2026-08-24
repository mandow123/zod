# 上海鸿欢正式预约目录 B1

本能力由迁移 `0062_honghuan_supplier_inquiry_catalog.sql` 建立，和 `0058/0059` 的私有候选资源目录严格分离。目录固定包含 11 项正式预约资源：10 项按小时 GPU 资源与 1 项 B300 整机月租合同资源。

## 公开边界

- 目录仅表达“可以提交询期”，不表达现货、实时库存、已核验、自动部署或可购买。
- 11 项固定为 `purchasable=false`、`inventoryCommitment=false`、`orderCreation=false`、`inquiryAvailable=true`。
- 公开报价是 KAI 卡时参考值，保留两位小数；源人民币金额、挂牌倍率、证据存储地址和供应商联系方式只保存在服务端。
- 公司和 Logo 的披露依据是平台负责人公开指令及用户提供资料，不是供应商授权或 KAI 验真。公开状态固定为“报价资料导入 · 未经 KAI 验真”。
- 资料记录 `publication_directive_ref` 与 Logo 源文件 SHA-256；`supplier_authorization_evidence_ref` 保持为空。缺平台指令、源哈希、11 项完整种子或有效参考价时目录失败关闭。

## 功能开关

`HONGHUAN_SUPPLIER_CATALOG_MODE` 只接受以下运行语义；缺省或非法值均视为 `off`：

- `off`：公开目录返回 404，正式资源询期不可提交。
- `read_only`：只读目录可用，正式资源询期提交被拒绝。
- `inquiry`：只在数据库迁移、种子、证据和价格有效期门禁均通过时允许正式资源询期。

生产部署清单保持 `off`。B1 不自动启用、不部署，不创建报价、订单、预留、卡时交易或账本分录。

## API

- `GET /mobile/v1/supplier-inquiry-catalog`
- `GET /mobile/v1/supplier-inquiry-catalog/:resourceId`
- `POST /mobile/v1/resource-inquiries`：沿用既有询期状态机，正式资源 body 使用 `supplierResourceId`、`supplierResourceVersion` 与 `quantity`，不能和旧 `candidateId` 混用。

正式询期创建事务同时写入不可变供应商、资源规格、参考价与来源快照，三份协议接受记录、单条审计和单条 outbox。提交前后订单、预留、KAI 卡时账户、交易和分录均不得改变。

## 人工交付与法务

目录交付模式固定为人工确认。B300 整机合同项只接受 32、64、128 台，参考交付周期为供应商声明的 4 个月；“1个月免责”“5年闭口”仅作为服务端原始证据保存，`legalReviewRequired=true`，不转换成可执行承诺。B1 允许提交租赁意向，但后续报价、签约和下单必须继续经过法务与业务审核。
