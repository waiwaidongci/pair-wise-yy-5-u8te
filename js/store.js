/*
 * 持久化模块（业务模块三）
 * 职责：离线读写排产台全部数据（纹样草稿/版本、织造单、复核记录）。
 * 约束：
 *  - 只负责存取，不做状态判断、不做风险计算；
 *  - 每次 commit 只执行一次同步写入（单条 localStorage 记录），
 *    配合 api 层的在途锁，保证并发提交不会落库半条数据；
 *  - 数据全部可序列化为 JSON，刷新页面后由本模块原样读出。
 */
(function (global) {
  "use strict";

  var DB_KEY = "zxWeavingDB_v1";

  function memoryStorage() {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; }
    };
  }

  function getStorage() {
    try {
      if (global.localStorage && typeof global.localStorage.setItem === "function") {
        return global.localStorage;
      }
    } catch (e) { /* file:// 隐私模式等场景降级 */ }
    if (!global.__zxMemStorage) global.__zxMemStorage = memoryStorage();
    return global.__zxMemStorage;
  }

  function defaultState() {
    return {
      pattern: null, // { id, name, createdAt, draft:{cols,rows,cells,palette}, versions:[], currentVersionId }
      orders: [],    // 织造单（含已冻结留档单）
      reviews: {},   // { [versionId]: { rows: { "行号": {by,at} }, updatedAt } }
      usedRequestIds: {}, // 幂等键 -> 织造单 id，拦截重复提交
      seq: { order: 0, version: 0 },
      savedAt: null
    };
  }

  function normalize(data) {
    var base = defaultState();
    if (!data || typeof data !== "object") return base;
    return {
      pattern: data.pattern || null,
      orders: Array.isArray(data.orders) ? data.orders : [],
      reviews: data.reviews && typeof data.reviews === "object" ? data.reviews : {},
      usedRequestIds: data.usedRequestIds && typeof data.usedRequestIds === "object" ? data.usedRequestIds : {},
      seq: {
        order: data.seq && data.seq.order || 0,
        version: data.seq && data.seq.version || 0
      },
      savedAt: data.savedAt || null
    };
  }

  function create(storage) {
    var s = storage || getStorage();

    function load() {
      var raw = s.getItem(DB_KEY);
      if (!raw) return defaultState();
      try {
        return normalize(JSON.parse(raw));
      } catch (e) {
        return defaultState();
      }
    }

    function persist(state) {
      state.savedAt = Date.now();
      s.setItem(DB_KEY, JSON.stringify(state));
    }

    // mutator 内同步修改 state；其返回值作为 out 带出。
    // 全程只有最后一次 persist 写库，要么整次成功，要么根本不写。
    function commit(mutator) {
      var state = load();
      var out = mutator(state) || {};
      if (out.skipWrite) return out;
      persist(state);
      out.state = state;
      return out;
    }

    return {
      key: DB_KEY,
      load: load,
      commit: commit,
      reset: function () { s.removeItem(DB_KEY); }
    };
  }

  global.ZxStore = { create: create, KEY: DB_KEY };
})(typeof window !== "undefined" ? window : globalThis);
