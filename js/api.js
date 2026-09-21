/*
 * 应用服务层：编排 持久化(store) / 断线复核(review) / 状态计算(status) 三个业务模块。
 * 模拟离线 HTTP 接口：所有方法返回 { code, body }，409 表示冲突且保证不落库。
 * 并发控制：在途锁 inFlight 串行化写操作；重复/并发提交先在内存中判定，
 *           再在 commit 的同一次同步读写里二次判定（校验与落库原子）。
 */
(function (global) {
  "use strict";

  function ok(code, body) { return { code: code || 200, body: body }; }
  function fail(code, message, extra) {
    var e = { code: "ERR_" + code, message: message };
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return { code: code, body: { error: e } };
  }

  function create(deps) {
    var store = deps.store;
    var Review = deps.review;
    var Status = deps.status;
    var inFlight = null; // 写操作在途锁（Promise）

    function withLock(fn) {
      if (inFlight) {
        return fail(409, "已有提交正在处理，请勿并发重复提交", { conflict: "concurrent" });
      }
      var release;
      inFlight = new Promise(function (r) { release = r; });
      return Promise.resolve()
        .then(fn)
        .catch(function (e) { return fail(400, e && e.message || "操作失败"); })
        .then(function (res) { release(); inFlight = null; return res; });
    }

    // ---------- 读取 ----------
    function getState() {
      return ok(200, store.load());
    }

    function currentVersion(state) {
      if (!state.pattern || !state.pattern.currentVersionId) return null;
      return state.pattern.versions.filter(function (v) {
        return v.id === state.pattern.currentVersionId;
      })[0] || null;
    }

    function findVersion(state, versionId) {
      if (!state.pattern) return null;
      return state.pattern.versions.filter(function (v) { return v.id === versionId; })[0] || null;
    }

    // ---------- 纹样草稿 ----------
    var DEFAULT_PALETTE = ["#f7e7c4", "#a6322d", "#1f5f78", "#d6a437", "#355b38", "#713d7b", "#1e1b18", "#e98c52"];

    function initPattern(name) {
      return withLock(function () {
        return store.commit(function (state) {
          if (state.pattern) {
            return { skipWrite: true, result: fail(409, "纹样已存在，不能重复初始化") };
          }
          var cols = 18, rows = 14;
          state.pattern = {
            id: "pat_1",
            name: name || "云锦·默认纹样",
            createdAt: Date.now(),
            draft: { cols: cols, rows: rows, cells: new Array(cols * rows).fill(0), palette: DEFAULT_PALETTE.slice() },
            versions: [],
            currentVersionId: null
          };
        }).result || ok(201, store.load().pattern);
      });
    }

    function saveDraft(patch) {
      return withLock(function () {
        var res = store.commit(function (state) {
          if (!state.pattern) return { skipWrite: true, result: fail(404, "尚未初始化纹样") };
          var d = state.pattern.draft;
          if (patch.cells) {
            if (!Array.isArray(patch.cells) || patch.cells.length !== d.cols * d.rows) {
              return { skipWrite: true, result: fail(400, "格点数与网格不一致") };
            }
            d.cells = patch.cells.map(Number);
          }
          if (patch.palette) {
            if (!Array.isArray(patch.palette) || patch.palette.some(function (c) { return typeof c !== "string"; })) {
              return { skipWrite: true, result: fail(400, "色线库格式不正确") };
            }
            d.palette = patch.palette.slice();
          }
          if (patch.cols != null || patch.rows != null) {
            var cols = Math.max(6, Math.min(36, Number(patch.cols != null ? patch.cols : d.cols)));
            var rows = Math.max(6, Math.min(32, Number(patch.rows != null ? patch.rows : d.rows)));
            var cells = new Array(cols * rows).fill(0);
            for (var y = 0; y < rows; y++) {
              for (var x = 0; x < cols; x++) {
                if (x < d.cols && y < d.rows) cells[y * cols + x] = d.cells[y * d.cols + x];
              }
            }
            d.cols = cols; d.rows = rows; d.cells = cells;
          }
        });
        if (res.skipWrite) return res.result;
        return ok(200, res.state.pattern.draft);
      });
    }

    function sameGrid(a, b) {
      return a.cols === b.cols && a.rows === b.rows &&
        JSON.stringify(a.cells) === JSON.stringify(b.cells) &&
        JSON.stringify(a.palette) === JSON.stringify(b.palette);
    }

    // ---------- 版本锁定：网格 + 色线整体冻结 ----------
    function lockVersion() {
      return withLock(function () {
        var res = store.commit(function (state) {
          if (!state.pattern) return { skipWrite: true, result: fail(404, "尚未初始化纹样") };
          var draft = state.pattern.draft;
          var cur = currentVersion(state);
          if (cur && sameGrid(cur.snapshot, draft)) {
            return { skipWrite: true, result: fail(400, "草稿与当前版本 v" + cur.no + " 完全一致，无需锁定新版本") };
          }
          state.seq.version += 1;
          var no = state.seq.version;
          var version = {
            id: "v" + no,
            no: no,
            lockedAt: Date.now(),
            snapshot: {
              cols: draft.cols, rows: draft.rows,
              cells: draft.cells.slice(), palette: draft.palette.slice()
            }
          };
          state.pattern.versions.push(version);
          state.pattern.currentVersionId = version.id;
          state.reviews[version.id] = { rows: {}, updatedAt: null }; // 新版本复核从头做

          // 开工后改纹样/色线/行列数并锁定：织造中的旧单立即冻结留档
          var frozen = [];
          state.orders.forEach(function (o) {
            if (o.status === Status.STATUS.WEAVING) {
              o.status = Status.STATUS.FROZEN;
              o.frozenAt = Date.now();
              o.frozenReason = "纹样已锁定新版本 v" + no + "（网格/色线变更），旧单冻结留档，按新版本补做复核后重排";
              frozen.push(o.id);
            }
          });
          return { version: version, frozen: frozen };
        });
        if (res.skipWrite) return res.result;
        return ok(201, { version: res.version, frozenOrders: res.frozen });
      });
    }

    // ---------- 断线复核 ----------
    function reviewRow(versionId, rowNo, by) {
      return withLock(function () {
        var res = store.commit(function (state) {
          var ver = findVersion(state, versionId);
          if (!ver) return { skipWrite: true, result: fail(404, "版本不存在：" + versionId) };
          var review = state.reviews[versionId] || { rows: {}, updatedAt: null };
          var r = Review.markRow(ver.snapshot, review, Number(rowNo), by, Date.now());
          if (r.error) return { skipWrite: true, result: fail(400, r.error.message) };
          state.reviews[versionId] = r.review;
        });
        if (res.skipWrite) return res.result;
        // 复核补齐后：该版本的待复核单自动转为已排产（重排）
        var promoted = promoteClearedOrders();
        return promoted.code !== 200 ? promoted : ok(200, res.state.reviews[versionId]);
      });
    }

    function promoteClearedOrders() {
      var res = store.commit(function (state) {
        var changed = [];
        state.orders.forEach(function (o) {
          if (o.status !== Status.STATUS.PENDING_REVIEW) return;
          var ver = findVersion(state, o.versionId);
          if (!ver) return;
          if (Review.isVersionCleared(ver.snapshot, state.reviews[o.versionId])) {
            o.status = Status.STATUS.SCHEDULED;
            o.clearedAt = Date.now();
            changed.push(o.id);
          }
        });
        return { changed: changed };
      });
      if (res.skipWrite) return res.result;
      return ok(200, { promoted: res.changed || [] });
    }

    // ---------- 织造单 ----------
    function createOrder(input) {
      input = input || {};
      var requestId = input.requestId || null;
      if (input.loom == null || String(input.loom).trim() === "") {
        return Promise.resolve(fail(400, "必须指定织机编号"));
      }
      var loom = String(input.loom).trim();

      return withLock(function () {
        var res = store.commit(function (state) {
          // 幂等：相同 requestId 视为重复提交
          if (requestId && state.usedRequestIds[requestId]) {
            return {
              skipWrite: true,
              result: fail(409, "重复提交：该请求已生成过织造单", {
                conflict: "duplicate", existingOrderId: state.usedRequestIds[requestId]
              })
            };
          }
          if (!state.pattern || !state.pattern.currentVersionId) {
            return { skipWrite: true, result: fail(400, "尚未锁定任何纹样版本，无法创建织造单") };
          }
          // 冲突判定与落库在同一次 commit 内，并发提交最多一个写入成功
          var active = Status.findActiveForLoom(state.orders, loom);
          if (active) {
            return {
              skipWrite: true,
              result: fail(409, "织机" + loom + "已有未完工单 " + active.id + "（" + Status.LABELS[active.status] + "）", {
                conflict: "loom_busy", existingOrderId: active.id
              })
            };
          }

          var ver = currentVersion(state);
          var review = state.reviews[ver.id] || { rows: {}, updatedAt: null };
          var pending = Review.pendingRows(ver.snapshot, review);
          var status = pending.length ? Status.STATUS.PENDING_REVIEW : Status.STATUS.SCHEDULED;

          state.seq.order += 1;
          var id = "MO" + String(state.seq.order).padStart(4, "0");
          var now = Date.now();
          var order = {
            id: id,
            loom: loom,
            versionId: ver.id,
            versionNo: ver.no,
            snapshot: {
              cols: ver.snapshot.cols, rows: ver.snapshot.rows,
              cells: ver.snapshot.cells.slice(), palette: ver.snapshot.palette.slice()
            },
            status: status,
            pendingRiskRows: pending.slice(),
            worker: input.worker || "织工",
            createdAt: now,
            scheduledAt: status === Status.STATUS.SCHEDULED ? now : null,
            startedAt: null, finishedAt: null, frozenAt: null, frozenReason: null
          };
          state.orders.push(order);
          if (requestId) state.usedRequestIds[requestId] = id;
          return { order: order };
        });
        if (res.skipWrite) return res.result;
        return ok(201, res.order);
      });
    }

    function transitionOrder(orderId, action) {
      return withLock(function () {
        var res = store.commit(function (state) {
          var order = state.orders.filter(function (o) { return o.id === orderId; })[0];
          if (!order) return { skipWrite: true, result: fail(404, "织造单不存在：" + orderId) };
          var guard = Status.canTransition(order, action);
          if (!guard.ok) return { skipWrite: true, result: fail(409, guard.error.message, { conflict: "status" }) };

          if (action === "confirmReview") {
            var ver = findVersion(state, order.versionId);
            var pending = Review.pendingRows(ver.snapshot, state.reviews[order.versionId] || {});
            if (pending.length) {
              return { skipWrite: true, result: fail(409, "仍有高风险行未复核：第" + pending.join("、") + "行", { conflict: "review_open" }) };
            }
            order.clearedAt = Date.now();
          }
          if (action === "start") order.startedAt = Date.now();
          if (action === "finish") order.finishedAt = Date.now();
          order.status = guard.to;
          return { order: order };
        });
        if (res.skipWrite) return res.result;
        return ok(200, res.order);
      });
    }

    // 列表：所有派生信息（状态文案、占用、风险）都由 status + review 现算
    function listOrders() {
      var state = store.load();
      var list = state.orders.slice().sort(function (a, b) { return b.createdAt - a.createdAt; }).map(function (o) {
        var ver = findVersion(state, o.versionId);
        var view = Status.viewOf(o, {
          snapshot: o.snapshot,
          review: state.reviews[o.versionId] || { rows: {}, updatedAt: null },
          reviewModule: Review
        });
        return Object.assign({}, o, {
          statusLabel: view.statusLabel,
          occupiesLoom: view.occupies,
          can: view.can,
          risk: view.risk,
          versionExists: !!ver
        });
      });
      return ok(200, list);
    }

    function riskOfVersion(versionId) {
      var state = store.load();
      var ver = versionId ? findVersion(state, versionId) : currentVersion(state);
      if (!ver) return ok(200, null);
      return ok(200, Review.summarize(ver.snapshot, state.reviews[ver.id] || { rows: {}, updatedAt: null }));
    }

    function draftRisk() {
      var state = store.load();
      if (!state.pattern) return ok(200, null);
      var d = state.pattern.draft;
      return ok(200, Review.summarize({ cols: d.cols, rows: d.rows, cells: d.cells, palette: d.palette }, null));
    }

    return {
      getState: getState,
      initPattern: initPattern,
      saveDraft: saveDraft,
      lockVersion: lockVersion,
      reviewRow: reviewRow,
      createOrder: createOrder,
      startOrder: function (id) { return transitionOrder(id, "start"); },
      finishOrder: function (id) { return transitionOrder(id, "finish"); },
      confirmReview: function (id) { return transitionOrder(id, "confirmReview"); },
      listOrders: listOrders,
      riskOfVersion: riskOfVersion,
      draftRisk: draftRisk
    };
  }

  global.ZxApi = { create: create };
})(typeof window !== "undefined" ? window : globalThis);
