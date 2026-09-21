/*
 * 界面编排层（非业务模块）：只负责取数、渲染、转发用户操作。
 * 列表 / 风险 / 状态全部来自三个业务模块的计算结果，
 * 页面刷新后从持久化模块重新读取，展示保持一致。
 */
(function () {
  "use strict";

  var store = ZxStore.create();
  var api = ZxApi.create({ store: store, review: ZxReview, status: ZxStatus });

  // 本地编辑中的草稿（保存草稿/锁定版本时才进入持久化模块）
  var ed = { cols: 18, rows: 14, cells: [], palette: [] };
  var activeColor = 1;
  var block = "dot";
  var dragging = false;
  var requestId = newRequestId();

  var $ = function (sel) { return document.querySelector(sel); };
  var colors = function () { return ed.palette; };

  function newRequestId() {
    return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmtTime(t) { return t ? new Date(t).toLocaleString("zh-CN", { hour12: false }) : "—"; }
  function toast(message, kind) {
    var box = $("#toast");
    var el = document.createElement("div");
    el.className = "toast " + (kind || "info");
    el.textContent = message;
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, 4200);
  }

  // ---------- 草稿编辑 ----------
  function loadDraftIntoEditor() {
    var state = api.getState().body;
    if (!state.pattern) return;
    var d = state.pattern.draft;
    ed.cols = d.cols; ed.rows = d.rows;
    ed.cells = d.cells.slice(); ed.palette = d.palette.slice();
    $("#cols").value = ed.cols; $("#rows").value = ed.rows;
  }

  function idx(x, y) {
    return (x < 0 || x >= ed.cols || y < 0 || y >= ed.rows) ? null : y * ed.cols + x;
  }
  function paintTargets(i) {
    var x = i % ed.cols, y = Math.floor(i / ed.cols);
    if (block === "cross") return [i, idx(x - 1, y), idx(x + 1, y), idx(x, y - 1), idx(x, y + 1)].filter(function (v) { return v !== null; });
    if (block === "diamond") return [idx(x, y - 1), idx(x - 1, y), i, idx(x + 1, y), idx(x, y + 1)].filter(function (v) { return v !== null; });
    return [i];
  }
  function paint(i) {
    paintTargets(i).forEach(function (t) { ed.cells[t] = activeColor; });
    renderGrid();
    renderStats();
    renderDraftRisk();
  }

  async function saveDraft() {
    var r = await api.saveDraft({ cells: ed.cells, palette: ed.palette });
    if (r.code >= 400) toast(r.body.error.message, "err");
    else toast("草稿已保存（尚未锁定，不影响织造单）", "ok");
  }

  async function applySize() {
    var cols = Number($("#cols").value), rows = Number($("#rows").value);
    var r = await api.saveDraft({ cols: cols, rows: rows });
    if (r.code >= 400) { toast(r.body.error.message, "err"); return; }
    loadDraftIntoEditor();
    renderAll();
    toast("网格行列数已调整，锁定为新版本后旧织造单将冻结留档", "info");
  }

  function clearDraft() {
    ed.cells = new Array(ed.cols * ed.rows).fill(0);
    renderGrid(); renderStats(); renderDraftRisk();
  }

  async function lockVersion() {
    await saveDraftSilent();
    var r = await api.lockVersion();
    if (r.code >= 400) { toast(r.body.error.message, r.code === 409 ? "err" : "info"); return; }
    toast("已锁定新版本 v" + r.body.version.no + "（网格+色线不可再变）", "ok");
    if (r.body.frozenOrders.length) toast("旧单 " + r.body.frozenOrders.join("、") + " 已冻结留档，须按新版本补做断线复核", "err");
    requestId = newRequestId();
    renderAll();
  }

  async function saveDraftSilent() {
    await api.saveDraft({ cells: ed.cells, palette: ed.palette });
  }

  // ---------- 渲染 ----------
  function renderPalette() {
    $("#palette").innerHTML = ed.palette.map(function (c, i) {
      return '<button class="swatch ' + (i === activeColor ? "active" : "") + '" data-color="' + i +
        '" style="background:' + c + '" title="色线' + i + '"></button>';
    }).join("");
    $("#palette").querySelectorAll("[data-color]").forEach(function (el) {
      el.onclick = function () { activeColor = Number(el.dataset.color); $("#colorPick").value = ed.palette[activeColor]; renderPalette(); };
    });
    $("#colorPick").value = ed.palette[activeColor] || "#000000";
  }

  function renderGrid() {
    var grid = $("#grid");
    grid.style.gridTemplateColumns = "repeat(" + ed.cols + ", 1fr)";
    grid.innerHTML = ed.cells.map(function (v, i) {
      return '<div class="cell" data-i="' + i + '" style="background:' + ed.palette[v] + '"></div>';
    }).join("");
    grid.querySelectorAll(".cell").forEach(function (el) {
      el.onpointerdown = function () { dragging = true; paint(Number(el.dataset.i)); };
      el.onpointerenter = function () { if (dragging) paint(Number(el.dataset.i)); };
    });
    window.onpointerup = function () { dragging = false; };
  }

  function renderStats() {
    var counts = ed.palette.map(function (_, i) {
      return ed.cells.filter(function (v) { return v === i; }).length;
    });
    $("#stats").innerHTML = counts.map(function (n, i) {
      return '<div class="stat"><span><span class="dot" style="background:' + ed.palette[i] + '"></span> 色线' + i + '</span><b>' + n + "</b></div>";
    }).join("");
  }

  function renderDraftRisk() {
    var r = api.draftRisk();
    if (!r.body) return;
    var sum = r.body;
    var html = '<p class="hint">草稿提示（锁定版本后须在右侧重新逐行复核）</p>';
    if (sum.highRows.length) html += '<p class="warning">高风险：第' + sum.highRows.join("、") + "行换色过密。</p>";
    if (sum.mediumRows.length) html += '<p class="medium-warn">中风险：第' + sum.mediumRows.join("、") + "行，建议关注。</p>";
    if (!sum.highRows.length && !sum.mediumRows.length) html += "<p>暂无明显断线风险。</p>";
    $("#draftRisk").innerHTML = html;
  }

  function miniSnapshot(snap, cls) {
    var cap = Math.min(snap.cells.length, 48);
    var cellsHtml = "";
    for (var i = 0; i < cap; i++) cellsHtml += '<span style="background:' + snap.palette[snap.cells[i]] + '"></span>';
    return '<div class="' + (cls || "mini-ver") + '" style="grid-template-columns:repeat(' + Math.min(snap.cols, 12) + ',1fr)">' + cellsHtml + "</div>";
  }

  function renderVersions() {
    var state = api.getState().body;
    var p = state.pattern;
    if (!p || !p.versions.length) {
      $("#versions").innerHTML = "<p class='hint'>尚无锁定版本。草稿确认后点击「锁定为新版本」。</p>";
      return;
    }
    $("#versions").innerHTML = p.versions.slice().reverse().map(function (v) {
      var current = v.id === p.currentVersionId;
      return '<div class="ver-card ' + (current ? "current" : "archived") + '">' +
        "<div><b>v" + v.no + (current ? "（当前）" : "（留档）") + "</b> <span class='hint'>" + v.snapshot.cols + "×" + v.snapshot.rows + " · " + v.snapshot.palette.length + "色 · " + fmtTime(v.lockedAt) + "</span></div>" +
        miniSnapshot(v.snapshot) +
        '<p class="hint">网格与色线已锁定，不可修改</p></div>';
    }).join("");
  }

  function renderReviewPanel() {
    var state = api.getState().body;
    var box = $("#reviewPanel");
    if (!state.pattern || !state.pattern.currentVersionId) {
      box.innerHTML = "<p class='hint'>锁定版本后才能做断线复核。</p>";
      return;
    }
    var cur = state.pattern.versions.filter(function (v) { return v.id === state.pattern.currentVersionId; })[0];
    var sum = api.riskOfVersion(cur.id).body;
    var html = '<p>复核对象：<b>v' + cur.no + "</b>（" + cur.snapshot.cols + "×" + cur.snapshot.rows + "）</p>";
    if (sum.cleared) {
      html += '<p class="ok-flag">✓ 高风险行已全部复核，可正常创建/排产织造单。</p>';
    } else {
      html += '<p class="warning">尚有 ' + sum.pendingRows.length + " 行高风险未复核，新建织造单只能转入「待复核」。</p>";
    }
    html += '<div class="risk-list">' + sum.rows.filter(function (r) { return r.level !== "ok"; }).map(function (r) {
      var reviewed = sum.highRows.indexOf(r.row) !== -1 && sum.pendingRows.indexOf(r.row) === -1;
      var badge = r.level === "high"
        ? (reviewed ? '<span class="tag ok">已复核</span>' : '<span class="tag danger">高风险·待复核</span>')
        : '<span class="tag warn">中风险·提示</span>';
      var btn = (r.level === "high" && !reviewed)
        ? ' <button data-review="' + r.row + '">复核本行</button>' : "";
      return '<div class="risk-row"><span>第' + r.row + "行 · 换色" + r.switches + "次</span> " + badge + btn + "</div>";
    }).join("") + "</div>";
    if (!sum.rows.some(function (r) { return r.level !== "ok"; })) html += '<p class="hint">本版本无中高风险行。</p>';
    box.innerHTML = html;
    box.querySelectorAll("[data-review]").forEach(function (b) {
      b.onclick = async function () {
        var by = $("#workerName").value.trim() || "织工";
        var rr = await api.reviewRow(cur.id, Number(b.dataset.review), by);
        if (rr.code >= 400) toast(rr.body.error.message, "err");
        else toast("第" + b.dataset.review + "行断线复核已记录", "ok");
        renderViews();
      };
    });
  }

  function statusBadge(label, status) {
    return '<span class="badge ' + status + '">' + label + "</span>";
  }

  function renderOrders() {
    var list = api.listOrders().body;
    renderLoomOverview(list);
    if (!list.length) {
      $("#orders").innerHTML = "<p class='hint'>还没有织造单。</p>";
      return;
    }
    $("#orders").innerHTML = list.map(function (o) {
      var riskLine = o.risk && o.risk.highRows.length
        ? '<div class="hint">高风险行：第' + o.risk.highRows.join("、") + "行" +
          (o.risk.pendingRows.length ? "（待复核：第" + o.risk.pendingRows.join("、") + "行）" : "（均已复核）") + "</div>"
        : '<div class="hint">无高风险行</div>';
      var actions = "";
      if (o.can.start) actions += ' <button data-act="start" data-id="' + o.id + '">开工</button>';
      if (o.can.finish) actions += ' <button class="secondary" data-act="finish" data-id="' + o.id + '">完工</button>';
      var frozen = o.status === "frozen"
        ? '<div class="frozen-note">❄ ' + esc(o.frozenReason || "旧单冻结留档") + "<br>冻结时间：" + fmtTime(o.frozenAt) + "</div>" : "";
      return '<div class="order-card ' + o.status + '">' +
        '<div class="order-head"><b>' + o.id + "</b> " + statusBadge(o.statusLabel, o.status) +
        ' <span class="hint">织机' + esc(o.loom) + " · v" + o.versionNo + " · " + esc(o.worker) + "</span></div>" +
        riskLine +
        '<div class="hint">创建 ' + fmtTime(o.createdAt) +
        (o.startedAt ? " · 开工 " + fmtTime(o.startedAt) : "") +
        (o.finishedAt ? " · 完工 " + fmtTime(o.finishedAt) : "") + "</div>" +
        frozen +
        (actions ? '<div class="order-actions">' + actions + "</div>" : "") +
        miniSnapshot(o.snapshot, "mini-order") +
        "</div>";
    }).join("");

    $("#orders").querySelectorAll("[data-act]").forEach(function (b) {
      b.onclick = async function () {
        var id = b.dataset.id, act = b.dataset.act;
        var rr = act === "start" ? await api.startOrder(id)
          : act === "finish" ? await api.finishOrder(id)
          : await api.confirmReview(id);
        if (rr.code >= 400) toast(rr.code + " " + rr.body.error.message, "err");
        else toast("织造单 " + id + " 已更新为「" + ZxStatus.LABELS[rr.body.status] + "」", "ok");
        renderViews();
      };
    });
  }

  function renderLoomOverview(list) {
    var looms = {};
    list.forEach(function (o) {
      if (!(o.loom in looms)) looms[o.loom] = null;
      if (o.occupiesLoom) looms[o.loom] = o;
    });
    var keys = Object.keys(looms).sort();
    $("#looms").innerHTML = keys.length
      ? keys.map(function (k) {
        return looms[k]
          ? '<div class="loom busy">织机' + esc(k) + "：占用中 · " + looms[k].id + " " + statusBadge(looms[k].statusLabel, looms[k].status) + "</div>"
          : '<div class="loom free">织机' + esc(k) + "：空闲（旧单已冻结/完工）</div>";
      }).join("")
      : "<p class='hint'>暂无织机记录。</p>";
  }

  // 渲染来自持久层的视图（版本/复核/订单/织机）；不触碰编辑器草稿，
  // 避免用户未保存的绘制被刷新类操作冲掉。
  function renderViews() {
    renderVersions();
    renderReviewPanel();
    renderOrders();
    $("#reqId").value = requestId;
  }

  function renderAll() {
    loadDraftIntoEditor();
    renderPalette();
    renderGrid();
    renderStats();
    renderDraftRisk();
    renderViews();
  }

  // ---------- 交互绑定 ----------
  function bind() {
    document.querySelectorAll("[data-block]").forEach(function (btn) {
      btn.onclick = function () { block = btn.dataset.block; };
    });
    $("#applySizeBtn").onclick = applySize;
    $("#clearBtn").onclick = clearDraft;
    $("#saveDraftBtn").onclick = saveDraft;
    $("#lockBtn").onclick = lockVersion;
    $("#newReqBtn").onclick = function () { requestId = newRequestId(); $("#reqId").value = requestId; };
    $("#colorPick").onchange = function () {
      ed.palette[activeColor] = this.value;
      renderPalette(); renderGrid(); renderStats();
      toast("色线已在草稿中修改，锁定新版本后生效", "info");
    };

    $("#submitOrder").onclick = async function () {
      var loom = $("#loomInput").value.trim();
      var worker = $("#workerName").value.trim() || "织工";
      if (!loom) { toast("必须填写织机编号", "err"); return; }
      var results = await Promise.all([
        // 故意同时再发一个相同请求，演示并发/重复提交被 409 拦截且不落库
        api.createOrder({ loom: loom, worker: worker, requestId: requestId }),
        api.createOrder({ loom: loom, worker: worker, requestId: requestId })
      ]);
      results.forEach(function (r, i) {
        if (r.code === 201) {
          toast((i === 0 ? "主请求" : "并发请求") + " 201 已创建 " + r.body.id + "（" + ZxStatus.LABELS[r.body.status] + "）", "ok");
          requestId = newRequestId();
        } else {
          toast((i === 0 ? "主请求" : "并发请求") + " " + r.code + " " + r.body.error.message, "err");
        }
      });
      renderViews();
    };

    $("#exportBtn").onclick = function () {
      var data = api.getState().body;
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "weaving-schedule.json";
      a.click();
      URL.revokeObjectURL(a.href);
    };
  }

  async function boot() {
    if (!api.getState().body.pattern) await api.initPattern();
    loadDraftIntoEditor();
    bind();
    renderAll();
  }

  boot();
})();
