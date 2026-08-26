const state = {
  fixture: null,
  retrievalReport: null,
  ctrReport: null,
  positionReport: null,
  history: 0,
  retrievalModel: "itemKnn",
  retrievalMode: "exact",
  ctrModel: "deepfm",
  positionMethod: "naive_bts",
  clipping: "none",
};

const $ = (selector) => document.querySelector(selector);
const labels = {
  popularity: "热门召回",
  itemKnn: "相似商品召回",
  bprMf: "矩阵分解",
  twoTower: "双塔召回",
  logistic_regression: "逻辑回归",
  deepfm: "深度因子分解机",
  dcnv2: "深度交叉网络",
  naive_bts: "直接统计",
  ips: "逆倾向加权",
  snips: "归一化逆倾向加权",
};

function number(value, digits = 4) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function integer(value) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function renderButtons(selector, options, selected, onChange, disabled = false) {
  const root = $(selector);
  root.replaceChildren();
  options.forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.disabled = disabled;
    button.setAttribute("aria-pressed", String(option.id === selected));
    button.addEventListener("click", () => onChange(option.id));
    root.append(button);
  });
}

function renderMetrics(selector, metrics) {
  const root = $(selector);
  root.replaceChildren();
  metrics.forEach((metric) => {
    const cell = document.createElement("div");
    cell.className = "metric-cell";
    const label = document.createElement("span");
    label.className = "metric-label";
    label.textContent = metric.label;
    const value = document.createElement("strong");
    value.className = "metric-value";
    value.textContent = metric.integer ? integer(metric.value) : number(metric.value, metric.digits ?? 4);
    cell.append(label, value);
    if (metric.std !== undefined) {
      const std = document.createElement("span");
      std.className = "metric-std";
      std.textContent = `标准差 · ${number(metric.std, metric.digits ?? 4)}`;
      cell.append(std);
    }
    root.append(cell);
  });
}

function status(selector, value, kind = "complete") {
  const node = $(selector);
  node.textContent = value;
  node.dataset.state = kind;
}

function retrievalSummary() {
  const models = state.retrievalReport.results.models;
  return state.retrievalModel === "twoTower"
    ? models.twoTower.exactSummary
    : models[state.retrievalModel].summary;
}

function retrievalControls() {
  renderButtons(
    "#retrieval-histories",
    state.fixture.amazon.histories.map((_, index) => ({ id: index, label: `用户 ${String.fromCharCode(65 + index)}` })),
    state.history,
    (id) => {
      state.history = id;
      renderRetrieval(false);
    },
  );
  renderButtons(
    "#retrieval-models",
    ["popularity", "itemKnn", "bprMf", "twoTower"].map((id) => ({ id, label: labels[id] })),
    state.retrievalModel,
    (id) => {
      state.retrievalModel = id;
      if (id !== "twoTower") state.retrievalMode = "exact";
      renderRetrieval(false);
    },
  );
  renderButtons(
    "#retrieval-modes",
    [
      { id: "exact", label: "精确检索" },
      { id: "ann", label: "近似检索" },
    ],
    state.retrievalMode,
    (id) => {
      state.retrievalMode = id;
      renderRetrieval(false);
    },
    state.retrievalModel !== "twoTower",
  );
}

function renderRetrieval(run = false) {
  retrievalControls();
  const counts = state.retrievalReport.protocol.counts;
  $("#pipeline-catalog").textContent = `${integer(counts.trainCatalogItems)} 件商品`;
  $("#retrieval-catalog").textContent = `${integer(counts.trainCatalogItems)} 件商品`;
  $("#retrieval-cohort").textContent = `${integer(counts.testEvaluationUsers)} 名共同测试用户`;

  const history = state.fixture.amazon.histories[state.history];
  const tokens = $("#retrieval-history");
  tokens.replaceChildren();
  history.history.forEach((item) => {
    const token = document.createElement("span");
    token.textContent = item;
    tokens.append(token);
  });
  $("#retrieval-target").textContent = history.actualNextItem;

  const summary = retrievalSummary();
  renderMetrics("#retrieval-metrics", [
    { label: "召回率 Recall@20", value: summary["20"].recall.mean },
    { label: "召回率 Recall@50", value: summary["50"].recall.mean },
    { label: "召回率 Recall@100", value: summary["100"].recall.mean },
    { label: "首个命中排名 MRR@100", value: summary["100"].mrr.mean },
    { label: "排序质量 NDCG@100", value: summary["100"].ndcg.mean },
  ]);

  const annRoot = $("#retrieval-ann");
  const showAnn = state.retrievalModel === "twoTower" && state.retrievalMode === "ann";
  annRoot.hidden = !showAnn;
  if (showAnn) {
    const ann = state.retrievalReport.results.models.twoTower.annSummary;
    annRoot.replaceChildren();
    [
      ["近似检索覆盖率@100", ann.annRecall["100"].mean, 4, ""],
      ["一半请求耗时 p50", ann.p50LatencyMs.mean, 3, " 毫秒"],
      ["95% 请求耗时 p95", ann.p95LatencyMs.mean, 3, " 毫秒"],
      ["每秒查询数 QPS", ann.qps.mean, 0, ""],
    ].forEach((metric) => {
      const node = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = metric[0];
      const value = document.createElement("strong");
      value.textContent = `${number(metric[1], metric[2])}${metric[3]}`;
      node.append(label, value);
      annRoot.append(node);
    });
  }

  const list = $("#retrieval-results");
  const blocked = $("#retrieval-blocked");
  list.replaceChildren();
  const retrievalModeLabel = state.retrievalMode === "ann" ? "近似检索" : "精确检索";
  $("#retrieval-result-kind").textContent = `${labels[state.retrievalModel]} · ${retrievalModeLabel}`;

  if (!run) {
    blocked.hidden = false;
    blocked.textContent = "推荐结果会在这里出现。默认使用可以真实回放的相似商品召回。";
    status("#retrieval-run-state", "选择用户后，点击按钮生成推荐。", "ready");
    return;
  }

  const results = history.recommendations[state.retrievalModel];
  if (!results) {
    blocked.hidden = false;
    blocked.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = "缺少可回放记录";
    const detail = document.createElement("span");
    detail.textContent = "这个模型有真实聚合基准指标，但没有保存用户级模型检查点和前 10 个结果。为避免伪造，这里不生成替代推荐。";
    blocked.append(title, detail);
    status("#retrieval-run-state", `${labels[state.retrievalModel]}：只有真实聚合指标，无法重放这个用户的推荐。`, "not-run");
    return;
  }

  blocked.hidden = true;
  results.forEach((item) => {
    const row = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = item;
    const source = document.createElement("span");
    source.textContent = "公开数据回放";
    row.append(name, source);
    list.append(row);
  });
  status("#retrieval-run-state", `完成：${labels[state.retrievalModel]} 已从公开训练目录回放前 10 个推荐。`, "complete");
}

function calibrationBucket(model, seed) {
  const run = state.ctrReport.results.runs.find(
    (candidate) => candidate.model === model && candidate.seed === seed,
  );
  return run.testMetrics.calibration.find(
    (bucket) => bucket.count > 0 && bucket.meanPrediction !== null,
  );
}

function renderCtr(run = false) {
  renderButtons(
    "#ctr-models",
    ["logistic_regression", "deepfm", "dcnv2"].map((id) => ({ id, label: labels[id] })),
    state.ctrModel,
    (id) => {
      state.ctrModel = id;
      renderCtr(false);
    },
  );

  const counts = state.ctrReport.protocol.counts;
  $("#ctr-split").textContent = `${integer(counts.trainRows)} / ${integer(counts.devRows)} / ${integer(counts.testRows)}`;
  $("#ctr-feature-counts").textContent = `${integer(counts.numericFeatures)} 个数值特征 · ${integer(counts.categoricalFeatures)} 个类别特征`;

  const fixture = state.fixture.criteo;
  $("#ctr-row-alias").textContent = fixture.rowAlias;
  const featureRoot = $("#ctr-features");
  featureRoot.replaceChildren();
  fixture.features.forEach((feature) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = feature.name;
    const value = document.createElement("dd");
    value.textContent = feature.value;
    row.append(term, value);
    featureRoot.append(row);
  });

  const metrics = state.ctrReport.results.summary[state.ctrModel];
  renderMetrics("#ctr-metrics", [
    { label: "排序区分能力 ROC-AUC", value: metrics.rocAuc.mean, std: metrics.rocAuc.std },
    { label: "正样本区分能力 PR-AUC", value: metrics.prAuc.mean, std: metrics.prAuc.std },
    { label: "概率损失 LogLoss ↓", value: metrics.logLoss.mean, std: metrics.logLoss.std },
    { label: "概率误差 Brier ↓", value: metrics.brierScore.mean, std: metrics.brierScore.std },
    { label: "校准误差 ECE ↓", value: metrics.ece.mean, std: metrics.ece.std },
  ]);

  const seed = state.ctrReport.protocol.seeds[0];
  const bucket = calibrationBucket(state.ctrModel, seed);
  $("#ctr-probability").textContent = run ? `${number(bucket.meanPrediction * 100, 2)}%` : "—";
  $("#ctr-probability-range").textContent = run
    ? `${labels[state.ctrModel]} · 概率校准区间 [${number(bucket.lower, 1)}, ${number(bucket.upper, 1)}) · 样本数 ${integer(bucket.count)}`
    : "点击按钮读取冻结结果";
  status(
    "#ctr-run-state",
    run
      ? `完成：展示 ${labels[state.ctrModel]} 的真实概率校准分组均值，不是单样本点击率。`
      : "选择模型后查看公开离线结果。",
    run ? "complete" : "ready",
  );
}

function positionKey() {
  if (state.positionMethod === "naive_bts") return "naive_bts";
  return state.clipping === "none"
    ? state.positionMethod
    : `${state.positionMethod}_clipped_${state.clipping}`;
}

function renderPosition(run = false) {
  renderButtons(
    "#position-methods",
    [
      { id: "naive_bts", label: "直接统计" },
      { id: "ips", label: "逆倾向加权" },
      { id: "snips", label: "归一化加权" },
    ],
    state.positionMethod,
    (id) => {
      state.positionMethod = id;
      if (id === "naive_bts") state.clipping = "none";
      renderPosition(false);
    },
  );
  renderButtons(
    "#position-clipping",
    [
      { id: "none", label: "不截断" },
      { id: "0p01", label: "0.01" },
      { id: "0p02", label: "0.02" },
      { id: "0p05", label: "0.05" },
      { id: "0p1", label: "0.10" },
    ],
    state.clipping,
    (id) => {
      state.clipping = id;
      renderPosition(false);
    },
    state.positionMethod === "naive_bts",
  );

  const counts = state.positionReport.protocol.counts;
  $("#position-bts").textContent = `${integer(counts.btsTestRows)} 行 · ${integer(counts.btsTestClicks)} 次点击`;
  $("#position-random").textContent = `${integer(counts.randomTestRows)} 行 · ${integer(counts.randomTestClicks)} 次点击`;
  const all = state.positionReport.results.policyValueEstimates;
  $("#position-reference").textContent = `随机策略实测 · ${number(all.on_policy_random.estimate, 6)}`;
  const result = all[positionKey()];

  renderMetrics("#position-primary-metrics", [
    { label: "估计结果", value: run ? result.estimate : null, digits: 6 },
    { label: "与随机实验的误差 ↓", value: run ? result.absoluteErrorToOnPolicy : null, digits: 6 },
  ]);
  renderMetrics("#position-technical-metrics", [
    { label: "有效样本量（ESS）", value: run ? result.effectiveSampleSize : null, integer: true },
    { label: "权重方差", value: run ? result.weightVariance : null, digits: 4 },
  ]);
  status(
    "#position-run-state",
    run
      ? `完成：${labels[state.positionMethod]} 的冻结实验结果已加载。`
      : "选择方法后读取冻结实验记录。",
    run ? "complete" : "ready",
  );
}

async function initialize() {
  try {
    const reportBase = document.documentElement.dataset.reportBase || "../reports";
    const responses = await Promise.all([
      fetch("./data/demo-fixtures.json"),
      fetch(`${reportBase}/amazon-retrieval-v1-results.json`),
      fetch(`${reportBase}/criteo-ctr-v1-results.json`),
      fetch(`${reportBase}/position-bias-open-bandit-full-ope-v1.json`),
    ]);
    if (!responses.every((response) => response.ok)) {
      throw new Error("one or more local artifacts could not be loaded");
    }
    [state.fixture, state.retrievalReport, state.ctrReport, state.positionReport] = await Promise.all(
      responses.map((response) => response.json()),
    );
    renderRetrieval();
    renderCtr();
    renderPosition();

    $("#retrieval-run").addEventListener("click", () => renderRetrieval(true));
    $("#ctr-run").addEventListener("click", () => renderCtr(true));
    $("#position-run").addEventListener("click", () => renderPosition(true));
    $("#open-technical-details").addEventListener("click", () => {
      const details = $("#position-details");
      details.open = true;
      details.querySelector("summary").focus();
      $("#open-technical-details").textContent = "技术细节已打开";
    });
  } catch (error) {
    console.error(error);
    $("#load-error").hidden = false;
  }
}

initialize();
