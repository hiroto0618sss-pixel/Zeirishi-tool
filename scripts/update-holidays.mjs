// 内閣府「国民の祝日」CSV から data/holidays.json と data/holidays.js を作るスクリプト。
//
// 使い方:
//   node scripts/update-holidays.mjs                 # 内閣府のサイトから取得
//   node scripts/update-holidays.mjs path/to/syukujitsu.csv   # ダウンロード済みのCSVを使う
//
// 出典: https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
// CSV : https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv （Shift_JIS）
//
// holidays.js は holidays.json と同じ内容を <script> で読み込める形にしたもの。
// index.html をダブルクリック（file://）で開いたときも fetch なしで動くようにするため。

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE_URL = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadCsvBytes(arg) {
  if (arg) return new Uint8Array(await readFile(arg));
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`取得に失敗しました: ${res.status} ${SOURCE_URL}`);
  return new Uint8Array(await res.arrayBuffer());
}

function parse(text) {
  const holidays = {};
  const lines = text.split(/\r?\n/).slice(1); // 1行目は見出し
  for (const line of lines) {
    if (!line.trim()) continue;
    const [ymd, name] = line.split(',');
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(ymd.trim());
    if (!m) throw new Error(`日付の形式が不正です: ${line}`);
    const key = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    holidays[key] = name.trim();
  }
  return holidays;
}

const bytes = await loadCsvBytes(process.argv[2]);
const text = new TextDecoder('shift_jis').decode(bytes);
const holidays = parse(text);
const keys = Object.keys(holidays).sort();
const sorted = Object.fromEntries(keys.map((k) => [k, holidays[k]]));

const data = {
  source: '内閣府「国民の祝日について」 ' + SOURCE_URL,
  generatedAt: new Date().toISOString().slice(0, 10),
  firstYear: Number(keys[0].slice(0, 4)),
  lastYear: Number(keys[keys.length - 1].slice(0, 4)),
  holidays: sorted,
};

const json = JSON.stringify(data, null, 2) + '\n';
await writeFile(path.join(root, 'data', 'holidays.json'), json);
await writeFile(
  path.join(root, 'data', 'holidays.js'),
  '// このファイルは scripts/update-holidays.mjs が自動生成します。直接編集しないでください。\n' +
    '// 内容は data/holidays.json と同じです（file:// で開いたときに fetch を使わずに読み込むため）。\n' +
    'globalThis.JP_HOLIDAYS = ' + JSON.stringify(data) + ';\n',
);
console.log(`祝日 ${keys.length} 件（${data.firstYear}〜${data.lastYear}年）を書き出しました。`);
