// 税務期限エンジンの画面。計算はすべて src/deadlines.js（DeadlineEngine）に任せる。
(function () {
  'use strict';

  var engine = window.DeadlineEngine;
  var holidays = window.JP_HOLIDAYS;
  var form = document.getElementById('form');
  var corpFields = document.getElementById('corpFields');
  var csvButton = document.getElementById('csvButton');
  var errorsEl = document.getElementById('errors');
  var resultEl = document.getElementById('result');
  var lastResult = null;
  var lastInput = null;

  // 決算月の選択肢
  var monthSelect = document.getElementById('fiscalEndMonth');
  for (var m = 1; m <= 12; m++) {
    var opt = document.createElement('option');
    opt.value = String(m);
    opt.textContent = m + '月';
    if (m === 3) opt.selected = true;
    monthSelect.appendChild(opt);
  }

  form.year.value = String(new Date().getFullYear());
  document.getElementById('holidayRange').textContent =
    holidays.firstYear + '〜' + holidays.lastYear + '年分を収録、' + holidays.generatedAt + ' 取得';
  document.getElementById('yearHint').textContent =
    '祝日データは' + holidays.lastYear + '年まで収録しています。';

  function entityType() {
    return form.querySelector('input[name="entityType"]:checked').value;
  }

  function updateVisibility() {
    corpFields.hidden = entityType() !== 'corporation';
  }

  // 「1,200,000」「１２０万」などは受け付けず、半角・全角の数字とカンマだけを許可する
  function parseAmount(raw, label, errors) {
    var s = String(raw || '')
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
      .replace(/[,，\s]/g, '');
    if (s === '') return null;
    if (!/^\d+$/.test(s)) {
      errors.push(label + 'は数字で入力してください（例: 1,200,000）。');
      return null;
    }
    return Number(s);
  }

  function readInput() {
    var errors = [];
    var input = {
      entityType: entityType(),
      year: Number(form.year.value),
      withholdingSpecial: form.withholdingSpecial.checked,
    };
    if (input.entityType === 'corporation') {
      input.fiscalEndMonth = Number(form.fiscalEndMonth.value);
      input.corpTaxExtension = form.corpTaxExtension.checked;
      input.consumptionTaxExtension = form.consumptionTaxExtension.checked;
      input.prevCorpTax = parseAmount(form.prevCorpTax.value, '前期の法人税額', errors);
      input.prevConsumptionTax = parseAmount(form.prevConsumptionTax.value, '前期の消費税額', errors);
    }
    return { input: input, errors: errors.concat(engine.validate(input)) };
  }

  function formatDate(iso, weekday) {
    var p = iso.split('-');
    return p[0] + '/' + Number(p[1]) + '/' + Number(p[2]) + '（' + weekday + '）';
  }

  function cell(tr, text, className) {
    var td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text;
    tr.appendChild(td);
    return td;
  }

  function render(input, result) {
    var title = input.year + '年の期限一覧（' +
      (input.entityType === 'corporation' ? input.fiscalEndMonth + '月決算法人' : '個人') + '・' +
      result.items.length + '件）';
    document.getElementById('resultTitle').textContent = title;

    var warningsEl = document.getElementById('warnings');
    warningsEl.textContent = '';
    result.warnings.forEach(function (w) {
      var li = document.createElement('li');
      li.textContent = w;
      warningsEl.appendChild(li);
    });

    var tbody = document.getElementById('rows');
    tbody.textContent = '';
    result.items.forEach(function (it) {
      var tr = document.createElement('tr');
      var dateTd = cell(tr, formatDate(it.dueDate, it.weekday), 'date');
      if (it.shifted) {
        var small = document.createElement('div');
        small.className = 'shifted';
        small.textContent = '法定 ' + formatDate(it.statutoryDate, weekdayOf(it.statutoryDate)) +
          ' が' + it.shiftReason + 'のため延長（' + it.holidayRule + '）';
        dateTd.appendChild(small);
      }
      cell(tr, it.tax, 'tax');
      cell(tr, it.procedure, 'procedure');
      cell(tr, it.period, 'period');
      cell(tr, it.statutoryBasis, 'basis');
      cell(tr, it.note, 'note');
      tbody.appendChild(tr);
    });
    resultEl.hidden = false;
  }

  function weekdayOf(iso) {
    var p = iso.split('-');
    return '日月火水木金土'.charAt(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay());
  }

  function showErrors(errors) {
    errorsEl.textContent = errors.join('\n');
    errorsEl.hidden = errors.length === 0;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var read = readInput();
    showErrors(read.errors);
    if (read.errors.length) {
      resultEl.hidden = true;
      csvButton.disabled = true;
      return;
    }
    lastInput = read.input;
    lastResult = engine.computeDeadlines(read.input, { holidays: holidays });
    render(lastInput, lastResult);
    csvButton.disabled = false;
  });

  form.addEventListener('change', function (e) {
    if (e.target.name === 'entityType') updateVisibility();
    // 入力を変えたら古い結果のCSVを書き出さないようにする
    csvButton.disabled = true;
  });
  form.addEventListener('input', function () {
    csvButton.disabled = true;
  });

  csvButton.addEventListener('click', function () {
    if (!lastResult) return;
    // Excel で文字化けしないよう UTF-8 の BOM を付ける
    var blob = new Blob(['﻿' + engine.toCsv(lastResult.items)], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    // ファイル名は英数字のみ（日本語名は環境によって無視されるため）。例: deadlines_2026_corp-fy03.csv
    a.download = 'deadlines_' + lastInput.year + '_' +
      (lastInput.entityType === 'corporation'
        ? 'corp-fy' + String(lastInput.fiscalEndMonth).padStart(2, '0')
        : 'individual') + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  });

  updateVisibility();
})();
