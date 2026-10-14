'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const engine = require('../src/deadlines.js');
const holidays = require('../data/holidays.json');

const { computeDeadlines, adjustToBusinessDay, toCsv } = engine;

// ダミーの顧問先（実在のデータではありません）
function corp(overrides) {
  return {
    entityType: 'corporation',
    year: 2026,
    fiscalEndMonth: 3,
    corpTaxExtension: false,
    consumptionTaxExtension: false,
    prevCorpTax: null,
    prevConsumptionTax: null,
    withholdingSpecial: false,
    ...overrides,
  };
}

function individual(overrides) {
  return { entityType: 'individual', year: 2026, withholdingSpecial: false, ...overrides };
}

function run(input) {
  return computeDeadlines(input, { holidays });
}

function find(items, pred) {
  return items.filter(pred);
}

function corpFinal(items) {
  return find(items, (it) => it.tax === '法人税・地方法人税' && it.procedure.startsWith('確定申告'));
}

function consFinal(items) {
  return find(items, (it) => it.tax === '消費税・地方消費税' && it.procedure.startsWith('確定申告'));
}

// ---------------------------------------------------------------------------
// 休日判定
// ---------------------------------------------------------------------------

test('休日判定: 平日はそのまま、土日は翌平日', () => {
  assert.equal(adjustToBusinessDay('2026-06-30', holidays), '2026-06-30'); // 火
  assert.equal(adjustToBusinessDay('2026-05-30', holidays), '2026-06-01'); // 土 → 月
  assert.equal(adjustToBusinessDay('2026-05-31', holidays), '2026-06-01'); // 日 → 月
});

test('休日判定: 祝日・振替休日・連休をまたいで延長', () => {
  // 2026-05-03(日・憲法記念日) 5/4(みどりの日) 5/5(こどもの日) 5/6(振替休日) → 5/7
  assert.equal(adjustToBusinessDay('2026-05-03', holidays), '2026-05-07');
  // 2026-09-21(敬老の日) 9/22(国民の休日) 9/23(秋分の日) → 9/24
  assert.equal(adjustToBusinessDay('2026-09-21', holidays), '2026-09-24');
});

test('休日判定: 年末年始 12/29〜1/3 は休日', () => {
  // 2026-01-01(木・元日) 1/2(金) 1/3(土) 1/4(日) → 1/5(月)
  assert.equal(adjustToBusinessDay('2026-01-01', holidays), '2026-01-05');
  assert.equal(adjustToBusinessDay('2026-01-02', holidays), '2026-01-05');
  assert.equal(adjustToBusinessDay('2026-01-03', holidays), '2026-01-05');
  // 2026-12-29(火) は平日だが年末の休日 → 年明けの 2027-01-04(月)
  assert.equal(adjustToBusinessDay('2026-12-29', holidays), '2027-01-04');
  assert.equal(adjustToBusinessDay('2026-12-31', holidays), '2027-01-04');
  // 2025-12-31(水) → 2026-01-05(月)
  assert.equal(adjustToBusinessDay('2025-12-31', holidays), '2026-01-05');
  assert.equal(engine.isBusinessDay('2026-12-28', holidays), true);
});

// ---------------------------------------------------------------------------
// 法人税・消費税の確定申告
// ---------------------------------------------------------------------------

test('3月決算 → 5/31（平日ならそのまま）', () => {
  const { items } = run(corp({ year: 2024, fiscalEndMonth: 3 }));
  const [c] = corpFinal(items);
  assert.equal(c.statutoryDate, '2024-05-31'); // 金
  assert.equal(c.dueDate, '2024-05-31');
  assert.equal(c.shifted, false);
  assert.equal(c.basis, '法法74①');
  assert.equal(c.period, '2023年4月〜2024年3月期');
  assert.equal(consFinal(items)[0].dueDate, '2024-05-31');
});

test('3月決算 → 5/31 が日曜なら翌平日（2026年 → 6/1）', () => {
  const { items } = run(corp({ year: 2026, fiscalEndMonth: 3 }));
  const [c] = corpFinal(items);
  assert.equal(c.statutoryDate, '2026-05-31');
  assert.equal(c.dueDate, '2026-06-01');
  assert.equal(c.weekday, '月');
  assert.equal(c.shifted, true);
  assert.equal(c.shiftReason, '日曜日');
  assert.match(c.basis, /通法10②/);
});

test('3月決算 → 5/31 が土曜なら翌平日（2025年 → 6/2）', () => {
  const { items } = run(corp({ year: 2025, fiscalEndMonth: 3 }));
  assert.equal(corpFinal(items)[0].dueDate, '2025-06-02');
  assert.equal(consFinal(items)[0].dueDate, '2025-06-02');
});

test('8月決算 → 10/31', () => {
  assert.equal(corpFinal(run(corp({ year: 2025, fiscalEndMonth: 8 })).items)[0].dueDate, '2025-10-31'); // 金
  // 2026-10-31 は土曜 → 11/2(月)
  const c = corpFinal(run(corp({ year: 2026, fiscalEndMonth: 8 })).items)[0];
  assert.equal(c.statutoryDate, '2026-10-31');
  assert.equal(c.dueDate, '2026-11-02');
});

test('12月決算 → 2月末（うるう年は2/29）', () => {
  // 2024年はうるう年: 2/29(木)
  const leap = corpFinal(run(corp({ year: 2024, fiscalEndMonth: 12 })).items)[0];
  assert.equal(leap.statutoryDate, '2024-02-29');
  assert.equal(leap.dueDate, '2024-02-29');
  assert.equal(leap.period, '2023年1月〜2023年12月期');
  // 2025年は平年: 2/28(金)
  assert.equal(corpFinal(run(corp({ year: 2025, fiscalEndMonth: 12 })).items)[0].dueDate, '2025-02-28');
  // 2026年: 2/28(土) → 3/2(月)
  const c = corpFinal(run(corp({ year: 2026, fiscalEndMonth: 12 })).items)[0];
  assert.equal(c.statutoryDate, '2026-02-28');
  assert.equal(c.dueDate, '2026-03-02');
});

test('3月決算で延長特例あり → 6/30（法人税・消費税とも）', () => {
  const { items, warnings } = run(
    corp({ year: 2026, fiscalEndMonth: 3, corpTaxExtension: true, consumptionTaxExtension: true }),
  );
  const c = corpFinal(items)[0];
  assert.equal(c.dueDate, '2026-06-30');
  assert.equal(c.basis, '法法74①、75の2①');
  const s = consFinal(items)[0];
  assert.equal(s.dueDate, '2026-06-30');
  assert.equal(s.basis, '消法45①、45の2①');
  assert.ok(!warnings.some((w) => w.includes('45の2①）。消費税は延長なし')));
});

test('延長特例は法人税だけ → 消費税は5/31のまま', () => {
  const { items } = run(corp({ year: 2024, fiscalEndMonth: 3, corpTaxExtension: true }));
  assert.equal(corpFinal(items)[0].dueDate, '2024-07-01'); // 6/30(日) → 7/1
  assert.equal(consFinal(items)[0].dueDate, '2024-05-31');
});

test('消費税だけ延長特例ありは法律上できない → 延長しないで警告', () => {
  const { items, warnings } = run(corp({ year: 2024, fiscalEndMonth: 3, consumptionTaxExtension: true }));
  assert.equal(consFinal(items)[0].dueDate, '2024-05-31');
  assert.ok(warnings.some((w) => w.includes('消法45の2①')));
});

test('10月決算: 12/31 の期限は 1/1〜1/3 を飛ばして翌年1/4へ', () => {
  // 2025年11月〜2026年10月期 → 法定期限 2026-12-31 → 2027-01-04(月)
  const in2026 = corpFinal(run(corp({ year: 2026, fiscalEndMonth: 10 })).items);
  // 2026年中には期限が来ない（前期分 2025-12-31 → 2026-01-05 が入る）
  assert.equal(in2026.length, 1);
  assert.equal(in2026[0].statutoryDate, '2025-12-31');
  assert.equal(in2026[0].dueDate, '2026-01-05');
  assert.equal(in2026[0].shiftReason, '年末の休日（12/31）');

  const in2027 = corpFinal(run(corp({ year: 2027, fiscalEndMonth: 10 })).items);
  assert.equal(in2027.length, 1);
  assert.equal(in2027[0].statutoryDate, '2026-12-31');
  assert.equal(in2027[0].dueDate, '2027-01-04');
});

// ---------------------------------------------------------------------------
// 法人税の中間申告
// ---------------------------------------------------------------------------

test('法人税の中間申告: 前期税額×6/12 が10万円超なら必要、以下なら不要', () => {
  assert.equal(engine.corpTaxInterimRequired(200000, 12).required, false); // ちょうど10万円
  assert.equal(engine.corpTaxInterimRequired(200001, 12).required, true);
  assert.equal(engine.corpTaxInterimRequired(0, 12).required, false);
  // 前期が6か月なら ×6/6
  assert.equal(engine.corpTaxInterimRequired(150000, 6).required, true);
});

test('法人税の中間申告: 3月決算 → 11/30', () => {
  const { items } = run(corp({ year: 2026, fiscalEndMonth: 3, prevCorpTax: 1000000 }));
  const m = find(items, (it) => it.tax === '法人税・地方法人税' && it.procedure.startsWith('中間'));
  assert.equal(m.length, 1);
  assert.equal(m[0].dueDate, '2026-11-30'); // 月
  assert.equal(m[0].basis, '法法71①');
  assert.equal(m[0].period, '2026年4月〜2027年3月期（2026年4月〜2026年9月分）');
});

test('法人税の中間申告: 不要なら一覧に出ない', () => {
  const { items, warnings } = run(corp({ year: 2026, fiscalEndMonth: 3, prevCorpTax: 200000 }));
  assert.equal(find(items, (it) => it.procedure.startsWith('中間')).length, 0);
  assert.ok(warnings.some((w) => w.includes('法人税の中間申告は不要')));
});

test('法人税の中間申告: 延長特例があっても中間申告の期限は変わらない', () => {
  const { items } = run(corp({ year: 2026, fiscalEndMonth: 3, prevCorpTax: 1000000, corpTaxExtension: true }));
  const m = find(items, (it) => it.tax === '法人税・地方法人税' && it.procedure.startsWith('中間'));
  assert.equal(m[0].dueDate, '2026-11-30');
});

// ---------------------------------------------------------------------------
// 消費税の中間申告
// ---------------------------------------------------------------------------

test('消費税の中間申告の回数: 48万円 / 400万円 / 4,800万円 が境目', () => {
  const n = (v) => engine.consumptionInterimCount(v, 12);
  assert.equal(n(0), 0);
  assert.equal(n(480000), 0);
  assert.equal(n(480001), 1);
  assert.equal(n(4000000), 1);
  assert.equal(n(4000001), 3);
  assert.equal(n(48000000), 3);
  assert.equal(n(48000001), 11);
});

function consInterims(items) {
  return find(items, (it) => it.tax === '消費税・地方消費税' && it.procedure.startsWith('中間'));
}

test('消費税の中間申告 年1回: 3月決算 → 11/30', () => {
  const { items } = run(corp({ year: 2026, fiscalEndMonth: 3, prevConsumptionTax: 1000000 }));
  const m = consInterims(items);
  assert.deepEqual(m.map((it) => it.dueDate), ['2026-11-30']);
  assert.equal(m[0].basis, '消法42⑥');
});

test('消費税の中間申告 年3回: 3月決算 → 8/31・11/30・翌2月末', () => {
  const y2026 = consInterims(run(corp({ year: 2026, fiscalEndMonth: 3, prevConsumptionTax: 10000000 })).items);
  // 2026年中: 前期(2025/4〜2026/3期)の第3回 2026-02-28(土)→3/2、当期の第1回 8/31、第2回 11/30
  assert.deepEqual(
    y2026.map((it) => [it.dueDate, it.procedure]),
    [
      ['2026-03-02', '中間申告・納付（年3回・第3回）'],
      ['2026-08-31', '中間申告・納付（年3回・第1回）'],
      ['2026-11-30', '中間申告・納付（年3回・第2回）'],
    ],
  );
  assert.equal(y2026[1].period, '2026年4月〜2027年3月期（2026年4月〜2026年6月分）');
});

test('消費税の中間申告 年11回: 3月決算 → 4・5月分が7月末、以後は各月末日の2か月後', () => {
  const { items } = run(corp({ year: 2026, fiscalEndMonth: 3, prevConsumptionTax: 60000000 }));
  const m = consInterims(items).filter((it) => it.period.startsWith('2026年4月〜2027年3月期'));
  assert.deepEqual(
    m.map((it) => it.statutoryDate),
    [
      '2026-07-31', // 4月分
      '2026-07-31', // 5月分
      '2026-08-31', // 6月分
      '2026-09-30', // 7月分
      '2026-10-31', // 8月分
      '2026-11-30', // 9月分
    ],
  );
  // 10月分は法定期限 12/31 → 翌年1/4 になるので2026年の一覧には出ない。2027年の一覧で確認する
  const next = consInterims(run(corp({ year: 2027, fiscalEndMonth: 3, prevConsumptionTax: 60000000 })).items)
    .filter((it) => it.period.startsWith('2026年4月〜2027年3月期'));
  assert.deepEqual(
    next.map((it) => [it.procedure.match(/第(\d+)回/)[1], it.statutoryDate, it.dueDate]),
    [
      ['7', '2026-12-31', '2027-01-04'],
      ['8', '2027-01-31', '2027-02-01'],
      ['9', '2027-02-28', '2027-03-01'],
      ['10', '2027-03-31', '2027-03-31'],
      ['11', '2027-04-30', '2027-04-30'],
    ],
  );
  // 2026年の一覧には 12/31 法定期限の分は入らない
  assert.ok(!m.some((it) => it.dueDate === '2026-12-31'));
});

test('消費税の中間申告 年11回 + 延長特例: 開始後2か月分は開始日から3か月経過後2か月以内', () => {
  const { items } = run(
    corp({
      year: 2026,
      fiscalEndMonth: 3,
      corpTaxExtension: true,
      consumptionTaxExtension: true,
      prevConsumptionTax: 60000000,
    }),
  );
  const m = consInterims(items).filter((it) => it.period.startsWith('2026年4月〜2027年3月期'));
  assert.deepEqual(
    m.slice(0, 4).map((it) => it.statutoryDate),
    ['2026-08-31', '2026-08-31', '2026-08-31', '2026-09-30'],
  );
});

// ---------------------------------------------------------------------------
// 個人
// ---------------------------------------------------------------------------

test('個人: 所得税3/15・消費税3/31・予定納税7月末・11月末（国税庁の令和8年の納期限と一致）', () => {
  // 国税庁「主な国税の納期限（法定納期限）及び振替日」: 令和8年分 予定納税 7/31(金)・11/30(月)
  const y2026 = run(individual({ year: 2026 })).items;
  const pick = (proc) => find(y2026, (it) => it.procedure === proc).map((it) => it.dueDate);
  assert.deepEqual(pick('予定納税（第1期）'), ['2026-07-31']);
  assert.deepEqual(pick('予定納税（第2期）'), ['2026-11-30']);
  // 令和7年分の確定申告: 3/15(日) → 3/16(月)、消費税 3/31(火)
  const income = find(y2026, (it) => it.tax === '所得税・復興特別所得税' && it.procedure === '確定申告・納付');
  assert.equal(income[0].statutoryDate, '2026-03-15');
  assert.equal(income[0].dueDate, '2026-03-16');
  assert.equal(income[0].period, '2025年分');
  assert.equal(consFinal(y2026)[0].dueDate, '2026-03-31');
  assert.equal(consFinal(y2026)[0].basis, '措法86の4①');

  // 令和8年分（2027年に期限）: 所得税 3/15(月)、消費税 3/31(水)
  const y2027 = run(individual({ year: 2027 })).items;
  assert.equal(find(y2027, (it) => it.procedure === '確定申告・納付' && it.tax.startsWith('所得税'))[0].dueDate, '2027-03-15');
  assert.equal(consFinal(y2027)[0].dueDate, '2027-03-31');
});

test('個人: 予定納税第2期 2025年は 11/30(日) → 12/1', () => {
  const items = run(individual({ year: 2025 })).items;
  assert.deepEqual(find(items, (it) => it.procedure === '予定納税（第2期）').map((it) => it.dueDate), ['2025-12-01']);
});

test('個人では法人税の項目が出ない', () => {
  const items = run(individual({ year: 2026 })).items;
  assert.equal(find(items, (it) => it.tax.startsWith('法人税')).length, 0);
});

// ---------------------------------------------------------------------------
// 源泉所得税
// ---------------------------------------------------------------------------

test('源泉所得税 原則: 翌月10日（12か月分。前年12月分は1/10）', () => {
  const items = find(run(corp({ year: 2026 })).items, (it) => it.tax.startsWith('源泉'));
  assert.equal(items.length, 12);
  assert.equal(items[0].period, '2025年12月支払分');
  assert.equal(items[0].statutoryDate, '2026-01-10'); // 土 → 1/12 は成人の日 → 1/13
  assert.equal(items[0].dueDate, '2026-01-13');
  assert.equal(items[11].period, '2026年11月支払分');
  assert.equal(items[11].dueDate, '2026-12-10');
});

test('源泉所得税 納期の特例: 1〜6月分は7/10、7〜12月分は翌年1/20', () => {
  const y2026 = find(run(corp({ year: 2026, withholdingSpecial: true })).items, (it) => it.tax.startsWith('源泉'));
  assert.deepEqual(
    y2026.map((it) => [it.period, it.dueDate]),
    [
      ['2025年7月〜12月支払分', '2026-01-20'],
      ['2026年1月〜6月支払分', '2026-07-10'],
    ],
  );
  assert.equal(y2026[0].basis, '所法216');
  // 2026年7〜12月分 → 翌年(2027年)1/20(水)
  const y2027 = find(run(corp({ year: 2027, withholdingSpecial: true })).items, (it) => it.tax.startsWith('源泉'));
  assert.deepEqual(y2027[0], { ...y2027[0], period: '2026年7月〜12月支払分', dueDate: '2027-01-20' });
});

test('源泉所得税 納期の特例: 7/10 が土日なら翌平日（2027年は7/12）', () => {
  const items = find(run(individual({ year: 2027, withholdingSpecial: true })).items, (it) => it.tax.startsWith('源泉'));
  const jul = items.find((it) => it.period === '2027年1月〜6月支払分');
  assert.equal(jul.statutoryDate, '2027-07-10'); // 土
  assert.equal(jul.dueDate, '2027-07-12');
});

// ---------------------------------------------------------------------------
// 1/31 の手続
// ---------------------------------------------------------------------------

test('償却資産申告・法定調書・給与支払報告書: 1/31（土曜なら翌平日）', () => {
  const pick = (year) =>
    find(run(individual({ year })).items, (it) => it.statutoryDate === `${year}-01-31`).map((it) => [
      it.procedure,
      it.dueDate,
    ]);
  // 2025-01-31 は金曜
  assert.deepEqual(pick(2025), [
    ['償却資産申告（市町村）', '2025-01-31'],
    ['法定調書・同合計表の提出（税務署）', '2025-01-31'],
    ['給与支払報告書の提出（市町村）', '2025-01-31'],
  ]);
  // 2026-01-31 は土曜 → 2/2(月)（国税庁「法定調書の提出期限」令和7年分も2/2）
  const y2026 = find(run(individual({ year: 2026 })).items, (it) => it.statutoryDate === '2026-01-31');
  assert.equal(y2026.length, 3);
  assert.ok(y2026.every((it) => it.dueDate === '2026-02-02'));
  const local = y2026.find((it) => it.procedure.startsWith('償却資産'));
  assert.match(local.basis, /地方税法20の5②/);
  const national = y2026.find((it) => it.procedure.startsWith('法定調書'));
  assert.match(national.basis, /通法10②/);
});

// ---------------------------------------------------------------------------
// 一覧全体
// ---------------------------------------------------------------------------

test('一覧は日付順で、すべて対象年の中に収まる', () => {
  const { items } = run(
    corp({ year: 2026, fiscalEndMonth: 12, prevCorpTax: 5000000, prevConsumptionTax: 60000000 }),
  );
  assert.ok(items.length > 0);
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].dueDate <= items[i].dueDate);
  assert.ok(items.every((it) => it.dueDate.startsWith('2026-')));
  assert.ok(items.every((it) => it.tax && it.procedure && it.basis));
});

test('祝日データの範囲外の年は警告', () => {
  const { warnings } = run(individual({ year: holidays.lastYear + 1 }));
  assert.ok(warnings.some((w) => w.includes('祝日データがありません')));
});

test('入力エラー', () => {
  assert.throws(() => run({ entityType: 'x', year: 2026 }), /区分/);
  assert.throws(() => run(corp({ fiscalEndMonth: 13 })), /決算月/);
  assert.throws(() => run(corp({ prevCorpTax: -1 })), /prevCorpTax/);
  assert.throws(() => run(corp({ year: 2026.5 })), /対象年/);
});

test('CSV: 見出し行と、カンマ・引用符のエスケープ', () => {
  const csv = toCsv([
    {
      dueDate: '2026-06-01',
      weekday: '月',
      statutoryDate: '2026-05-31',
      tax: '法人税',
      procedure: '確定申告',
      period: 'A,B',
      basis: '法法74①',
      note: '"注"',
    },
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '期限日,曜日,法定の期限（休日調整前）,税目,手続,対象期間,根拠条文,備考');
  assert.equal(lines[1], '2026-06-01,月,2026-05-31,法人税,確定申告,"A,B",法法74①,"""注"""');
});

// ---------------------------------------------------------------------------
// 祝日データ
// ---------------------------------------------------------------------------

test('祝日データ: holidays.js と holidays.json が同じ内容', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'data', 'holidays.js'), 'utf8');
  const sandbox = {};
  new Function('globalThis', src)(sandbox);
  assert.deepEqual(sandbox.JP_HOLIDAYS, holidays);
});

test('祝日データ: 主要な祝日が入っている', () => {
  assert.equal(holidays.holidays['2026-01-01'], '元日');
  assert.equal(holidays.holidays['2026-05-06'], '休日');
  assert.equal(holidays.holidays['2026-09-22'], '休日');
});
