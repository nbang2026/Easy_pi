import { icon } from "./icons.ts";
import { formatUserError } from "./utils.ts";
type Total = { tokens: number; records: number; cost: number | null; knownCost: number; unknownCost: number; cacheHit: number | null; input: number; output: number; cacheRead: number; cacheWrite: number };
type Group = Total & { name: string };
type ModelGroup = Total & { id: string; provider: string; model: string };
type TrendDay = Group & { models: ModelGroup[] };
type Row = { at: number; provider: string; model: string; sessionId: string; taskId: string; cost: number | null; input: number; output: number; cacheRead: number; cacheWrite: number };
type Summary = { today: Total; last24Hours: Total; month: Total; all: Total; selected: Total; days: Group[]; trend: TrendDay[];
  modelBreakdown: ModelGroup[]; sessions: Group[]; tasks: Group[]; rows: Row[]; providers: string[]; models: string[];
  rowsTruncated: boolean; modelsTruncated: boolean; groupsTruncated: boolean; source?: string; warnings?: { file: string }[] };
type UsageMetric = "tokens" | "records" | "knownCost";
type UsageView = "records" | "trend" | "distribution" | "ranking";
const chartColors = ["#188b78", "#368ee5", "#d98a20", "#8a63c7", "#da6477", "#4b9a58"];
const day = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export function setupUsageSettings(options: {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  language(): string;
}) {
  const pane = document.getElementById("pane-usage")!;
  let disposed = false, generation = 0, exporting = false, loading = false, data: Summary | undefined;
  let usageView: UsageView = "trend", usageMetric: UsageMetric = "tokens";
  const hiddenModels = new Set<string>();
  let chartTooltip: HTMLElement | undefined;
  let tooltipAnchor: HTMLElement | undefined;
  let month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const text = (zh: string, en: string) => options.language() === "en" ? en : zh;
  const money = (cost: number | null) => cost === null ? "—" : `$${cost.toFixed(4)}`;
  const metricLabel = (metric: UsageMetric) => metric === "tokens"
    ? text("Token 数", "Tokens") : metric === "records" ? text("用量记录", "Usage records") : text("已知费用 USD", "Known cost USD");
  const metricValue = (value: Total) => usageMetric === "tokens" ? value.tokens
    : usageMetric === "records" ? value.records : value.knownCost;
  const formatMetric = (value: number) => usageMetric === "knownCost" ? money(value) : value.toLocaleString();
  const el = <T extends HTMLElement>(id: string) => pane.querySelector<T>(`#${id}`)!;
  const filter = () => ({ provider: el<HTMLSelectElement>("usage-provider").value,
    model: el<HTMLSelectElement>("usage-model").value, from: el<HTMLInputElement>("usage-from").value,
    to: el<HTMLInputElement>("usage-to").value });
  const request = async <T>(value: Record<string, unknown>) =>
    (await options.invoke<{ data: T }>("gui_action", { action: "usage", text: JSON.stringify(value) })).data;
  const hideChartTooltip = () => {
    tooltipAnchor?.removeAttribute("aria-describedby");
    tooltipAnchor = undefined;
    chartTooltip?.remove();
    chartTooltip = undefined;
  };
  const showChartTooltip = (row: TrendDay, anchor: HTMLElement, models: ModelGroup[], visibleIds: Set<string>, colorById: Map<string, string>) => {
    hideChartTooltip();
    const tooltip = document.createElement("div");
    tooltip.id = "usage-chart-tooltip";
    tooltip.className = "usage-chart-tooltip";
    tooltip.setAttribute("role", "tooltip");
    const date = document.createElement("strong");
    date.textContent = row.name.slice(5).replace("-", "–");
    tooltip.append(date);
    const rowModels = new Map(row.models.map(model => [model.id, model]));
    const totalValue = row.models.reduce((sum, model) => sum + (visibleIds.has(model.id) ? metricValue(model) : 0), 0);
    const total = document.createElement("div");
    total.className = "usage-chart-tooltip-total";
    const totalLabel = document.createElement("span");
    totalLabel.textContent = text("总计", "Total");
    const totalAmount = document.createElement("strong");
    totalAmount.textContent = formatMetric(totalValue);
    total.append(totalLabel, totalAmount);
    tooltip.append(total);
    for (const model of models) {
      if (!visibleIds.has(model.id)) continue;
      const line = document.createElement("div");
      line.className = "usage-chart-tooltip-model";
      const swatch = document.createElement("span");
      swatch.className = "usage-chart-tooltip-swatch";
      swatch.style.backgroundColor = colorById.get(model.id) || chartColors[0];
      swatch.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.textContent = model.provider ? `${model.provider}/${model.model}` : model.model;
      const amount = document.createElement("strong");
      amount.textContent = formatMetric(metricValue(rowModels.get(model.id) || {
        ...model, records: 0, tokens: 0, knownCost: 0,
      }));
      line.append(swatch, name, amount);
      tooltip.append(line);
    }
    document.body.append(tooltip);
    const view = pane.ownerDocument.defaultView;
    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth = view?.innerWidth || 800;
    const viewportHeight = view?.innerHeight || 600;
    const left = Math.min(Math.max(8, anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2), Math.max(8, viewportWidth - tooltipRect.width - 8));
    let top = anchorRect.top - tooltipRect.height - 8;
    if (top < 8) top = anchorRect.bottom + 8;
    if (top + tooltipRect.height > viewportHeight - 8) top = Math.max(8, viewportHeight - tooltipRect.height - 8);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    chartTooltip = tooltip;
    tooltipAnchor = anchor;
    anchor.setAttribute("aria-describedby", tooltip.id);
  };
  const setMonths = () => {
    el<HTMLInputElement>("usage-from").value = day(month);
    el<HTMLInputElement>("usage-to").value = day(new Date(month.getFullYear(), month.getMonth() + 1, 0));
  };
  const build = () => {
    hideChartTooltip();
    pane.innerHTML = `<div class="section-heading"><h3>${text("用量分析", "Usage analysis")}</h3><div class="settings-options"><button id="usage-refresh" type="button" class="icon-button"></button><button id="usage-csv" type="button">CSV</button><button id="usage-json" type="button">JSON</button></div></div>
      <div class="usage-toolbar"><label>${text("供应商", "Provider")}<select id="usage-provider" class="settings-input"></select></label><label>${text("模型", "Model")}<select id="usage-model" class="settings-input"></select></label></div>
      <div id="usage-totals" class="usage-totals"></div>
      <p id="usage-cache" class="settings-hint"></p>
      <section class="usage-analysis" aria-labelledby="usage-analysis-title">
        <div class="usage-analysis-heading"><div><h4 id="usage-analysis-title">${text("使用趋势", "Usage trends")}</h4><p id="usage-analysis-summary"></p></div>
          <div class="usage-view-tabs" role="tablist" aria-label="${text("分析视图", "Analysis view")}">
            <button type="button" role="tab" data-usage-view="trend">${text("趋势", "Trend")}</button>
            <button type="button" role="tab" data-usage-view="distribution">${text("模型分布", "Model mix")}</button>
            <button type="button" role="tab" data-usage-view="ranking">${text("模型排行", "Model ranking")}</button>
            <button type="button" role="tab" data-usage-view="records">${text("详细记录", "Records")}</button>
          </div>
        </div>
        <div class="usage-analysis-toolbar"><span id="usage-metric-label"></span><div class="usage-metric-tabs" role="group" aria-label="${text("统计指标", "Measure")}">
          <button type="button" data-usage-metric="tokens">${text("Token", "Tokens")}</button>
          <button type="button" data-usage-metric="records">${text("记录", "Records")}</button>
          <button type="button" data-usage-metric="knownCost">${text("费用", "Cost")}</button>
        </div></div>
        <div id="usage-chart" class="usage-chart"></div>
        <div id="usage-legend" class="usage-legend"></div>
        <p id="usage-analysis-note" class="settings-hint"></p>
      </section>
      <div class="section-heading"><button id="usage-prev" class="icon-button" type="button"></button><span id="usage-month"></span><button id="usage-next" class="icon-button" type="button"></button></div>
      <div id="usage-calendar" class="usage-calendar"></div>
      <div class="usage-toolbar"><label>${text("开始日期", "From")}<input id="usage-from" class="settings-input" type="date" /></label><label>${text("结束日期", "To")}<input id="usage-to" class="settings-input" type="date" /></label><label>${text("统计方式", "Group by")}<select id="usage-group" class="settings-input"><option value="rows">${text("逐笔记录", "Events")}</option><option value="days">${text("按天", "Day")}</option><option value="sessions">${text("按会话", "Session")}</option><option value="tasks">${text("按任务", "Task")}</option></select></label><button id="usage-all" type="button">${text("全部日期", "All dates")}</button></div>
      <p id="usage-selected" class="settings-hint"></p><div class="usage-table-wrap"><table id="usage-table" class="usage-table"></table></div>
      <p id="usage-message" class="settings-hint" role="status"></p>
      <p class="settings-hint">${text("来源：已打开的 Pi 会话及此后新增记录。美元费用采用 Pi 记录的模型价格，非供应商账单；含缺失价格的汇总显示 —。", "Source: opened Pi sessions and new events. USD uses Pi-recorded model pricing, not provider invoices. Incomplete totals display —.")}</p>`;
    for (const [id, name, zh, en] of [["usage-refresh", "refresh-cw", "刷新", "Refresh"], ["usage-prev", "chevron-left", "上个月", "Previous month"], ["usage-next", "chevron-right", "下个月", "Next month"]]) {
      el(id).append(icon(name)); el(id).title = text(zh, en); el(id).setAttribute("aria-label", text(zh, en));
    }
    setMonths();
    el("usage-refresh").addEventListener("click", () => { void refresh(); });
    for (const id of ["usage-from", "usage-to"]) el(id).addEventListener("change", () => { void refresh(); });
    el("usage-provider").addEventListener("change", () => { el<HTMLSelectElement>("usage-model").value = ""; void refresh(); });
    el("usage-model").addEventListener("change", () => { void refresh(); });
    el("usage-group").addEventListener("change", renderTable);
    for (const button of pane.querySelectorAll<HTMLButtonElement>("[data-usage-view]")) {
      button.addEventListener("click", () => {
        usageView = button.dataset.usageView as UsageView;
        renderAnalysis();
      });
    }
    for (const button of pane.querySelectorAll<HTMLButtonElement>("[data-usage-metric]")) {
      button.addEventListener("click", () => {
        usageMetric = button.dataset.usageMetric as UsageMetric;
        renderAnalysis();
      });
    }
    el("usage-all").addEventListener("click", () => { el<HTMLInputElement>("usage-from").value = ""; el<HTMLInputElement>("usage-to").value = ""; void refresh(); });
    for (const [id, offset] of [["usage-prev", -1], ["usage-next", 1]] as const) {
      el(id).addEventListener("click", () => { month = new Date(month.getFullYear(), month.getMonth() + offset, 1); setMonths(); void refresh(); });
    }
    el("usage-csv").addEventListener("click", () => { void exportFile("csv"); });
    el("usage-json").addEventListener("click", () => { void exportFile("json"); });
  };
  const fillSelect = (id: string, values: string[], selected: string) => {
    const select = el<HTMLSelectElement>(id);
    const all = document.createElement("option"); all.value = ""; all.textContent = text("全部", "All");
    select.replaceChildren(all);
    for (const value of values) { const item = document.createElement("option"); item.value = value; item.textContent = value; select.append(item); }
    select.value = values.includes(selected) ? selected : "";
  };
  const renderTable = () => {
    if (!data) return;
    const group = el<HTMLSelectElement>("usage-group").value as "rows" | "days" | "sessions" | "tasks";
    const table = el<HTMLTableElement>("usage-table"); table.replaceChildren();
    const head = table.createTHead().insertRow();
    const headings = [text("时间 / 标识", "Time / ID"), ...(group === "rows" ? [text("模型", "Model")] : []),
      text("输入", "Input"), text("输出", "Output"), text("缓存读", "Cache read"), text("缓存写", "Cache write"), "USD"];
    for (const title of headings) { const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = title; head.append(cell); }
    const body = table.createTBody();
    for (const row of data[group]) {
      const event = row as Row, bucket = row as Group;
      const values = [group === "rows" ? new Date(event.at).toLocaleString() : bucket.name,
        ...(group === "rows" ? [`${event.provider}/${event.model}`] : []), row.input, row.output, row.cacheRead, row.cacheWrite, money(row.cost)];
      const tr = body.insertRow();
      for (const value of values) { const cell = tr.insertCell(); cell.textContent = typeof value === "number" ? value.toLocaleString() : String(value); cell.title = cell.textContent; }
    }
    if (!data[group].length) { const cell = body.insertRow().insertCell(); cell.colSpan = headings.length; cell.className = "usage-empty"; cell.textContent = text("此范围暂无记录", "No records in this range"); }
  };
  const renderAnalysis = () => {
    if (!data) return;
    hideChartTooltip();
    const title = el("usage-analysis-title"), summary = el("usage-analysis-summary");
    const chart = el("usage-chart"), legend = el("usage-legend"), note = el("usage-analysis-note");
    title.textContent = usageView === "trend" ? text("按日趋势", "Daily trend")
      : usageView === "distribution" ? text("模型用量分布", "Usage by model")
      : usageView === "ranking" ? text("模型排行", "Model ranking")
      : text("详细用量记录", "Detailed records");
    summary.textContent = `${data.selected.records.toLocaleString()} ${text("条记录", "records")} · ${data.selected.tokens.toLocaleString()} tokens · ${money(data.selected.cost)}`;
    el("usage-metric-label").textContent = metricLabel(usageMetric);
    for (const button of pane.querySelectorAll<HTMLButtonElement>("[data-usage-view]")) {
      const active = button.dataset.usageView === usageView;
      button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
    }
    for (const button of pane.querySelectorAll<HTMLButtonElement>("[data-usage-metric]")) {
      button.setAttribute("aria-pressed", String(button.dataset.usageMetric === usageMetric));
    }
    chart.replaceChildren(); legend.replaceChildren(); note.textContent = "";
    const empty = () => {
      const message = document.createElement("p"); message.className = "usage-empty-state";
      message.textContent = text("当前筛选范围内没有用量记录", "No usage records match the selected filters");
      chart.append(message);
    };
    if (!data.selected.records) { empty(); return; }
    if (usageView === "trend") {
      if (!data.trend.length) { empty(); return; }
      const seriesById = new Map<string, ModelGroup>();
      for (const trendDay of data.trend) for (const model of trendDay.models) {
        if (!seriesById.has(model.id)) seriesById.set(model.id, model);
      }
      const allSeries = [...seriesById.values()];
      const visible = allSeries.filter(model => !hiddenModels.has(model.id));
      const visibleIds = new Set(visible.map(model => model.id));
      const colorById = new Map(allSeries.map((model, index) => [model.id, chartColors[index % chartColors.length]]));
      for (const model of allSeries) {
        const label = document.createElement("label"); label.className = "usage-legend-item";
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = !hiddenModels.has(model.id);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) hiddenModels.delete(model.id); else hiddenModels.add(model.id);
          renderAnalysis();
        });
        const swatch = document.createElement("span"); swatch.className = "usage-legend-swatch";
        swatch.style.backgroundColor = colorById.get(model.id) || chartColors[0];
        const name = document.createElement("span"); name.textContent = model.provider ? `${model.provider}/${model.model}` : model.model;
        label.append(checkbox, swatch, name); legend.append(label);
      }
      const rows = data.trend.slice(-60);
      const totals = rows.map(row => row.models.reduce((sum, model) =>
        sum + (visibleIds.has(model.id) ? metricValue(model) : 0), 0));
      const max = Math.max(1, ...totals);
      const scale = document.createElement("div"); scale.className = "usage-chart-scale";
      scale.textContent = `${formatMetric(max)} ${metricLabel(usageMetric)}`; chart.append(scale);
      const plot = document.createElement("div"); plot.className = "usage-trend-plot";
      for (const [index, row] of rows.entries()) {
        const item = document.createElement("div"); item.className = "usage-trend-day";
        item.tabIndex = index === 0 ? 0 : -1;
        item.setAttribute("role", "group");
        const stack = document.createElement("div"); stack.className = "usage-trend-stack";
        const dateLabel = new Date(`${row.name}T00:00:00`).toLocaleDateString(options.language() === "en" ? "en" : "zh", { month: "numeric", day: "numeric" });
        item.setAttribute("aria-label", `${row.name}, ${metricLabel(usageMetric)} ${formatMetric(totals[index])}`);
        item.addEventListener("pointerenter", () => showChartTooltip(row, item, allSeries, visibleIds, colorById));
        item.addEventListener("pointerleave", () => {
          if (document.activeElement !== item) hideChartTooltip();
        });
        item.addEventListener("focus", () => showChartTooltip(row, item, allSeries, visibleIds, colorById));
        item.addEventListener("blur", hideChartTooltip);
        item.addEventListener("keydown", (event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const days = [...plot.querySelectorAll<HTMLElement>(".usage-trend-day")];
          const current = days.indexOf(item);
          const next = event.key === "Home" ? 0 : event.key === "End" ? days.length - 1
            : Math.max(0, Math.min(days.length - 1, current + (event.key === "ArrowRight" ? 1 : -1)));
          days.forEach((dayItem, dayIndex) => { dayItem.tabIndex = dayIndex === next ? 0 : -1; });
          days[next]?.focus();
        });
        for (const model of visible) {
          const value = metricValue(row.models.find(item => item.id === model.id) || {
            ...model, records: 0, tokens: 0, knownCost: 0,
          });
          if (!value) continue;
          const segment = document.createElement("span"); segment.className = "usage-trend-segment";
          segment.style.height = `${Math.max(1, value / max * 100)}%`;
          segment.style.backgroundColor = colorById.get(model.id) || chartColors[0];
          // Keep model colors distinct while making each day's total visibly
          // stronger or lighter according to the selected metric.
          const intensity = Math.max(0, Math.min(1, Math.sqrt(totals[index] / max)));
          segment.style.opacity = String(0.28 + intensity * 0.72);
          segment.dataset.intensity = intensity.toFixed(3);
          segment.setAttribute("aria-hidden", "true");
          stack.append(segment);
        }
        const label = document.createElement("small"); label.textContent = index === 0 || index === rows.length - 1 || index % Math.ceil(rows.length / 8) === 0 ? dateLabel : "";
        item.append(stack, label); plot.append(item);
      }
      chart.append(plot);
      if (data.trend.length > rows.length) note.textContent = text("图表显示所选范围内最近 60 天；可聚焦日期柱并用方向键浏览每日模型明细。完整记录仍保留在下方表格与导出中。", "Chart shows the latest 60 days. Focus a day and use the arrow keys to browse its per-model details; full records remain in the table and exports.");
      if (usageMetric === "knownCost" && data.selected.unknownCost) {
        note.textContent += `${note.textContent ? " " : ""}${text(`${data.selected.unknownCost} 条费用未知，费用图仅显示 Pi 已记录的价格。`, `${data.selected.unknownCost} events have unknown cost; the chart includes only Pi-recorded prices.`)}`;
      }
    } else if (usageView === "distribution") {
      const models = data.modelBreakdown.slice(0, 8);
      if (!models.length) { empty(); return; }
      const totalValue = models.reduce((sum, model) => sum + metricValue(model), 0);
      const max = Math.max(1, ...models.map(metricValue));
      const list = document.createElement("ol"); list.className = "usage-distribution";
      for (const [index, model] of models.entries()) {
        const item = document.createElement("li");
        const heading = document.createElement("div"); heading.className = "usage-distribution-heading";
        const name = document.createElement("span"); name.textContent = `${model.provider}/${model.model}`;
        const value = document.createElement("strong"); value.textContent = `${formatMetric(metricValue(model))} · ${totalValue ? (metricValue(model) / totalValue * 100).toFixed(1) : "0.0"}%`;
        const track = document.createElement("span"); track.className = "usage-distribution-track";
        const fill = document.createElement("span"); fill.style.width = `${metricValue(model) / max * 100}%`;
        fill.style.backgroundColor = chartColors[index % chartColors.length]; track.append(fill);
        heading.append(name, value); item.append(heading, track); list.append(item);
      }
      chart.append(list);
      if (data.modelBreakdown.length > models.length || data.modelsTruncated) note.textContent = text("分布图显示用量最高的 8 个模型。", "Distribution shows the top 8 models by usage.");
      if (usageMetric === "knownCost" && data.selected.unknownCost) {
        note.textContent += `${note.textContent ? " " : ""}${text(`${data.selected.unknownCost} 条费用未知，费用图只比较已知费用。`, `${data.selected.unknownCost} events have unknown cost; only known costs are compared.`)}`;
      }
    } else if (usageView === "ranking") {
      const models = [...data.modelBreakdown].sort((a, b) => metricValue(b) - metricValue(a));
      const table = document.createElement("table"); table.className = "usage-table usage-ranking";
      const head = table.createTHead().insertRow();
      for (const title of [text("排名", "Rank"), text("供应商 / 模型", "Provider / model"), text("记录", "Records"), text("Token", "Tokens"), text("已知 USD", "Known USD"), text("费用未知", "Unknown cost")]) {
        const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = title; head.append(cell);
      }
      const body = table.createTBody();
      for (const [index, model] of models.entries()) {
        const row = body.insertRow();
        for (const value of [index + 1, `${model.provider}/${model.model}`, model.records.toLocaleString(),
          model.tokens.toLocaleString(), money(model.knownCost), model.unknownCost.toLocaleString()]) {
          const cell = row.insertCell(); cell.textContent = String(value); cell.title = cell.textContent;
        }
      }
      chart.append(table);
      if (data.modelsTruncated) note.textContent = text("排行最多显示 100 个模型；导出文件仍包含完整数据。", "Ranking is limited to 100 models; exports retain the full data.");
    } else {
      const records = data.rows.slice(0, 250);
      const table = document.createElement("table"); table.className = "usage-table usage-records";
      const head = table.createTHead().insertRow();
      for (const title of [text("时间", "Time"), text("供应商 / 模型", "Provider / model"), text("输入", "Input"),
        text("输出", "Output"), text("缓存读", "Cache read"), text("缓存写", "Cache write"), "USD"]) {
        const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = title; head.append(cell);
      }
      const body = table.createTBody();
      for (const row of records) {
        const values = [new Date(row.at).toLocaleString(), `${row.provider}/${row.model}`, row.input, row.output,
          row.cacheRead, row.cacheWrite, money(row.cost)];
        const line = body.insertRow();
        for (const value of values) {
          const cell = line.insertCell(); cell.textContent = typeof value === "number" ? value.toLocaleString() : String(value);
          cell.title = cell.textContent;
        }
      }
      if (!records.length) {
        const cell = body.insertRow().insertCell(); cell.colSpan = 7; cell.className = "usage-empty";
        cell.textContent = text("此范围暂无记录", "No records in this range");
      }
      chart.append(table);
      note.textContent = data.rows.length > records.length
        ? text(`记录视图显示最近 ${records.length} 条；下方分组表格和导出保留完整结果。`, `Records view shows the latest ${records.length}; the grouped table and exports retain the full selection.`)
        : text("保留逐笔日志，可与趋势、分布和排行视图自由切换。", "The original event log remains available alongside trend, mix, and ranking views.");
    }
  };
  const render = () => {
    if (!data) return;
    const selected = filter();
    fillSelect("usage-provider", data.providers, selected.provider); fillSelect("usage-model", data.models, selected.model);
    el("usage-totals").replaceChildren();
    for (const [name, value] of [[text("近 24 小时", "Last 24 hours"), data.last24Hours], [text("今日", "Today"), data.today],
      [text("本月", "This month"), data.month], [text("累计", "All time"), data.all]] as const) {
      const metric = document.createElement("div"); metric.className = "usage-metric";
      const title = document.createElement("span"); title.textContent = name;
      const tokens = document.createElement("strong"); tokens.textContent = value.tokens.toLocaleString();
      const cost = document.createElement("small"); cost.textContent = `${money(value.cost)} · ${value.records} ${text("笔", "events")}`;
      metric.append(tokens, title, cost); el("usage-totals").append(metric);
    }
    el("usage-cache").textContent = `${data.source ? `${data.source} · ` : ""}${text("今日缓存命中率", "Today's cache hit rate")} ${data.today.cacheHit === null ? "—" : `${(data.today.cacheHit * 100).toFixed(1)}%`}`;
    el("usage-selected").textContent = `${text("筛选结果", "Selected")}: ${data.selected.tokens.toLocaleString()} tokens · ${money(data.selected.cost)}${data.selected.unknownCost ? ` · ${data.selected.unknownCost} ${text("笔费用未知", "events with unknown cost")}` : ""}${data.rowsTruncated || data.groupsTruncated ? ` · ${text("表格仅显示最近记录；导出按完整筛选结果", "Table is bounded; exports use the full filter")}` : ""}`;
    renderAnalysis();
    el("usage-month").textContent = month.toLocaleDateString(options.language() === "en" ? "en" : "zh", { year: "numeric", month: "long" });
    const calendar = el("usage-calendar"); calendar.replaceChildren();
    for (const title of text("一,二,三,四,五,六,日", "M,T,W,T,F,S,S").split(",")) {
      const item = document.createElement("span"); item.className = "usage-weekday"; item.textContent = title; calendar.append(item);
    }
    for (let i = 0; i < (month.getDay() + 6) % 7; i++) calendar.append(document.createElement("span"));
    const days = new Map(data.days.map(row => [row.name, row]));
    const max = Math.max(1, ...data.days.map(row => row.tokens));
    for (let number = 1; number <= new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate(); number++) {
      const date = day(new Date(month.getFullYear(), month.getMonth(), number)), value = days.get(date);
      const button = document.createElement("button"); button.type = "button"; button.textContent = String(number);
      button.title = `${date} · ${(value?.tokens || 0).toLocaleString()} tokens · ${money(value ? value.cost : 0)}`;
      button.setAttribute("aria-label", button.title); button.setAttribute("aria-pressed", String(selected.from === date && selected.to === date));
      if (value?.tokens) button.style.setProperty("--usage-day", `rgba(32, 165, 117, ${0.15 + value.tokens / max * 0.55})`);
      button.addEventListener("click", () => { el<HTMLInputElement>("usage-from").value = date; el<HTMLInputElement>("usage-to").value = date; void refresh(); });
      calendar.append(button);
    }
    renderTable();
  };
  const refresh = async () => {
    if (disposed) return;
    const version = ++generation, chosen = filter();
    if (chosen.from && chosen.to && chosen.from > chosen.to) {
      loading = false; pane.setAttribute("aria-busy", "false");
      el("usage-message").textContent = text("开始日期不能晚于结束日期", "From must precede To"); return;
    }
    loading = true; pane.setAttribute("aria-busy", "true");
    try {
      const value = await request<Summary>({ action: "summary", filter: chosen });
      if (disposed || version !== generation) return;
      data = value; render(); el("usage-message").textContent = value.warnings?.length
        ? text(`${value.warnings.length} 条日志无法读取，统计不完整；原文件已保留，可导出 JSON 查看。`, `${value.warnings.length} unreadable events; totals are incomplete. Originals are preserved; export JSON for details.`) : "";
    } catch (error) { if (!disposed && version === generation) el("usage-message").textContent = formatUserError(error); }
    finally { if (!disposed && version === generation) { loading = false; pane.setAttribute("aria-busy", "false"); } }
  };
  const exportFile = async (format: string) => {
    if (disposed || exporting) return;
    exporting = true;
    try {
      const result = await request<{ content: string }>({ action: "export", format, filter: filter() });
      if (disposed) return;
      const path = await options.invoke<string>("export_usage_log", { text: result.content, format });
      if (!disposed) {
        const filename = typeof path === "string" ? path.split(/[\\/]/).pop() || path : "";
        el("usage-message").textContent = `${text("已导出", "Exported")}: ${filename || text("下载目录", "Downloads folder")}`;
      }
    } catch (error) { if (!disposed) el("usage-message").textContent = formatUserError(error); }
    finally { exporting = false; }
  };
  build();
  return { refresh, refreshLanguage() { if (loading || exporting) return; const chosen = filter(); build();
    el<HTMLInputElement>("usage-from").value = chosen.from; el<HTMLInputElement>("usage-to").value = chosen.to;
    if (data) { fillSelect("usage-provider", data.providers, chosen.provider); fillSelect("usage-model", data.models, chosen.model); render(); }
  }, dispose() { disposed = true; generation++; hideChartTooltip(); } };
}
