/*
 * 状态计算模块（业务模块一）
 * 职责：织造单的状态判定与流转规则，纯计算、不碰存储。
 * 存储层只保留规范字段（status + 各时间戳），
 * 列表展示、织机占用、风险提示等派生信息统一由本模块计算，
 * 因此刷新前后、不同列表之间结果必然一致。
 *
 * 状态机：
 *   创建  --(有高风险行未复核)--> pending_review 待复核
 *   创建  --(无待复核高风险)----> scheduled     已排产
 *   pending_review --(高风险行全部复核)--> scheduled
 *   scheduled --开工--> weaving 织造中
 *   weaving  --(新纹样版本锁定)--> frozen 已冻结留档（终态，不释放为可重排，改由新单重排）
 *   weaving  --完工--> done 已完工
 */
(function (global) {
  "use strict";

  var STATUS = {
    PENDING_REVIEW: "pending_review",
    SCHEDULED: "scheduled",
    WEAVING: "weaving",
    FROZEN: "frozen",
    DONE: "done"
  };

  var LABELS = {
    pending_review: "待复核",
    scheduled: "已排产",
    weaving: "织造中",
    frozen: "已冻结留档",
    done: "已完工"
  };

  var ACTIVE_STATUSES = [STATUS.PENDING_REVIEW, STATUS.SCHEDULED, STATUS.WEAVING];

  function isUnfinished(o) { return ACTIVE_STATUSES.indexOf(o.status) !== -1; }

  // 织机占用：待复核/已排产/织造中 都算未完工单；冻结留档与完工不再占机
  function occupiesLoom(o) { return isUnfinished(o); }

  function findActiveForLoom(orders, loom) {
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      if (o.loom === loom && occupiesLoom(o)) return o;
    }
    return null;
  }

  var TRANSITIONS = {
    confirmReview: { from: [STATUS.PENDING_REVIEW], to: STATUS.SCHEDULED },
    start: { from: [STATUS.SCHEDULED], to: STATUS.WEAVING },
    finish: { from: [STATUS.WEAVING], to: STATUS.DONE },
    freeze: { from: [STATUS.WEAVING], to: STATUS.FROZEN }
  };

  function canTransition(order, action) {
    var rule = TRANSITIONS[action];
    if (!rule) return { ok: false, error: { code: "UNKNOWN_ACTION", message: "未知操作：" + action } };
    if (rule.from.indexOf(order.status) === -1) {
      return {
        ok: false,
        error: {
          code: "INVALID_STATUS",
          message: LABELS[order.status] + "状态不能执行该操作"
        }
      };
    }
    return { ok: true, to: rule.to };
  }

  // 织造单在列表中的完整派生视图：状态文案/样式 + 该版本快照上的断线复核情况
  function viewOf(order, ctx) {
    var v = {
      status: order.status,
      statusLabel: LABELS[order.status] || order.status,
      occupies: occupiesLoom(order),
      can: {
        confirmReview: canTransition(order, "confirmReview").ok,
        start: canTransition(order, "start").ok,
        finish: canTransition(order, "finish").ok
      }
    };
    if (ctx && ctx.snapshot && ctx.reviewModule) {
      var sum = ctx.reviewModule.summarize(ctx.snapshot, ctx.review);
      v.risk = sum;
      v.needReview = order.status === STATUS.PENDING_REVIEW;
    }
    return v;
  }

  global.ZxStatus = {
    STATUS: STATUS,
    LABELS: LABELS,
    isUnfinished: isUnfinished,
    occupiesLoom: occupiesLoom,
    findActiveForLoom: findActiveForLoom,
    canTransition: canTransition,
    viewOf: viewOf
  };
})(typeof window !== "undefined" ? window : globalThis);
