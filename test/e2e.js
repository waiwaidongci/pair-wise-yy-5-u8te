// 端到端业务验证：在 Node 中模拟 window/localStorage，加载三个业务模块
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};
const sandbox = { window: {}, localStorage, console, Math, JSON, Date, setTimeout, Promise };
sandbox.global = sandbox;
vm.createContext(sandbox);

["review.js", "status.js", "store.js"].forEach((f) => {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", f), "utf8"), sandbox, { filename: f });
});
// 浏览器中 window 即全局对象；vm 沙箱中需把模块导出同步到全局
Object.assign(sandbox, sandbox.window);
const { BreakReview, OrderStatus, OfflineStore } = sandbox;

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name); }
}
async function expectStatus(p, code, name) {
  try { await p; ok(name + " (expected " + code + ")", false); }
  catch (e) { ok(name + " -> " + e.status, e.status === code); }
}

const pal = ["#f7e7c4","#a6322d","#1f5f78","#d6a437","#355b38","#713d7b","#1e1b18","#e98c52"]
  .map((hex, i) => ({ hex, name: "c" + i }));

// 高风险纹样：10 列，每行 9 次换色（> 10*0.62 = 6.2）
function riskyCells(cols, rows) {
  const c = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) c.push(x % 2);
  return c;
}
// 低风险纹样：纯色
function plainCells(cols, rows) { return Array(cols * rows).fill(0); }

async function lockVersion(cols, rows, cells, change, basedOn) {
  return OfflineStore.createVersion({ cols, rows, cells, palette: pal, change, basedOn });
}

(async () => {
  // --- 1. 断线复核模块口径 ---
  const riskSnap = { cols: 10, rows: 4, cells: riskyCells(10, 4), palette: pal };
  const r1 = BreakReview.computeRisk(riskSnap);
  ok("高风险纹样：4 行全部判高风险", r1.highRisk && r1.riskRows.join() === "1,2,3,4");
  const plainSnap = { cols: 10, rows: 4, cells: plainCells(10, 4), palette: pal };
  ok("纯色纹样：无高风险", !BreakReview.computeRisk(plainSnap).highRisk);
  const sig1 = BreakReview.versionKey(riskSnap);
  const changedCells = riskyCells(10, 4); changedCells[0] = 3;
  ok("改任一格指纹变化", sig1 !== BreakReview.versionKey({ ...riskSnap, cells: changedCells }));
  const pal2 = pal.map((p) => ({ ...p })); pal2[1] = { ...pal2[1], hex: "#123456" };
  ok("改色线色号指纹变化", sig1 !== BreakReview.versionKey({ ...riskSnap, palette: pal2 }));
  ok("改行列数指纹变化", sig1 !== BreakReview.versionKey({ ...riskSnap, cols: 11 }));

  // --- 2. 建单闸门：未复核 422，不落库 ---
  const v1 = await lockVersion(10, 4, riskyCells(10, 4), "高风险初版");
  await expectStatus(OfflineStore.createOrder({ versionId: v1.id, loomId: "L01", idemKey: "k1" }), 422, "未复核建单 422");
  ok("422 不落库", OfflineStore.getState().orders.length === 0);

  // 复核签认漏一行 -> 仍未完成
  await OfflineStore.saveReview({ versionId: v1.id, key: BreakReview.versionKey(v1), acknowledgedRows: [1, 2, 3], completedAt: new Date().toISOString() });
  ok("漏签第 4 行：复核未完成", !BreakReview.isComplete(v1, OfflineStore.getState().reviews[v1.id]));
  await expectStatus(OfflineStore.createOrder({ versionId: v1.id, loomId: "L01", idemKey: "k1b" }), 422, "复核不完整建单 422");

  // 全签 -> 复核完成，建单成功且初始状态为待复核
  await OfflineStore.saveReview({ versionId: v1.id, key: BreakReview.versionKey(v1), acknowledgedRows: [1, 2, 3, 4], completedAt: new Date().toISOString() });
  ok("四行全签：复核完成", BreakReview.isComplete(v1, OfflineStore.getState().reviews[v1.id]));
  const o1 = await OfflineStore.createOrder({ versionId: v1.id, loomId: "L01", idemKey: "k2" });
  ok("高风险版本建单初始状态=待复核", o1.status === OrderStatus.PENDING_REVIEW);
  ok("订单快照随单存档", o1.snapshot.cells.length === 40 && o1.snapshot.palette.length === 8);

  // --- 3. 重复提交：同幂等键 409，不落库 ---
  await expectStatus(OfflineStore.createOrder({ versionId: v1.id, loomId: "L02", idemKey: "k2" }), 409, "重复提交 409");
  ok("重复提交不新增订单", OfflineStore.getState().orders.length === 1);

  // --- 4. 并发提交：同机台两个在途请求，第二个拿不到锁 409 ---
  const pA = OfflineStore.createOrder({ versionId: v1.id, loomId: "L02", idemKey: "pA" });
  const pB = OfflineStore.createOrder({ versionId: v1.id, loomId: "L02", idemKey: "pB" });
  let okA = false, codeB = null;
  const [rA, rB] = await Promise.allSettled([pA, pB]);
  okA = rA.status === "fulfilled"; codeB = rB.reason.status;
  ok("并发：第一个请求成功", okA);
  ok("并发：第二个请求 409", codeB === 409);
  ok("并发：仅一张落库", OfflineStore.getState().orders.length === 2);

  // --- 5. 织机占用：未完工单在机时拒绝 409；放行前的流转约束 ---
  // L01 的 o1 仍在待复核，同机台再建 -> 409
  await expectStatus(OfflineStore.createOrder({ versionId: v1.id, loomId: "L01", idemKey: "k3" }), 409, "机台被占用建单 409");
  // 待复核未放行不允许直接开工
  await expectStatus(OfflineStore.actOrder(o1.id, "start"), 409, "待复核直接开工 409");
  // 放行 -> 待开工 -> 开工
  const rel = await OfflineStore.actOrder(o1.id, "release");
  ok("高风险处置后放行到待开工", rel.status === OrderStatus.READY);
  const st = await OfflineStore.actOrder(o1.id, "start");
  ok("开工后状态=织造中", st.status === OrderStatus.WEAVING && !!st.startedAt);

  // L02 单完工 -> 释放机台
  const o2 = OfflineStore.getState().orders.find((o) => o.idemKey === "pA");
  await OfflineStore.actOrder(o2.id, "release");
  await OfflineStore.actOrder(o2.id, "start");
  await OfflineStore.actOrder(o2.id, "finish");
  ok("已完工不占机台", !OrderStatus.occupiesLoom(OrderStatus.DONE));

  // --- 6. 开工后改纹样：织造中单立即冻结留档（UI 流程：先改草稿冻结，再锁新版本）---
  const frozen = await OfflineStore.freezeRunningOrders("改色重排");
  ok("织造中旧单立即冻结", frozen.length === 1 && frozen[0].id === o1.id && frozen[0].status === OrderStatus.FROZEN);
  const v2 = await lockVersion(10, 4, plainCells(10, 4), "改纯色新版", v1.id);
  const frozenInDb = OfflineStore.getState().orders.find((o) => o.id === o1.id);
  ok("冻结单留档原因与旧快照", frozenInDb.frozenAt && frozenInDb.snapshot.cols === 10);
  ok("冻结后不占机台，可在同机台按新纹样重排", !OrderStatus.occupiesLoom(OrderStatus.FROZEN));

  // --- 7. 无高风险版本：复核后建单直接待开工 ---
  await OfflineStore.saveReview({ versionId: v2.id, key: BreakReview.versionKey(v2), acknowledgedRows: [], completedAt: new Date().toISOString() });
  const o3 = await OfflineStore.createOrder({ versionId: v2.id, loomId: "L01", idemKey: "k4" });
  ok("无高风险版本建单直接待开工", o3.status === OrderStatus.READY && o3.riskRows.length === 0);

  // 冻结单不可再流转
  await expectStatus(OfflineStore.actOrder(o1.id, "start"), 409, "冻结单不可开工 409");

  // 指纹不一致的复核记录视为失效（网格变了）
  const stale = { versionId: v2.id, key: "deadbeef", acknowledgedRows: [], completedAt: new Date().toISOString() };
  ok("指纹不符：复核失效", !BreakReview.isComplete(v2, stale));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
