/*
 * 业务模块一：断线复核（BreakReview）
 * 纯计算模块：负责纹样指纹、逐行换色统计、高风险行判定、复核完成判定。
 * 列表页的风险提示与复核面板都只允许从这里取结果，保证口径一致。
 */
(function (global) {
  "use strict";

  // 换色次数超过列数的 62% 记为高风险行（沿用原排版台阈值，集中在一处维护）
  const THRESHOLD = 0.62;

  // FNV-1a 32 位指纹，用于把复核记录绑定到「网格 + 色线」的具体版本
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ("0000000" + (h >>> 0).toString(16)).slice(-8);
  }

  // 纹样签名：行列数 + 每个网格的色线索引 + 色线色号；改任一项指纹都变
  function signature(snap) {
    return [
      snap.cols,
      snap.rows,
      snap.cells.join(","),
      snap.palette.map(function (p) { return p.hex; }).join(",")
    ].join("|");
  }

  function versionKey(version) {
    return hash(signature(version));
  }

  // 逐行统计换色次数，输出高风险行（行号从 1 开始）
  function computeRisk(snap) {
    const rows = [];
    for (let y = 0; y < snap.rows; y++) {
      let switches = 0;
      for (let x = 1; x < snap.cols; x++) {
        if (snap.cells[y * snap.cols + x] !== snap.cells[y * snap.cols + x - 1]) switches++;
      }
      rows.push({ row: y + 1, switches: switches });
    }
    const limit = snap.cols * THRESHOLD;
    const riskRows = rows.filter(function (r) { return r.switches > limit; }).map(function (r) { return r.row; });
    return { threshold: THRESHOLD, limit: limit, rows: rows, riskRows: riskRows, highRisk: riskRows.length > 0 };
  }

  // 复核完成条件：复核记录属于该版本、指纹一致、且每条高风险行都已逐条签认
  function isComplete(version, review) {
    if (!review || review.versionId !== version.id || !review.key || review.key !== versionKey(version) || !review.completedAt) {
      return false;
    }
    const riskRows = computeRisk(version).riskRows;
    return riskRows.every(function (r) { return review.acknowledgedRows.indexOf(r) !== -1; });
  }

  global.BreakReview = {
    THRESHOLD: THRESHOLD,
    hash: hash,
    signature: signature,
    versionKey: versionKey,
    computeRisk: computeRisk,
    isComplete: isComplete
  };
})(window);
