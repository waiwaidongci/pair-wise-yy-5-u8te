/*
 * 断线复核模块（业务模块二）
 * 职责：对「已锁定的纹样版本快照」（网格行列 + 色线 + 格点）做断线风险评估，
 *       并管理逐行复核记录。只做风险判定与复核状态，不关心织造单与落库。
 * 数据来源固定为版本快照，草稿的风险只用于绘制时提示，不能替代复核；
 * 因此新版本必须重新复核（复核与版本绑定，见 completeForVersion 记录结构）。
 */
(function (global) {
  "use strict";

  // 一行内相邻格点换色次数占列数的比例阈值
  var HIGH_RISK = 0.62;   // 高风险：未复核时禁止正常创建织造单
  var MEDIUM_RISK = 0.45; // 中风险：仅提示，不阻断

  function colorSwitches(cells, cols, y) {
    var n = 0, start = y * cols;
    for (var x = 1; x < cols; x++) {
      if (cells[start + x] !== cells[start + x - 1]) n++;
    }
    return n;
  }

  // 纯函数：输入版本快照，输出每行风险与整体高风险行号
  function assess(snapshot) {
    var cols = snapshot.cols, rows = snapshot.rows;
    var rowsInfo = [];
    var high = [], medium = [];
    for (var y = 0; y < rows; y++) {
      var switches = colorSwitches(snapshot.cells, cols, y);
      var ratio = cols > 1 ? switches / (cols - 1) : 0;
      var level = ratio > HIGH_RISK ? "high" : ratio > MEDIUM_RISK ? "medium" : "ok";
      rowsInfo.push({ row: y + 1, switches: switches, ratio: ratio, level: level });
      if (level === "high") high.push(y + 1);
      else if (level === "medium") medium.push(y + 1);
    }
    return {
      rows: rowsInfo,
      highRows: high,
      mediumRows: medium,
      hasHighRisk: high.length > 0
    };
  }

  // 复核记录里的「已复核行」（版本 + 行号双层 key）
  function reviewedRows(review) {
    if (!review || !review.rows) return {};
    return review.rows;
  }

  // 某版本的高风险行是否已全部复核
  // 复核完整性 = 当前版本快照算出的高风险行 - 已复核行 == 0
  function isVersionCleared(snapshot, review) {
    var high = assess(snapshot).highRows;
    var done = reviewedRows(review);
    for (var i = 0; i < high.length; i++) {
      if (!done[String(high[i])]) return false;
    }
    return true;
  }

  // 待复核的高风险行（用于织造单标注与列表提示）
  function pendingRows(snapshot, review) {
    var high = assess(snapshot).highRows;
    var done = reviewedRows(review);
    return high.filter(function (r) { return !done[String(r)]; });
  }

  // 提交一行复核：仅接受当前版本快照中仍存在的高风险行，
  // 防止旧记录覆盖新网格（新版本复核记录初始为空，必须逐行重做）。
  function markRow(snapshot, review, rowNo, by, at) {
    var info = assess(snapshot);
    if (info.highRows.indexOf(rowNo) === -1) {
      return { error: { code: "ROW_NOT_HIGH_RISK", message: "第" + rowNo + "行不是当前版本的高风险行，无需/无法复核" } };
    }
    var next = review ? JSON.parse(JSON.stringify(review)) : { rows: {}, updatedAt: null };
    if (!next.rows) next.rows = {};
    if (next.rows[String(rowNo)]) {
      return { error: { code: "ROW_ALREADY_REVIEWED", message: "第" + rowNo + "行已完成复核，不能重复提交" } };
    }
    next.rows[String(rowNo)] = { by: by || "织工", at: at || Date.now() };
    next.updatedAt = at || Date.now();
    return { review: next };
  }

  function summarize(snapshot, review) {
    var info = assess(snapshot);
    var pending = pendingRows(snapshot, review);
    return {
      highRows: info.highRows,
      mediumRows: info.mediumRows,
      pendingRows: pending,
      cleared: pending.length === 0,
      rows: info.rows
    };
  }

  global.ZxReview = {
    HIGH_RISK: HIGH_RISK,
    MEDIUM_RISK: MEDIUM_RISK,
    assess: assess,
    isVersionCleared: isVersionCleared,
    pendingRows: pendingRows,
    markRow: markRow,
    summarize: summarize
  };
})(typeof window !== "undefined" ? window : globalThis);
