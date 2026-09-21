/*
 * UI 编排层（app.js）
 * 只负责界面与事件，所有业务口径一律调用三个模块：
 *   BreakReview（断线复核） / OrderStatus（状态计算） / OfflineStore（持久化）
 * 列表徽标、风险提示、复核面板均从同一份模块结果渲染，因此刷新后完全一致。
 */
(function () {
  "use strict";

  const DEFAULT_PALETTE = [
    { hex: "#f7e7c4", name: "米白" }, { hex: "#a6322d", name: "丹红" },
    { hex: "#1f5f78", name: "靛青" }, { hex: "#d6a437", name: "藤黄" },
    { hex: "#355b38", name: "松绿" }, { hex: "#713d7b", name: "紫绒" },
    { hex: "#1e1b18", name: "玄黑" }, { hex: "#e98c52", name: "杏橙" }
  ];
  const LOOMS = [
    { id: "L01", name: "云锦一号机" }, { id: "L02", name: "云锦二号机" },
    { id: "L03", name: "云锦三号机" }, { id: "L04", name: "云锦四号机" }
  ];

  const $ = function (sel) { return document.querySelector(sel); };
  const esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  // ---- 界面状态（db 每次操作后从持久化模块重新读取，杜绝两套口径）----
  let db = OfflineStore.getState();
  let draft = OfflineStore.loadDraft() || newDraft(18, 14);
  let active = 1, block = "dot", dragging = false;
  let undoStack = [], redoStack = [];
  let selectedVersionId = db.headVersionId;
  let pendingAcks = new Set();
  let lastRequest = null; // 供「重复提交 409」演练复用原幂等键
  let busy = false;

  const logs = [];

  function newDraft(cols, rows) {
    return { cols: cols, rows: rows, cells: Array(cols * rows).fill(0), palette: DEFAULT_PALETTE.map(function (p) { return { hex: p.hex, name: p.name }; }) };
  }

  function selectedVersion() {
    return db.versions.filter(function (v) { return v.id === selectedVersionId; })[0] || null;
  }

  function reviewOf(versionId) { return db.reviews[versionId] || null; }

  // ---- 日志 ----
  function pushLog(level, text) {
    logs.push({ t: new Date(), level: level, text: text });
    if (logs.length > 50) logs.shift();
    renderLog();
  }
  function logReq(status, text) { pushLog(status < 400 ? "OK" : "ERR", "[" + status + "] " + text); }
  function logSys(text) { pushLog("SYS", text); }

  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + " " +
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
  }

  // ---- 统一的异步动作包装：忙时拦截，并以 HTTP 语义记日志 ----
  async function run(label, fn) {
    if (busy) { logReq(409, label + "：上一请求尚未结束，拒绝并发操作（本地拦截）"); return null; }
    busy = true; document.body.classList.add("busy");
    try {
      const r = await fn();
      db = OfflineStore.getState();
      renderAll();
      return r;
    } catch (e) {
      db = OfflineStore.getState();
      renderAll();
      logReq(e.status || 500, label + "：" + e.message);
      return null;
    } finally {
      busy = false; document.body.classList.remove("busy");
    }
  }

  // ======================================================================
  // 草稿绘制
  // ======================================================================

  // 任何会改变「网格 / 色线」的草稿修改，都先检查在织旧单：立即冻结并留档
  async function mutateDraft(reason) {
    OfflineStore.saveDraft(draft);
    const frozen = await OfflineStore.freezeRunningOrders(reason);
    db = OfflineStore.getState();
    if (frozen.length) {
      frozen.forEach(function (o) {
        logReq(409, o.id + "（" + o.loomId + "）开工后纹样发生修改，旧单已立即冻结留档，待新版本复核后重排");
      });
    }
    renderAll();
  }

  function snapshotUndo() {
    undoStack.push(JSON.parse(JSON.stringify({ cells: draft.cells, cols: draft.cols, rows: draft.rows })));
    redoStack = [];
    if (undoStack.length > 50) undoStack.shift();
  }

  function paint(i) {
    snapshotUndo();
    patternTargets(i).forEach(function (t) {
      if (t >= 0 && t < draft.cells.length) draft.cells[t] = active;
    });
    mutateDraft("绘制网格修改");
  }

  function idx(x, y) {
    return x < 0 || x >= draft.cols || y < 0 || y >= draft.rows ? null : y * draft.cols + x;
  }
  function patternTargets(i) {
    const x = i % draft.cols, y = Math.floor(i / draft.cols);
    if (block === "cross") return [i, idx(x - 1, y), idx(x + 1, y), idx(x, y - 1), idx(x, y + 1)].filter(function (v) { return v !== null; });
    if (block === "diamond") return [idx(x, y - 1), idx(x - 1, y), i, idx(x + 1, y), idx(x, y + 1)].filter(function (v) { return v !== null; });
    return [i];
  }

  function miniPreviewHTML(snap) {
    return Array.from({ length: 36 }, function (_, i) {
      const cellIndex = (i % 6) + Math.floor(i / 6) * snap.cols;
      const ci = snap.cells[cellIndex] || 0;
      const hex = (snap.palette[ci] || { hex: "#f8ead2" }).hex;
      return '<div class="mini" style="background:' + hex + '"></div>';
    }).join("");
  }

  // ======================================================================
  // 渲染
  // ======================================================================

  function renderAll() {
    renderPalette();
    renderGrid();
    renderStats();
    renderVersions();
    renderReviewPanel();
    renderOrderForm();
    renderOrders();
  }

  function renderPalette() {
    $("#palette").innerHTML = draft.palette.map(function (p, i) {
      return '<button type="button" class="swatch ' + (i === active ? "active" : "") + '" data-color="' + i +
        '" style="background:' + p.hex + '" title="' + esc(p.name) + '"></button>';
    }).join("");
    $("#palette").querySelectorAll("[data-color]").forEach(function (el) {
      el.onclick = function () { active = Number(el.dataset.color); renderPalette(); syncColorInputs(); };
    });
    syncColorInputs();
  }

  function syncColorInputs() {
    $("#activeHex").value = draft.palette[active].hex;
    $("#activeName").value = draft.palette[active].name;
  }

  function renderGrid() {
    $("#cols").value = draft.cols;
    $("#rows").value = draft.rows;
    const g = $("#grid");
    g.style.gridTemplateColumns = "repeat(" + draft.cols + ", 1fr)";
    g.innerHTML = draft.cells.map(function (v, i) {
      return '<div class="cell" data-i="' + i + '" style="background:' + draft.palette[v].hex + '"></div>';
    }).join("");
    g.querySelectorAll(".cell").forEach(function (el) {
      el.onpointerdown = function () { dragging = true; paint(Number(el.dataset.i)); };
      el.onpointerenter = function () { if (dragging) paint(Number(el.dataset.i)); };
    });
    window.onpointerup = function () { dragging = false; };
  }

  function renderStats() {
    const counts = draft.palette.map(function (_, i) {
      return draft.cells.filter(function (v) { return v === i; }).length;
    });
    $("#stats").innerHTML = draft.palette.map(function (p, i) {
      return '<div class="stat"><span><span style="display:inline-block;width:14px;height:14px;background:' + p.hex +
        ';border:1px solid #ccc"></span> ' + esc(p.name) + "（" + p.hex + "）</span><b>" + counts[i] + "</b></div>";
    }).join("");
    $("#preview").innerHTML = miniPreviewHTML(draft);
  }

  function riskBadge(risk) {
    if (!risk.highRisk) return '<span class="badge b-norisk">无高风险行</span>';
    return '<span class="badge b-risk">高风险 ' + risk.riskRows.length + ' 行：' + risk.riskRows.join("/") + "</span>";
  }

  function reviewBadge(version) {
    const rv = reviewOf(version.id);
    if (BreakReview.isComplete(version, rv)) return '<span class="badge b-review-done">复核已完成</span>';
    if (rv && rv.key !== BreakReview.versionKey(version)) return '<span class="badge b-review-todo">复核已失效</span>';
    return '<span class="badge b-review-todo">未复核</span>';
  }

  function renderVersions() {
    const box = $("#versions");
    if (!db.versions.length) {
      box.innerHTML = '<p class="muted">还没有锁定版本。绘制草稿后点击「锁定为新版本」，系统会按当前网格与色线生成不可变快照。</p>';
      return;
    }
    box.innerHTML = db.versions.slice().reverse().map(function (v) {
      const risk = BreakReview.computeRisk(v);
      const head = v.id === db.headVersionId ? ' <span class="muted">（当前生产版本）</span>' : "";
      return '<div class="vitem ' + (v.id === selectedVersionId ? "sel" : "") + '">' +
        '<div class="vrow"><label style="margin:0"><input type="radio" name="vs" value="' + v.id + '" ' +
        (v.id === selectedVersionId ? "checked" : "") + "> <b>" + v.id + "</b></label>" + head + "</div>" +
        '<div class="vmeta">' + v.cols + " 列 × " + v.rows + ' 行 · 基于 ' + esc(v.basedOn || "—") + " · " + fmtTime(v.createdAt) + "</div>" +
        '<div class="vmeta">说明：' + esc(v.change) + "<br>指纹：" + v.key + "</div>" +
        '<div>' + riskBadge(risk) + reviewBadge(v) + "</div></div>";
    }).join("");
    box.querySelectorAll("input[name=vs]").forEach(function (r) {
      r.onchange = function () {
        selectedVersionId = r.value;
        const v = selectedVersion();
        const rv = v && reviewOf(v.id);
        pendingAcks = new Set(rv ? rv.acknowledgedRows : []);
        renderAll();
      };
    });
  }

  function renderReviewPanel() {
    const box = $("#review");
    const v = selectedVersion();
    if (!v) {
      box.innerHTML = '<div class="gate no">请先锁定一个纹样版本，才能进行断线复核。</div>';
      return;
    }
    const risk = BreakReview.computeRisk(v);
    const rv = reviewOf(v.id);
    const complete = BreakReview.isComplete(v, rv);
    let html = '<div class="vmeta">版本 <b>' + v.id + "</b> · 指纹 " + v.key + "</div>" +
      "<div>" + riskBadge(risk) + reviewBadge(v) + "</div>";

    if (complete) {
      html += '<div class="gate yes">断线复核已完成：' + esc(rv.reviewer) + " · " + fmtTime(rv.completedAt) +
        '。可以凭此版本创建织造单。</div>';
    } else {
      if (risk.highRisk) {
        html += '<p class="warning">以下行换色过密（超过 ' + Math.round(BreakReview.THRESHOLD * 100) +
          '% 列），存在断线风险，必须逐行签认，建单后只能转「待复核」：</p>';
        html += risk.rows.filter(function (r) { return risk.riskRows.indexOf(r.row) !== -1; }).map(function (r) {
          const ck = pendingAcks.has(r.row) ? "checked" : "";
          return '<label class="ackline"><input type="checkbox" data-ack="' + r.row + '" ' + ck +
            "> 第 <b>" + r.row + "</b> 行换色 " + r.switches + " 次 — 已核对并接受上机风险</label>";
        }).join("");
        const allAck = BreakReview.computeRisk(v).riskRows.every(function (r) { return pendingAcks.has(r); });
        html += '<button id="saveReviewBtn" style="width:100%;margin-top:8px;" ' + (allAck ? "" : "disabled") +
          ">保存断线复核（逐条签认 " + pendingAcks.size + "/" + risk.riskRows.length + "）</button>";
      } else {
        html += '<div class="gate yes">该版本无高风险行，仍需当班复核员确认留痕后方可建单。</div>';
        html += '<button id="saveReviewBtn" style="width:100%;margin-top:8px;">确认无断线风险，完成复核</button>';
      }
    }
    box.innerHTML = html;

    const saveBtn = $("#saveReviewBtn");
    if (saveBtn) {
      saveBtn.onclick = function () {
        const acks = risk.highRisk ? risk.riskRows.filter(function (r) { return pendingAcks.has(r); }) : [];
        if (risk.highRisk && acks.length !== risk.riskRows.length) return;
        run("保存断线复核 " + v.id, function () {
          return OfflineStore.saveReview({
            versionId: v.id, key: BreakReview.versionKey(v),
            acknowledgedRows: acks, completedAt: new Date().toISOString()
          }).then(function () { logReq(200, "断线复核已落库：" + v.id + (risk.highRisk ? "，高风险行 " + acks.join("/") + " 全部签认" : "（无高风险行）")); });
        });
      };
    }
    box.querySelectorAll("[data-ack]").forEach(function (cb) {
      cb.onchange = function () {
        const row = Number(cb.dataset.ack);
        if (cb.checked) pendingAcks.add(row); else pendingAcks.delete(row);
        renderReviewPanel();
      };
    });
  }

  function loomOccupant(loomId) {
    return db.orders.filter(function (o) { return o.loomId === loomId && OrderStatus.occupiesLoom(o.status); })[0] || null;
  }

  function renderOrderForm() {
    const box = $("#orderForm");
    const v = selectedVersion();
    let html = '<label>织造机台</label><select id="loomSel">';
    html += LOOMS.map(function (l) {
      const occ = loomOccupant(l.id);
      return '<option value="' + l.id + '" ' + (occ ? "" : "") + ">" + l.id + " " + l.name +
        (occ ? "（被 " + occ.id + " 占用）" : "（空闲）") + "</option>";
    }).join("");
    html += "</select>";

    if (!v) {
      html += '<div class="gate no">尚未选择纹样版本，无法建单。</div>';
    } else {
      const complete = BreakReview.isComplete(v, reviewOf(v.id));
      const risk = BreakReview.computeRisk(v);
      html += '<div class="vmeta">使用版本：<b>' + v.id + "</b> " + esc(v.change) + "</div>";
      if (!complete) {
        html += '<div class="gate no">建单闸门未通过：断线复核尚未完成' +
          (risk.highRisk ? "（有 " + risk.riskRows.length + " 条高风险行未逐条签认）" : "（未留痕确认）") + "。</div>";
      } else {
        html += '<div class="gate yes">复核闸门已通过。' +
          (risk.highRisk ? "注意：该版本含高风险行，建单后状态只能为「待复核」，需在单上处置后放行。" : "建单后直接进入「待开工」。") + "</div>";
      }
      html += '<button id="createBtn" style="width:100%;margin-top:8px;" ' + (complete ? "" : "disabled") + ">创建织造单（落库）</button>";
    }
    box.innerHTML = html;

    const btn = $("#createBtn");
    if (btn) {
      btn.onclick = function () {
        const loomId = $("#loomSel").value;
        const idemKey = "req-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        lastRequest = { versionId: v.id, loomId: loomId, idemKey: idemKey };
        run("创建织造单", function () {
          return OfflineStore.createOrder({ versionId: v.id, loomId: loomId, idemKey: idemKey }).then(function (o) {
            logReq(201, "织造单 " + o.id + " 已落库：" + o.loomId + " + " + o.versionId + "，初始状态「" +
              OrderStatus.LABELS[o.status] + "」" + (o.riskRows.length ? "，高风险行 " + o.riskRows.join("/") : ""));
          });
        });
      };
    }
  }

  function renderOrders() {
    const box = $("#orders");
    if (!db.orders.length) {
      box.innerHTML = '<p class="muted">暂无织造单。</p>';
      return;
    }
    box.innerHTML = db.orders.slice().reverse().map(function (o) {
      const cleared = BreakReview.isComplete(
        db.versions.filter(function (v) { return v.id === o.versionId; })[0] || { id: o.versionId },
        reviewOf(o.versionId)
      );
      const acts = OrderStatus.allowedActions(o, cleared);
      const riskLine = o.riskRows.length
        ? '<span class="badge b-risk">高风险 ' + o.riskRows.join("/") + " 行</span>"
        : '<span class="badge b-norisk">无高风险行</span>';
      let meta = '<div class="meta">' +
        "机台：" + esc(o.loomId) + " · 纹样版本：" + esc(o.versionId) + "（指纹 " + esc(o.versionKey) + "）<br>" +
        "创建：" + fmtTime(o.createdAt) + " · 开工：" + fmtTime(o.startedAt) + " · 完工：" + fmtTime(o.finishedAt);
      if (o.frozenAt) meta += "<br>冻结：" + fmtTime(o.frozenAt) + " · 原因：" + esc(o.frozenReason);
      meta += "</div>";
      const preview = '<div class="preview" style="max-width:150px">' + miniPreviewHTML(o.snapshot) + "</div>";
      const btns = acts.map(function (a) {
        const disabled = a.id === "release" && !cleared ? "disabled" : "";
        return '<button class="small" data-act="' + a.id + '" data-id="' + o.id + '" ' + disabled + ">" + esc(a.label) + "</button>";
      }).join("");
      return '<div class="ocard"><div class="ttl"><b>' + o.id + '</b><span class="badge b-' + o.status + '">' +
        OrderStatus.LABELS[o.status] + "</span></div>" + meta +
        "<div style='margin:6px 0'>" + riskLine + "</div>" + preview +
        '<div class="acts">' + btns + "</div></div>";
    }).join("");

    box.querySelectorAll("[data-act]").forEach(function (b) {
      b.onclick = function () {
        const id = b.dataset.id, act = b.dataset.act;
        if (act === "reschedule") {
          selectedVersionId = db.headVersionId;
          const v = selectedVersion();
          pendingAcks = new Set(v && reviewOf(v.id) ? reviewOf(v.id).acknowledgedRows : []);
          logSys(id + "：旧单已留档，请在「断线复核」中补做新版本复核，然后用同机台重新建单（按新纹样重排）。");
          renderAll();
          return;
        }
        const labels = { release: "高风险处置放行", start: "开工", finish: "完工下机" };
        run(id + " · " + labels[act], function () {
          return OfflineStore.actOrder(id, act).then(function (o) {
            logReq(200, id + " 状态变更为「" + OrderStatus.LABELS[o.status] + "」");
          });
        });
      };
    });
  }

  function renderLog() {
    const box = $("#log");
    box.innerHTML = logs.map(function (l) {
      return '<div class="log-' + l.level + '">' + fmtTime(l.t) + " " + esc(l.text) + "</div>";
    }).join("");
    box.scrollTop = box.scrollHeight;
  }

  // ======================================================================
  // 事件
  // ======================================================================

  $("#newBtn").onclick = function () {
    const cols = Math.max(6, Math.min(36, Number($("#cols").value) || 18));
    const rows = Math.max(6, Math.min(32, Number($("#rows").value) || 14));
    snapshotUndo();
    draft = newDraft(cols, rows);
    active = 1;
    mutateDraft("重建网格（" + cols + "×" + rows + "）");
  };

  $("#activeHex").onchange = function () {
    draft.palette[active].hex = this.value;
    mutateDraft("色线色号修改（" + draft.palette[active].name + "）");
  };
  $("#activeName").onchange = function () {
    draft.palette[active].name = this.value.trim() || draft.palette[active].name;
    mutateDraft("色线名称修改");
  };

  document.querySelectorAll("[data-block]").forEach(function (btn) {
    btn.onclick = function () { block = btn.dataset.block; };
  });

  $("#undoBtn").onclick = function () {
    if (!undoStack.length || busy) return;
    redoStack.push(JSON.parse(JSON.stringify({ cells: draft.cells, cols: draft.cols, rows: draft.rows })));
    const s = undoStack.pop();
    draft.cells = s.cells; draft.cols = s.cols; draft.rows = s.rows;
    mutateDraft("撤销修改");
  };
  $("#redoBtn").onclick = function () {
    if (!redoStack.length || busy) return;
    undoStack.push(JSON.parse(JSON.stringify({ cells: draft.cells, cols: draft.cols, rows: draft.rows })));
    const s = redoStack.pop();
    draft.cells = s.cells; draft.cols = s.cols; draft.rows = s.rows;
    mutateDraft("重做修改");
  };

  $("#lockBtn").onclick = function () {
    const note = $("#changeNote").value.trim() || "手动锁定版本";
    run("锁定纹样版本", function () {
      return OfflineStore.createVersion({
        cols: draft.cols, rows: draft.rows,
        cells: draft.cells, palette: draft.palette,
        change: note
      }).then(function (v) {
        selectedVersionId = v.id;
        pendingAcks = new Set();
        logReq(201, "新版本已锁定：" + v.id + "（" + v.cols + "×" + v.rows + "，指纹 " + v.key + "），快照不可变");
      });
    });
  };

  $("#dupDemoBtn").onclick = function () {
    if (!lastRequest) { logSys("暂无可重复的提交，请先成功或尝试创建一张织造单。"); return; }
    const r = lastRequest;
    run("重复提交演练", function () {
      return OfflineStore.createOrder({ versionId: r.versionId, loomId: r.loomId, idemKey: r.idemKey }).then(function () {
        logReq(201, "重复提交竟成功（不应发生）");
      });
    });
  };

  $("#resetBtn").onclick = function () {
    if (!confirm("确认清空全部版本、复核与织造单（含冻结留档）？")) return;
    run("清空演示数据", async function () {
      await OfflineStore.resetAll();
      db = OfflineStore.getState();
      draft = newDraft(18, 14);
      selectedVersionId = null;
      pendingAcks = new Set();
      undoStack = []; redoStack = []; lastRequest = null;
      logSys("演示数据已清空。");
    });
  };

  // 跨标签：另一标签落库后本标签同步（刷新前后结果一致）
  window.addEventListener("storage", function (e) {
    if (e.key && e.key.indexOf("wzpt.db") === 0) {
      db = OfflineStore.getState();
      if (selectedVersionId && !selectedVersion()) selectedVersionId = db.headVersionId;
      renderAll();
      logSys("检测到其他标签写入，列表已同步。");
    }
  });

  // 忙碌态：所有按钮临时不可点，避免本标签并发
  const styleEl = document.createElement("style");
  styleEl.textContent = "body.busy button { pointer-events: none; opacity: .55; }";
  document.head.appendChild(styleEl);

  // ---- 启动：一律从持久化模块读取后渲染 ----
  OfflineStore.saveDraft(draft);
  const startV = selectedVersion();
  if (startV) {
    const rv = reviewOf(startV.id);
    pendingAcks = new Set(rv ? rv.acknowledgedRows : []);
  }
  logSys("离线织造排产台已就绪：状态计算 / 断线复核 / 持久化 三模块加载完成。");
  renderAll();
})();
