/*
 * 业务模块三：持久化（OfflineStore）
 * 离线持久化模块：localStorage 落库，模拟 REST 请求（异步、HTTP 风格状态码）。
 *   - 建单前断线复核未完成 -> 422（不落库）
 *   - 重复提交（同幂等键）/ 并发提交（请求锁被占）/ 织机已有未完工单 -> 409（不落库）
 *   - 开工后改纹样 -> 织造中单立即冻结，版本快照随单留档
 * 依赖状态计算（OrderStatus）与断线复核（BreakReview）作为唯一业务口径。
 */
(function (global) {
  "use strict";

  const DB_KEY = "wzpt.db.v1";
  const DRAFT_KEY = "wzpt.draft.v1";
  const LOCK_KEY = "wzpt.orderLock.v1";
  const LOCK_TTL_MS = 3000;

  function HttpError(status, message, payload) {
    const e = new Error(message);
    e.status = status;
    e.payload = payload || null;
    return e;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function uid(prefix, n) { return prefix + "-" + String(n).padStart(3, "0"); }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function loadState() {
    const s = JSON.parse(localStorage.getItem(DB_KEY) || "null");
    if (s) return s;
    return { seq: { version: 0, order: 0 }, headVersionId: null, versions: [], reviews: {}, orders: [] };
  }

  function saveState(state) {
    localStorage.setItem(DB_KEY, JSON.stringify(state));
  }

  function loadDraft() {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
  }

  function saveDraft(draft) {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }

  // ---- 并发提交锁（跨标签：另一标签在提交期间也会读到该锁）----
  function readLock() {
    const l = JSON.parse(localStorage.getItem(LOCK_KEY) || "null");
    if (l && Date.now() - l.at < LOCK_TTL_MS) return l;
    if (l) localStorage.removeItem(LOCK_KEY);
    return null;
  }

  function acquireLock(token) {
    const held = readLock();
    if (held) {
      throw HttpError(409, "检测到并发提交：已有织造单正在提交，本次请求已拒绝（409，未落库）", { lock: held.token });
    }
    localStorage.setItem(LOCK_KEY, JSON.stringify({ token: token, at: Date.now() }));
  }

  function releaseLock(token) {
    const held = readLock();
    if (held && held.token === token) localStorage.removeItem(LOCK_KEY);
  }

  const Store = {
    HttpError: HttpError,

    getState: function () { return clone(loadState()); },

    loadDraft: loadDraft,
    saveDraft: saveDraft,

    // ---- 纹样版本：按网格和色线锁定（不可变快照）----
    createVersion: async function (input) {
      await delay(120);
      const state = loadState();
      state.seq.version += 1;
      const id = uid("v", state.seq.version);
      const snap = {
        id: id,
        seq: state.seq.version,
        cols: input.cols,
        rows: input.rows,
        cells: clone(input.cells),
        palette: clone(input.palette),
        basedOn: input.basedOn || state.headVersionId,
        change: input.change || "初版锁定",
        createdAt: new Date().toISOString()
      };
      snap.key = BreakReview.versionKey(snap);
      state.versions.push(snap);
      state.headVersionId = id;
      saveState(state);
      return clone(snap);
    },

    getVersion: function (id) {
      const v = loadState().versions.filter(function (x) { return x.id === id; })[0] || null;
      return v ? clone(v) : null;
    },

    // ---- 断线复核记录落库 ----
    saveReview: async function (payload) {
      await delay(100);
      const state = loadState();
      const version = state.versions.filter(function (v) { return v.id === payload.versionId; })[0];
      if (!version) throw HttpError(404, "纹样版本不存在");
      const rec = {
        versionId: payload.versionId,
        key: payload.key,
        acknowledgedRows: clone(payload.acknowledgedRows).sort(function (a, b) { return a - b; }),
        reviewer: payload.reviewer || "当班复核员",
        completedAt: payload.completedAt
      };
      state.reviews[payload.versionId] = rec;
      saveState(state);
      return clone(rec);
    },

    // ---- 创建织造单：POST /orders ----
    createOrder: async function (input) {
      // 幂等键 + 锁 token：重复（同键）与并发（锁占用）是两类 409
      const token = input.idemKey + "#" + Math.random().toString(36).slice(2, 8);

      const before = loadState();
      const dup = before.orders.filter(function (o) { return o.idemKey === input.idemKey; })[0];
      if (dup) {
        throw HttpError(409, "重复提交：该织造单请求已提交并落库，拒绝重复创建（409，未重复落库）", { orderId: dup.id });
      }

      acquireLock(token);
      try {
        await delay(240); // 模拟离线上行耗时，留出并发窗口
        const state = loadState();

        const version = state.versions.filter(function (v) { return v.id === input.versionId; })[0];
        if (!version) throw HttpError(404, "纹样版本不存在，无法创建织造单");

        // 建单闸门：必须先完成断线复核
        if (!BreakReview.isComplete(version, state.reviews[version.id])) {
          throw HttpError(422, "断线复核尚未完成，不能创建织造单（422，未落库）");
        }

        // 同一织机同时只能有一张未完工单
        const clash = state.orders.filter(function (o) {
          return o.loomId === input.loomId && OrderStatus.occupiesLoom(o.status);
        })[0];
        if (clash) {
          throw HttpError(409, "织机 " + input.loomId + " 已有未完工单（" + clash.id + "·" + OrderStatus.LABELS[clash.status] + "），建单被拒绝（409，未落库）", { orderId: clash.id });
        }

        state.seq.order += 1;
        const id = uid("zzd", state.seq.order);
        const risk = BreakReview.computeRisk(version);
        const order = {
          id: id,
          loomId: input.loomId,
          versionId: version.id,
          versionKey: version.key,
          // 按网格与色线锁定：快照随单存档，冻结后仍可查旧纹样
          snapshot: { cols: version.cols, rows: version.rows, cells: clone(version.cells), palette: clone(version.palette) },
          riskRows: risk.riskRows,
          status: OrderStatus.initialStatus(risk),
          idemKey: input.idemKey,
          createdAt: new Date().toISOString(),
          startedAt: null,
          finishedAt: null,
          frozenAt: null,
          frozenReason: null
        };
        state.orders.push(order);
        saveState(state);
        return clone(order);
      } finally {
        releaseLock(token);
      }
    },

    // ---- 织造单流转：放行 / 开工 / 完工 ----
    actOrder: async function (orderId, action) {
      await delay(140);
      const state = loadState();
      const order = state.orders.filter(function (o) { return o.id === orderId; })[0];
      if (!order) throw HttpError(404, "织造单不存在");

      if (action === "release") {
        const version = state.versions.filter(function (v) { return v.id === order.versionId; })[0];
        if (!BreakReview.isComplete(version, state.reviews[order.versionId])) {
          throw HttpError(422, "断线复核未完成，高风险行不能放行（422）");
        }
        if (!OrderStatus.canTransition(order.status, OrderStatus.READY)) {
          throw HttpError(409, "当前状态不允许放行（409）");
        }
        order.status = OrderStatus.READY;
      } else if (action === "start") {
        if (!OrderStatus.canTransition(order.status, OrderStatus.WEAVING)) {
          throw HttpError(409, "当前状态不允许开工（409）");
        }
        order.status = OrderStatus.WEAVING;
        order.startedAt = new Date().toISOString();
      } else if (action === "finish") {
        if (!OrderStatus.canTransition(order.status, OrderStatus.DONE)) {
          throw HttpError(409, "当前状态不允许完工（409）");
        }
        order.status = OrderStatus.DONE;
        order.finishedAt = new Date().toISOString();
      } else {
        throw HttpError(400, "未知操作：" + action);
      }
      saveState(state);
      return clone(order);
    },

    // ---- 开工后修改纹样：所有基于当前生产版本的织造中订单立即冻结留档 ----
    freezeRunningOrders: async function (reason) {
      await delay(60);
      const state = loadState();
      const frozen = [];
      state.orders.forEach(function (o) {
        if (o.status === OrderStatus.WEAVING && o.versionId === state.headVersionId) {
          o.status = OrderStatus.FROZEN;
          o.frozenAt = new Date().toISOString();
          o.frozenReason = reason || "开工后纹样/色线/行列数被修改";
          frozen.push(clone(o));
        }
      });
      if (frozen.length) saveState(state);
      return frozen;
    },

    resetAll: async function () {
      await delay(60);
      localStorage.removeItem(DB_KEY);
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(LOCK_KEY);
    }
  };

  global.OfflineStore = Store;
})(window);
