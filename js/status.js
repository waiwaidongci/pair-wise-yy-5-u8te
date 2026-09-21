/*
 * 业务模块二：状态计算（OrderStatus）
 * 纯函数模块：织造单的状态集合、流转规则、允许动作、高风险处置判定。
 * 列表徽标、按钮可用性、刷新后结果一律从这里计算，禁止在 UI 里另写判断。
 */
(function (global) {
  "use strict";

  // 待复核：创建单时存在任一高风险行，只能进此状态
  const PENDING_REVIEW = "PENDING_REVIEW";
  // 待开工：无高风险（或高风险行已逐条处置完毕），等待上机
  const READY = "READY";
  // 织造中：已开工
  const WEAVING = "WEAVING";
  // 已完工：下机
  const DONE = "DONE";
  // 已冻结：开工后纹样/色线/行列数被修改，旧单立即冻结并留档
  const FROZEN = "FROZEN";

  const ALL = [PENDING_REVIEW, READY, WEAVING, DONE, FROZEN];

  const LABELS = {
    PENDING_REVIEW: "待复核",
    READY: "待开工",
    WEAVING: "织造中",
    DONE: "已完工",
    FROZEN: "已冻结"
  };

  const ALIVE = [PENDING_REVIEW, READY, WEAVING];

  function isAlive(status) { return ALIVE.indexOf(status) !== -1; }

  // 占用织机的判定：仅未完工（待复核/待开工/织造中）占用；已冻结/已完工不占用
  function occupiesLoom(status) { return isAlive(status); }

  // 创建织造单时的初始状态：有高风险行只能转待复核，无风险才可待开工
  function initialStatus(risk) {
    return risk.highRisk ? PENDING_REVIEW : READY;
  }

  // 高风险处置是否完成：风险提示中的每一行都已签认，且没有漏签
  function riskCleared(risk, acknowledgedRows) {
    if (!risk.highRisk) return true;
    return risk.riskRows.every(function (r) { return acknowledgedRows.indexOf(r) !== -1; });
  }

  // 合法状态流转
  const TRANSITIONS = {};
  TRANSITIONS[PENDING_REVIEW] = [READY, FROZEN];
  TRANSITIONS[READY] = [WEAVING, FROZEN];
  TRANSITIONS[WEAVING] = [DONE, FROZEN];
  TRANSITIONS[DONE] = [];
  TRANSITIONS[FROZEN] = [];

  function canTransition(from, to) {
    return (TRANSITIONS[from] || []).indexOf(to) !== -1;
  }

  // 当前状态下允许的人工动作（是否可放行还要结合 riskCleared，由调用方传入）
  function allowedActions(order, cleared) {
    const acts = [];
    if (order.status === PENDING_REVIEW && cleared) acts.push({ id: "release", label: "处置完毕，转待开工" });
    if (order.status === READY) acts.push({ id: "start", label: "开工" });
    if (order.status === WEAVING) acts.push({ id: "finish", label: "完工下机" });
    if (order.status === FROZEN) acts.push({ id: "reschedule", label: "按新纹样重排" });
    return acts;
  }

  global.OrderStatus = {
    PENDING_REVIEW: PENDING_REVIEW,
    READY: READY,
    WEAVING: WEAVING,
    DONE: DONE,
    FROZEN: FROZEN,
    ALL: ALL,
    LABELS: LABELS,
    isAlive: isAlive,
    occupiesLoom: occupiesLoom,
    initialStatus: initialStatus,
    riskCleared: riskCleared,
    canTransition: canTransition,
    allowedActions: allowedActions
  };
})(window);
