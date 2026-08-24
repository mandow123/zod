# U0 Web → Node 单写切换与回滚手册

状态：**冻结待审设计，不代表生产已经合并或切换。**

冻结日期：2026-08-21

逐路由机器可读决策：[U0_WEB_NODE_COMPATIBILITY_MAP.json](./U0_WEB_NODE_COMPATIBILITY_MAP.json)

结构合同：[U0_WEB_NODE_COMPATIBILITY_MAP.schema.json](./U0_WEB_NODE_COMPATIBILITY_MAP.schema.json)

## 1. 目标架构与不可变边界

写入所有权按域精确拆分，不存在两个可互换的 writer：

- **18 identity Node + PostgreSQL** 是身份 writer，只写 credential、OIDC user 和 identity session，并签发/验证不可变 KAI `sub`。它不写交易主体、业务同意或 commerce 状态。
- **43 commerce Node + PostgreSQL** 是业务 writer，只写 `auth_sub` 映射、trading subject、业务 legal consent 以及全部 commerce 状态。映射只能使用经 18 identity authority 验证的 immutable `sub`；不能用邮箱、手机号、显示名或旧 SQLite 用户 ID 合并身份。
- **18 Python/SQLite** 的写集合为空，最终必须是 `query_only`。它不是灾备 writer，也不能在任一 Node 故障时接回身份、同意、订单、支付或余额写入。
- 网页可以暂时保留 `/api/*` 外观，但兼容层必须由 Node 所有，且只能调用 Node canonical service。兼容层不得双写、不得补造成功、不得回落到 Python 写库。
- App 继续使用 `/mobile/v1/*` canonical contract。网页兼容接口与 App canonical 接口必须看到同一 PostgreSQL 状态机，而不是两套“最终一致”副本。

因此“单写”不是把 identity 与 commerce 合并进一个数据库，而是每个状态只有一个明确 owner：identity credential/user/session 只在 18 auth PG；subject mapping、业务 consent、资源、询期、订单、交付、余额、充值、退款、争议、发票、佣金和业务审计只在 43 commerce PG。支付渠道通知属于 commerce 写入，不能影子执行。

## 2. 路由决策口径

JSON 映射覆盖 Python dispatch 中全部 **87** 条 `/api` 路由：35 条 GET、52 条 POST。每条都标注认证面、读/写/回调、支付敏感性、是否允许影子读、切换目标和禁止项。

| 状态 | 数量 | U0 处置 |
| --- | ---: | --- |
| `reuse` | 3 | 直接复用 canonical Node handler；只改变公开路由或渠道配置 |
| `adapter` | 15 | 临时 Node-owned 路径/DTO 转换；禁止写旧库 |
| `migrate` | 38 | 先做 ID、数据与状态机迁移，未完成前不开写 |
| `quarantine` | 9 | 隔离、排空或补齐证据；不进入普通生产流量 |
| `retire` | 22 | 404/410，无旧服务 fallback |

特别禁止：

- 旧 `/api/payments/create` 是资源订单的直接 CNY 支付，不能映射成卡时充值。
- 旧 mock 支付、demo 登录/交付、行情蜡烛、掉期、旧本地密码/OTP 全部退役。
- 旧支付宝/微信订单回调只能隔离排空历史交易，不能与 Node 充值回调同时处理同一渠道事件。
- 旧 Qixiang callback 当前是 `quarantine`，不是 reuse：旧凭据按已泄露处理，在凭据轮换与旧凭据撤销双审、Node service 构造、schema 0063 部署、runtime/lot evidence、历史 payment/provider ID 对账和唯一 callback owner 实证齐备前不得切换。只有 return 静态页可 reuse。
- 旧 payment status 当前是 `migrate`：必须先建立不可变 legacy payment ID → canonical topup UUID 映射，禁止按订单号猜测或直接适配放行。
- Qixiang notify 最终只能有一个 Node writer；return 页面只提示回 App/网页核对，不推断成功。
- 任何 read adapter 都不能凭空生成价格、库存、认证、授权、余额或 release-ready 状态。

Node 现有事实入口可交叉核对：

- [健康与 readiness](../backend/src/app.ts)
- [身份、legal、consent 与 immutable principal](../backend/src/account/routes.ts)
- [Qixiang 充值与渠道通知](../backend/src/topups/qixiang-routes.ts)
- [资源市场](../backend/src/market/routes.ts)
- [供应商询期目录](../backend/src/supplier-inquiry-catalog/routes.ts)
- [资源询期](../backend/src/resource-inquiries/routes.ts)
- [订单状态机](../backend/src/credit-orders/routes.ts)

## 3. U0–U4 执行步骤

### U0 — 盘点、冻结合同、不动流量

进入条件：无。

动作：

1. 审批 JSON 路由表；route key 必须是唯一的 `METHOD + legacyPath`。
2. 校验 source manifest：真实审计 `server.py`、`output-production.js` 和本地 Node TypeScript corpus 的 SHA-256、字节数、行数、提取器版本与 normalized digest 必须全部一致；任一漂移立即 fail，不得拿仓库 fixture 或同名空文件代替。
3. 给所有遗留写路径标 owner、canonical Node domain、迁移键和幂等策略；没有明确 owner 的写路径只能 `quarantine` 或 `retire`。
4. 记录 Python SQLite 只读基线：表级行数、状态分布、金额/卡时汇总和最大更新时间。只保存聚合，不导出 PII、token、渠道参数或文件内容。
5. 冻结 provider callback 清单。渠道配置没有明确唯一目标前，不改回调、不做影子回调。
6. 为 Web compatibility gateway 准备 fail-closed 路由：未知 `/api/*` 404；退役路由 410；写 adapter 未获批准时 503，不转旧服务。
7. 确认身份映射只使用已验证 KAI `sub`，并有一对一唯一约束；旧邮箱/手机号只可作为待人工核对资料，不可作为合并键。

退出证据：路由表 87/87、无重复、审批人、只读基线摘要、provider callback owner、回滚演练计划。

### U1 — 只读影子与兼容层验证

进入条件：U0 完成；未发生本批 Node 首笔生产写。

动作：

1. 只对 JSON 中 `shadow=allowed*` 的 GET 做影子请求；POST、DELETE、provider callback、授权 callback 一律不影子。
2. 影子对比只记录结构、状态枚举、数量和脱敏摘要；不记录用户字段、URL query、凭据或正文。
3. compatibility adapter 调用 canonical Node service，但还不承接生产写。adapter 输出必须严格 decoder；HTML、额外敏感字段或矛盾状态 fail closed。
4. 验证网页 `/api/health`、`/api/config/readiness` 与 App `/mobile/v1/health`、`/mobile/v1/readiness` 来自同一 Node release。若当前响应没有不可伪造的部署 revision 证据，保持 blocker，不以相同文案代替。
5. 关闭 Python 进程做隔离演练：影子网页和 App canonical 读应继续工作；任何隐式依赖都阻断 U2。

退出证据：允许影子路由零副作用、结构差异清单、Node 同服务证据、Python 隔离演练、无 provider callback 副本。

### U2 — 冻结遗留写、迁移与对账

进入条件：U1 通过；维护窗口和自动恢复保护已批准。

动作：

1. 在入口和数据库连接两层同时阻断 Python mutation；SQLite 以只读模式打开，并验证写 SQL 必然失败。
2. 取得一致性只读快照，生成不含 PII 的清单与摘要。快照不可成为新的在线 writer。
3. 为需迁移路由建立显式 legacy ID → canonical UUID 映射；映射表只能在 Node PostgreSQL 维护，必须唯一、可审计、可重复执行。
4. 按依赖顺序迁移：immutable subject mapping → supplier/resource → inquiry/order → delivery/case → ledger/payment references。金额、卡时和状态不可通过默认值补齐。
5. 逐域对账：数量、状态分布、余额守恒、订单/退款闭合、callback 未决项、删除请求、审计链。任何不平衡项进入 quarantine，不解封相应写路由。
6. 仅迁移记录，不对用户发送通知、不触发支付、不重放 provider callback、不执行业务状态推进。

退出证据：SQLite query-only 实证、迁移重复执行无新增、每域对账为零差异或有明确 quarantine 清单、Node 首写授权单。

### U3 — Node 首写与统一流量切换

进入条件：U2 完成，全部 blocker 清零；这是回滚边界。

动作：

1. 先切健康/readiness 与只读 adapter，再切低风险 canonical writes，最后才切支付 callback/订单/账本类写入。
2. 第一笔被 Node PostgreSQL 接受的生产 mutation 记为 `NODE_FIRST_WRITE`，记录 UTC 时间、route key、Node revision、幂等键摘要和事务结果；不得记录请求正文或身份信息。
3. `NODE_FIRST_WRITE` 后，Python/SQLite 永久保持 query-only。网页发布回滚也不能恢复 Python writer。
4. 网页 `/api/*` compatibility write 只调用一次 canonical Node command；App 继续调用相同 command。两者共享幂等与主体边界。
5. Qixiang notify 改到 Node 前先确认旧目标停止接收；切换后验证渠道事件只产生一个 Node 状态推进。return 仍是只读提示。
6. 每一批 canary 后检查：Node 写入数、幂等 replay、PG 冲突、未决支付、adapter 4xx/5xx、旧 SQLite 修改时间和 legacy mutation 拒绝数。

退出证据：网页与 App 同服务验证全绿、Python 写入为零、支付唯一 callback、关键状态机 canary、可执行的 post-write rollback。

### U4 — 去兼容层与遗留退役

进入条件：U3 稳定观察期结束；所有 Web 调用已迁到 canonical contracts。

动作：

1. 删除不再使用的 adapter；retire 路由固定 404/410，不把流量转回 Python。
2. provider、DNS/gateway、Web bundle 和 App bundle 扫描均不得引用退役写路径。
3. 关闭 Python 网络入口；如保留审计查询，必须是受限离线工具或独立 query-only 端点，无 cookie、无 mutation、无 provider callback。
4. 归档 SQLite 快照与迁移映射，按审计保留策略加密、限权、记录销毁时间；不得打包进网页、App 或 Node 镜像。
5. 最终清除旧凭据和渠道配置引用，但不在报告中输出其值。

退出证据：兼容层使用量为零、遗留进程停止、所有写只在 Node PG、退役路径负向测试、归档审批。

## 4. 回滚分界与动作

### 分界 A：`NODE_FIRST_WRITE` 之前

可以中止发布并恢复原流量，但必须同时满足：

- 本批 Node PostgreSQL 中没有任何生产 mutation；只读影子和隔离测试数据不计入生产写，但必须可证明隔离。
- provider callback 仍只有原 owner，未曾双投。
- 没有在 Node 建立只存在于新状态机的用户可见记录。

此时回滚的是路由/compatibility 发布。恢复旧 writer 前要复核 SQLite 未被 query-only 演练留下半配置状态。

### 分界 B：`NODE_FIRST_WRITE` 之后

**禁止把业务 writer 回切到 Python/SQLite。** 可执行的回滚只有：

1. 回滚网页静态资源或 adapter 版本，但 write adapter 继续指向 Node。
2. 对故障域关闭新写、进入 Node read-only/维护模式；其他已验证 Node 域继续运行。
3. 回滚有缺陷的 Node release 到兼容当前 PG schema 的上一 Node release。
4. 对单笔错误使用 canonical 补偿/撤销命令；禁止改 SQLite、删 PG 行或把旧库覆盖回去。
5. 支付故障时保持 Node notify 唯一 owner，暂停创建/核对并人工排队；不能临时恢复旧支付 writer。

触发任一条件立即停批：余额或金额不守恒、同一幂等键产生两笔写、provider callback 双消费、immutable `sub` 映射冲突、Python SQLite 修改时间变化、网页与 App 看到不同 Node 状态、readiness 错误放行。

## 5. Web / App 同服务 readiness blocker

Readiness 采用**集合并集**，不是覆盖：canonical Node readiness 的 blocker 必须原样保留，U0 compatibility 只能追加自己的 blocker，不能删除、改名、折叠或用旧服务的“ready”覆盖。U0 路由表全部批准、甚至 U0 blocker 全部清零，都不等于 release ready。

以下已知 blocker 是不可删除的最低集合；它们保持到各自权威证据完成并由 canonical owner 清除：

| 类别 | 必须保留的 blocker |
| --- | --- |
| 法务 | `ICP_FILING_NOT_APPROVED`、`APP_FILING_NOT_APPROVED`、`INTERNET_SERVICE_CLASSIFICATION_REQUIRED` |
| Qixiang 凭据 | `QIXIANG_CREDENTIAL_ROTATION_UNPROVEN`、`QIXIANG_OLD_CREDENTIAL_REVOCATION_UNPROVEN` |
| Qixiang 部署/运行时 | `QIXIANG_SERVICE_CONSTRUCTION_UNPROVEN`、`QIXIANG_SCHEMA_0063_DEPLOYMENT_UNPROVEN`、`QIXIANG_RUNTIME_INTEGRATION_PENDING` |
| Qixiang 账本/双审 | `QIXIANG_LOT_ACCOUNTING_UNPROVEN`、`QIXIANG_EVIDENCE_DUAL_REVIEW_UNPROVEN` |
| 渠道 owner/历史映射 | `QIXIANG_UNIQUE_CALLBACK_OWNER_UNPROVEN`、`LEGACY_PAYMENT_PROVIDER_ID_RECONCILIATION_INCOMPLETE`、`LEGACY_PAYMENT_TOPUP_ID_MAPPING_UNPROVEN` |
| 全域迁移 | `LEGACY_DATA_RECONCILIATION_INCOMPLETE` |

旧聊天中出现过的 Qixiang credential 必须按 compromised 处理，只能通过轮换、旧凭据撤销和双人审计证据清除对应 blocker；文档、adapter 或环境变量“已填写”都不能清除。schema 0063、运行时 service 构造和 lot accounting 也必须有实际部署/行为证据。

以下是额外的 U0 审计 blocker 名，不是假定当前 API 已实现的错误码：

| Blocker | 清零条件 |
| --- | --- |
| `U0_ROUTE_MAP_UNAPPROVED` | 87 条路由逐条批准，未知路由 fail closed |
| `LEGACY_WRITES_NOT_FROZEN` | Python 入口拒绝 mutation，SQLite 只读连接写入测试失败 |
| `NODE_WRITER_IDENTITY_UNPROVEN` | Node revision 与 PG writer 身份有部署侧证据，不能只看相同响应文案 |
| `IDENTITY_SUB_MAPPING_UNPROVEN` | Web session 与 App bearer 映射到同一 immutable `sub`/canonical subject，且唯一约束有效 |
| `DATA_RECONCILIATION_INCOMPLETE` | U0 逐域数量、状态和账本对账闭合；不能替代 canonical `LEGACY_DATA_RECONCILIATION_INCOMPLETE` |
| `PAYMENT_CALLBACK_TARGET_UNPROVEN` | 每一 provider event 只有 Node 一个可写目标，旧回调不可达或只隔离排空 |
| `WEB_APP_SERVICE_MISMATCH` | Web adapter 与 App canonical read 在同一 Node revision 返回同一 canonical record/version |
| `QUERY_ONLY_GUARD_UNPROVEN` | 遗留 SQLite mutation、DDL、callback 写全部被数据库层拒绝 |
| `ROLLBACK_DRILL_INCOMPLETE` | pre-write 与 post-write 两条回滚均实跑，post-write 从未恢复旧 writer |
| `LEGACY_DEPENDENCY_PRESENT` | 停止 Python 后 Web/App canonical 路径仍完整；否则不清零 |

release readiness 只能在 canonical blocker 与 U0 blocker 的并集为空、且 release owner 明确批准时为 ready。compatibility adapter 不能删除、改名或隐藏任何 canonical blocker。

## 6. 验证清单

### 6.1 静态与合同

- [ ] JSON 可解析，`routeCount=87`，实际 87，`METHOD + legacyPath` 唯一。
- [ ] status 只来自 `reuse/adapter/migrate/quarantine/retire`。
- [ ] 每条包含 auth、io、payment、shadow、cutoverTarget、forbidden。
- [ ] Web bundle 中所有 `/api/*` 使用均能命中映射；未知路径构建失败。
- [ ] Node target 路径在本地 route registration 中存在；空 target 只能是 quarantine/retire 或待迁移域。
- [ ] 文档不得含密码、token、provider query、邮箱、手机号、真实 subject、数据库连接或远端地址。

### 6.2 同一服务与身份

- [ ] Web `/api/health` adapter 与 App `/mobile/v1/health` 均返回 canonical `service=kai-cloudpay-backend`，且部署侧 revision 一致。
- [ ] Web `/api/config/readiness` 与 App `/mobile/v1/readiness` 的 profile、release.ready、blockers、支付与目录 capability projection 一致。
- [ ] readiness 为 HTML、缺字段、额外敏感字段或矛盾状态时，两端均 fail closed，且 mutation 调用数为 0。
- [ ] 使用无 PII 的隔离测试主体，Web cookie/session 与 App bearer 均解析到同一 canonical subject；比较只记录布尔结果或不可逆摘要。
- [ ] 改变显示名、邮箱或手机号不改变 subject mapping；不同 immutable `sub` 绝不合并。
- [ ] Web legal/operator adapter 与 App `/mobile/v1/legal` 返回同一版本和运营主体记录；不硬编码补值。

### 6.3 同一 PostgreSQL 状态机

- [ ] Web 创建的允许写入通过 Node canonical command 后，App canonical GET 读取同一 UUID、version、status；反向亦然。
- [ ] 相同主体、相同幂等键从 Web/App 重放只得到一条记录；跨主体不可读、不可重放、不可清除。
- [ ] resource inquiry、order、delivery、dispute/refund/invoice 分别验证一次合法状态推进和一次非法状态拒绝。
- [ ] 聚合余额、卡时和订单状态由 Node PG 读取；Python SQLite 的文件修改时间、数据版本和表计数保持不变。
- [ ] 停止 Python 后 Web adapter 与 App canonical 测试仍通过；停止 Node 后两端同时 fail closed，绝不回落旧服务。

### 6.4 支付

- [ ] Qixiang create/list/detail/recheck 只经 Node；Web 若尚未有 canonical UI，则入口保持关闭，不能调用旧 create。
- [ ] notify 只能到 Node，单个 provider event 只推进一次；不做 shadow callback。
- [ ] return/浏览器关闭/AppState 只触发 GET/detail，不能推断成功或自动 POST recheck。
- [ ] 旧 `/api/payments/create`、mock-complete、legacy CNY order callback 404/410 或隔离排空，不能适配为卡时充值。
- [ ] 测试与日志不含签名参数、provider query、checkout URL、token、密钥或完整请求正文。

### 6.5 回滚与遗留只读

- [ ] pre-write 演练：证明无 Node 生产写后回滚入口，不产生双 writer。
- [ ] post-write 演练：回滚 Web/Node release，但 Node PG 仍是唯一 writer；Python 保持 query-only。
- [ ] SQLite 连接层分别执行 INSERT/UPDATE/DELETE/DDL 负向测试，全部拒绝；GET 审计查询仍可按批准范围工作。
- [ ] provider callback 切换期间与回滚后始终只有一个 owner。
- [ ] U4 负向扫描确认 Web、App、gateway、provider 配置均无退役写路径和旧凭据引用。

## 7. 冻结版本的自校验命令

这些命令只读或检查文档，不启动服务、不访问远端：

```sh
python3 -m json.tool docs/U0_WEB_NODE_COMPATIBILITY_MAP.json >/dev/null
python3 -m json.tool docs/U0_WEB_NODE_COMPATIBILITY_MAP.schema.json >/dev/null
python3 - <<'PY'
import collections,hashlib,json,pathlib,re
p='docs/U0_WEB_NODE_COMPATIBILITY_MAP.json'
d=json.load(open(p, encoding='utf-8'))
s=json.load(open('docs/U0_WEB_NODE_COMPATIBILITY_MAP.schema.json', encoding='utf-8'))
assert d['$schema']=='./U0_WEB_NODE_COMPATIBILITY_MAP.schema.json'
assert set(d)==set(s['required'])
routes=d['routes']
assert len(routes)==d['routeCount']==87
keys={(r['method'],r['legacyPath']) for r in routes}
assert len(keys)==87
assert {r['status'] for r in routes}<={'reuse','adapter','migrate','quarantine','retire'}
assert {(r['method'],r['status']) for r in routes if r['legacyPath']=='/api/payments/callback/qixiang'}=={('GET','quarantine')}
assert {(r['method'],r['status']) for r in routes if r['legacyPath']=='/api/payments/status'}=={('GET','migrate')}
route_schema=s['$defs']['route']
required=set(route_schema['required'])
assert all(set(r)==required for r in routes)
for field in ('method','auth','io','webUsage','status','shadow','cutoverTarget'):
    allowed=set(route_schema['properties'][field]['enum'])
    assert all(r[field] in allowed for r in routes)
assert all(r['shadow']=='forbidden' for r in routes if r['io'] in {'write','callback'})
assert all(r['nodeRoutes'] for r in routes if r['status'] in {'reuse','adapter'})
assert all(not r['nodeRoutes'] for r in routes if r['status']=='retire')

sources={item['id']:item for item in d['sources']}
for source_id in ('legacy-python-production-audit','legacy-web-production-audit'):
    source=sources[source_id]; data=pathlib.Path(source['locator']).read_bytes()
    assert len(data)==source['bytes']
    assert len(data.splitlines())==source['lineCount']
    assert 'sha256:'+hashlib.sha256(data).hexdigest()==source['sha256Digest']

legacy=pathlib.Path(sources['legacy-python-production-audit']['locator']).read_text(encoding='utf-8')
dispatch=legacy[legacy.index('    def do_GET(self)'):legacy.index('    def read_json(self)')]
extracted=set()
for method,name in (('GET','do_GET'),('POST','do_POST')):
    start=dispatch.index(f'    def {name}(self)')
    end=dispatch.find('\n    def ',start+1)
    part=dispatch[start:] if end<0 else dispatch[start:end]
    paths=set(re.findall(r'path\s*==\s*["\'](/api/[^"\']+)["\']',part))
    for group in re.findall(r'path\s+in\s+\(([^)]*)\)',part):
        paths.update(re.findall(r'["\'](/api/[^"\']+)["\']',group))
    for pattern in re.findall(r're\.fullmatch\(r["\']([^"\']+)["\']\s*,\s*path\)',part):
        path=re.sub(r'\(\[\^/\]\+\)',':id',pattern)
        paths.add(re.sub(r'\(alipay\|wechat\)',':provider',path).replace('\\/','/'))
    extracted.update((method,path) for path in paths)
assert extracted==keys

route_blob=''.join(f'{method} {path}\n' for method,path in sorted(keys)).encode()
assert 'sha256:'+hashlib.sha256(route_blob).hexdigest()==sources['legacy-python-production-audit']['normalizedDigest']

web_evidence=d['webApiPrefixEvidence']
assert len(web_evidence)==23
web=pathlib.Path(sources['legacy-web-production-audit']['locator']).read_text(encoding='utf-8')
extracted_web=collections.defaultdict(list)
for line_number,line in enumerate(web.splitlines(),1):
    for prefix in re.findall(r'["\'`](/api/[^"\'`?$ ]+)',line):
        extracted_web[prefix.split('?')[0]].append(line_number)
assert dict(extracted_web)=={item['prefix']:item['lineNumbers'] for item in web_evidence}
web_blob=''.join(item['prefix']+'\n' for item in sorted(web_evidence,key=lambda item:item['prefix'])).encode()
assert 'sha256:'+hashlib.sha256(web_blob).hexdigest()==sources['legacy-web-production-audit']['normalizedDigest']

node_targets=sorted({target for route in routes for target in route['nodeRoutes']})
node_blob=''.join(target+'\n' for target in node_targets).encode()
assert len(node_targets)==sources['node-api-route-corpus']['normalizedCount']==71
assert 'sha256:'+hashlib.sha256(node_blob).hexdigest()==sources['node-api-route-corpus']['normalizedDigest']

node_files=sorted(pathlib.Path('backend/src').rglob('*.ts'))
rows=[]
for node_file in node_files:
    data=node_file.read_bytes()
    rows.append(f'{node_file.as_posix()}\0sha256:{hashlib.sha256(data).hexdigest()}\0{len(data)}\0{len(data.splitlines())}\n')
corpus=''.join(rows).encode(); source=sources['node-api-route-corpus']
assert len(node_files)==source['fileCount']
assert 'sha256:'+hashlib.sha256(corpus).hexdigest()==source['sha256Digest']

policy=d['canonicalReadinessPolicy']
assert policy['mergeMode']=='set_union_only'
assert policy['compatibilityLayerMayRemoveBlockers'] is False
assert policy['u0ApprovalImpliesReleaseReady'] is False
required_blockers=set(s['properties']['canonicalReadinessPolicy']['properties']['requiredAdditiveBlockers']['const'])
assert set(policy['requiredAdditiveBlockers'])==required_blockers
PY
git diff --check -- docs/U0_WEB_NODE_COMPATIBILITY_MAP.json docs/U0_WEB_NODE_COMPATIBILITY_MAP.schema.json docs/U0_SINGLE_WRITER_CUTOVER_RUNBOOK.md
```

审批时还必须用部署与隔离测试证据清零第 5 节 blocker；文档自校验通过不等于生产已经完成 U0，更不等于 U3 切换获批。
