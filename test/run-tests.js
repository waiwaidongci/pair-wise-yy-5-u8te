/*
 * 离线业务规则测试（无第三方依赖）：node test/run-tests.js
 * 覆盖：版本锁定、断线复核、一机一单、重复/并发 409 不落库、
 *       开工后改版冻结留档、刷新（换 store 实例）后列表与风险一致。
 */
"use strict";

const path = require("path");
require(path.join(__dirname, "..", "js", "store.js"));
require(path.join(__dirname, "..", "js", "review.js"));
require(path.join(__dirname, "..", "js", "status.js"));
require(path.join(__dirname, "..", "js", "api.js"));

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failed++; console.error("  ✗ " + msg); }
}
async function test(name, fn) {
  console.log("\n" + name);
  await fn();
}

function memStorage() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    _dump: () => m
  };
}

function makeApp() {
  const storage = memStorage();
  const store = ZxStore.create(storage);
  const api = ZxApi.create({ store, review: ZxReview, status: ZxStatus });
  return { storage, store, api };
}

// 在第 row 行制造满行交替色（换色率 100% → 高风险）
function highRiskDraft(cells, cols, row) {
  for (let x = 0; x < cols; x++) cells[row * cols + x] = x % 2;
}

(async function run() {
  // ---------- 1. 版本锁定 ----------
  await test("1. 纹样草稿与版本锁定（网格+色线快照不可变）", async () => {
    const { api } = makeApp();
    await api.initPattern();
    let st = api.getState().body;
    highRiskDraft(st.pattern.draft.cells, 18, 0);
    let r = await api.saveDraft({ cells: st.pattern.draft.cells });
    assert(r.code === 200, "保存草稿 200");

    r = await api.lockVersion();
    assert(r.code === 201 && r.body.version.no === 1, "锁定 v1：201");
    r = await api.lockVersion();
    assert(r.code === 400, "草稿与版本一致时重复锁定：400");

    // 版本快照不可被后续草稿修改污染
    st = api.getState().body;
    const snap = JSON.parse(JSON.stringify(st.pattern.versions[0].snapshot));
    st.pattern.draft.cells[0] = 7;
    await api.saveDraft({ cells: st.pattern.draft.cells });
    st = api.getState().body;
    assert(JSON.stringify(st.pattern.versions[0].snapshot) === JSON.stringify(snap), "改草稿不影响已锁定版本快照");
  });

  // ---------- 2. 断线复核前置 ----------
  await test("2. 创建织造单前断线复核：高风险未复核只能待复核", async () => {
    const { api } = makeApp();
    await api.initPattern();
    let st = api.getState().body;
    highRiskDraft(st.pattern.draft.cells, 18, 0);
    await api.saveDraft({ cells: st.pattern.draft.cells });
    await api.lockVersion();

    let risk = api.riskOfVersion().body;
    assert(risk.highRows.join() === "1" && risk.cleared === false, "风险计算：第1行高风险、未清零");

    let r = await api.createOrder({ loom: "1#", worker: "甲", requestId: "r1" });
    assert(r.code === 201 && r.body.status === "pending_review", "有未复核高风险行 → 201 但状态为待复核");

    // 待复核单不能直接开工
    r = await api.startOrder(r.body.id);
    assert(r.code === 409, "待复核单直接开工 → 409");

    // 复核非高风险行被拒
    r = await api.reviewRow("v1", 5, "甲");
    assert(r.code === 400, "复核非高风险行 → 400");

    r = await api.reviewRow("v1", 1, "甲");
    assert(r.code === 200, "第1行复核：200");
    r = await api.reviewRow("v1", 1, "甲");
    assert(r.code === 400, "同一行重复复核 → 400（该行已不在待复核清单）");

    const list = api.listOrders().body;
    assert(list[0].status === "scheduled", "复核补齐后自动重排为已排产");

    // 无高风险的版本：直接已排产
    const { api: api2 } = makeApp();
    await api2.initPattern();
    await api2.lockVersion();
    r = await api2.createOrder({ loom: "9#", requestId: "x" });
    assert(r.code === 201 && r.body.status === "scheduled", "无高风险版本 → 直接已排产");
  });

  // ---------- 3. 一机一单 + 重复/并发 409 ----------
  await test("3. 同一织机一机一单；重复与并发提交 409 且不落库", async () => {
    const { api, store } = makeApp();
    await api.initPattern();
    await api.lockVersion();

    const count = () => store.load().orders.length;

    let [a, b] = await Promise.all([
      api.createOrder({ loom: "3#", requestId: "dup-1" }),
      api.createOrder({ loom: "3#", requestId: "dup-1" })
    ]);
    const codes = [a.code, b.code].sort().join(",");
    assert(codes === "201,409", "并发相同请求：一个 201 一个 409（实际 " + codes + "）");
    assert(count() === 1, "并发提交只有一张单落库");
    assert(b.body.error.conflict === "concurrent" || a.body.error.conflict === "concurrent", "409 标记为并发冲突");

    // 相同请求号串行重放
    let r = await api.createOrder({ loom: "5#", requestId: "dup-1" });
    assert(r.code === 409 && r.body.error.conflict === "duplicate", "相同请求号重复提交 → 409 duplicate");
    assert(count() === 1, "重复提交不落库");

    // 另一织机可用
    r = await api.createOrder({ loom: "4#", requestId: "dup-2" });
    assert(r.code === 201, "不同织机可建单 → 201");

    // 同织机再来一张（未完工）→ 409 loom_busy
    r = await api.createOrder({ loom: "3#", requestId: "dup-3" });
    assert(r.code === 409 && r.body.error.conflict === "loom_busy", "织机占用中再建单 → 409 loom_busy");
    assert(count() === 2, "占用冲突不落库");

    // 开工、完工后释放织机
    const id3 = store.load().orders.find((o) => o.loom === "3#").id;
    r = await api.startOrder(id3);
    assert(r.code === 200 && r.body.status === "weaving", "开工 → 织造中");
    r = await api.finishOrder(id3);
    assert(r.code === 200 && r.body.status === "done", "完工 → 已完工");
    r = await api.createOrder({ loom: "3#", requestId: "dup-4" });
    assert(r.code === 201, "完工后织机释放，可再建单");

    // 已完工单不能再操作
    r = await api.finishOrder(id3);
    assert(r.code === 409, "完工单再次完工 → 409");
  });

  // ---------- 4. 开工后改版冻结留档 ----------
  await test("4. 开工后修改纹样并锁定新版本：旧单立即冻结留档，按新版本重排", async () => {
    const { api, store } = makeApp();
    await api.initPattern();
    await api.lockVersion(); // v1 无风险

    let r = await api.createOrder({ loom: "7#", requestId: "f1" });
    const oldId = r.body.id;
    await api.startOrder(oldId);
    assert(r.body.status === "scheduled", "v1 无风险直接排产并可开工");

    // 修改草稿：改尺寸（行列数变化）并给第2行制造高风险
    r = await api.saveDraft({ cols: 20, rows: 16 });
    let st = api.getState().body;
    const d = st.pattern.draft;
    highRiskDraft(d.cells, d.cols, 1);
    await api.saveDraft({ cells: d.cells });

    r = await api.lockVersion();
    assert(r.code === 201 && r.body.version.no === 2, "锁定 v2：201");
    assert(r.body.frozenOrders.join() === oldId, "织造中的旧单被冻结并返回其 id");

    st = store.load();
    const old = st.orders.find((o) => o.id === oldId);
    assert(old.status === "frozen" && old.frozenAt && old.frozenReason, "旧单状态=已冻结留档，带冻结时间与原因");
    assert(old.snapshot.cols === 18 && old.snapshot.rows === 14, "冻结单内嵌旧版本快照（18×14）留档");

    // 冻结单不占机，新版本按新纹样重排；新风险未复核 → 待复核
    r = await api.createOrder({ loom: "7#", requestId: "f2" });
    assert(r.code === 201 && r.body.status === "pending_review", "同机可按新版本重排，因高风险先转待复核");
    assert(r.body.snapshot.cols === 20 && r.body.snapshot.rows === 16, "新单按新网格 20×16 排产");

    // 新版本复核必须重做（v1 无复核记录也不影响）
    await api.reviewRow("v2", 2, "乙");
    const list = api.listOrders().body;
    const fresh = list.find((o) => o.id !== oldId);
    assert(fresh.status === "scheduled", "新版本补做复核后新单转已排产");
    r = await api.startOrder(fresh.id);
    assert(r.code === 200, "重排单可开工");

    // 冻结单不可复活
    r = await api.finishOrder(oldId);
    assert(r.code === 409, "冻结留档单不能继续操作 → 409");
  });

  // ---------- 5. 刷新一致性 ----------
  await test("5. 刷新后（新 store 实例读取同一离线存储）列表、风险、占用一致", async () => {
    const storage = memStorage();
    let store = ZxStore.create(storage);
    let api = ZxApi.create({ store, review: ZxReview, status: ZxStatus });
    await api.initPattern();
    let st = api.getState().body;
    highRiskDraft(st.pattern.draft.cells, 18, 0);
    highRiskDraft(st.pattern.draft.cells, 18, 1);
    await api.saveDraft({ cells: st.pattern.draft.cells });
    await api.lockVersion();
    await api.createOrder({ loom: "2#", requestId: "p1" }); // 待复核
    await api.reviewRow("v1", 1, "甲");
    const before = {
      orders: api.listOrders().body.map((o) => ({ id: o.id, status: o.status, pending: o.risk.pendingRows })),
      risk: api.riskOfVersion().body,
      raw: storage.getItem(ZxStore.KEY)
    };

    // 模拟刷新：重建全部模块，但共用同一离线存储
    store = ZxStore.create(storage);
    api = ZxApi.create({ store, review: ZxReview, status: ZxStatus });
    const after = {
      orders: api.listOrders().body.map((o) => ({ id: o.id, status: o.status, pending: o.risk.pendingRows })),
      risk: api.riskOfVersion().body
    };
    assert(JSON.stringify(before.orders) === JSON.stringify(after.orders), "列表与待复核行刷新前后一致（仍剩第2行待复核）");
    assert(JSON.stringify(before.risk.highRows) === JSON.stringify(after.risk.highRows), "风险提示刷新前后一致");
    assert(after.orders[0].status === "pending_review", "刷新后仍是待复核状态（少复核一行不能转排产）");

    // 复核补齐，再刷新一次
    await api.reviewRow("v1", 2, "甲");
    let list = api.listOrders().body;
    assert(list[0].status === "scheduled", "补齐复核后转已排产");
    store = ZxStore.create(storage);
    api = ZxApi.create({ store, review: ZxReview, status: ZxStatus });
    list = api.listOrders().body;
    assert(list[0].status === "scheduled" && list[0].occupiesLoom === true, "再刷新状态与织机占用仍一致");
  });

  console.log("\n========================================");
  console.log("通过 " + passed + " 项，失败 " + failed + " 项");
  if (failed) process.exit(1);
})();
