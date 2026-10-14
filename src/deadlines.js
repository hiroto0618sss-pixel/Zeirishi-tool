/*
 * 税務期限エンジン（計算ロジック）
 *
 * 画面（index.html / app.js）から独立した純粋な計算モジュールです。
 * ブラウザ・Node.js・Google Apps Script・kintone のどれでも同じファイルを読み込めるよう、
 * 外部ライブラリを使わず、グローバル変数 DeadlineEngine または module.exports として公開します。
 *
 * 祝日データは引数で渡します（data/holidays.json の内容）。ファイル読み込みはこのモジュールでは行いません。
 *
 * 日付はすべて 'YYYY-MM-DD' 形式の文字列で扱い、タイムゾーンの影響を受けないよう内部では UTC で計算します。
 *
 * 各ルールの根拠条文は README.md の「根拠資料」に確認先を記載しています。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DeadlineEngine = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // しきい値（すべて円）
  // ---------------------------------------------------------------------------
  var THRESHOLDS = {
    // 法人税法71条1項ただし書：前期法人税額 ÷ 前期月数 × 6 が 10万円以下なら中間申告不要
    corpTaxInterim: 100000,
    // 消費税法42条1項ただし書：前期確定消費税額 ÷ 前期月数 が 400万円以下なら一月中間申告不要（年11回）
    consumptionMonthly: 4000000,
    // 消費税法42条4項ただし書：前期確定消費税額 ÷ 前期月数 × 3 が 100万円以下なら三月中間申告不要（年3回）
    consumptionQuarterly: 1000000,
    // 消費税法42条6項ただし書：前期確定消費税額 ÷ 前期月数 × 6 が 24万円以下なら六月中間申告不要（年1回）
    consumptionHalf: 240000,
  };

  var HOLIDAY_RULE_NATIONAL = '通法10②、通令2②';
  var HOLIDAY_RULE_LOCAL = '地方税法20の5②、地方税法施行令6の18②';

  // ---------------------------------------------------------------------------
  // 日付ユーティリティ
  // ---------------------------------------------------------------------------
  var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function toIso(date) {
    return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
  }

  function fromIso(iso) {
    var p = iso.split('-');
    return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  }

  function ymd(y, m, d) {
    return toIso(new Date(Date.UTC(y, m - 1, d)));
  }

  function addDays(iso, n) {
    var d = fromIso(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return toIso(d);
  }

  function weekdayOf(iso) {
    return WEEKDAYS[fromIso(iso).getUTCDay()];
  }

  // 「月の通し番号」= 年 × 12 + (月 − 1)。月をまたぐ計算を単純な足し算にするため。
  function monthIndex(y, m) {
    return y * 12 + (m - 1);
  }

  function yearOfIndex(idx) {
    return Math.floor(idx / 12);
  }

  function monthOfIndex(idx) {
    return (idx % 12) + 1;
  }

  // 通し番号 idx の月の末日
  function endOfMonth(idx) {
    return toIso(new Date(Date.UTC(yearOfIndex(idx), monthOfIndex(idx), 0)));
  }

  // 通し番号 idx の月の d 日
  function dayOfMonth(idx, d) {
    return ymd(yearOfIndex(idx), monthOfIndex(idx), d);
  }

  function monthLabel(idx) {
    return yearOfIndex(idx) + '年' + monthOfIndex(idx) + '月';
  }

  // 'YYYY年M月〜YYYY年M月分'（同じ月なら 'YYYY年M月分'）
  function periodLabel(fromIdx, toIdx) {
    if (fromIdx === toIdx) return monthLabel(fromIdx) + '分';
    return monthLabel(fromIdx) + '〜' + monthLabel(toIdx) + '分';
  }

  // ---------------------------------------------------------------------------
  // 休日判定（国税通則法10条2項・同施行令2条2項）
  //   日曜日、国民の祝日に関する法律に規定する休日、一般の休日（1/2・1/3。通則法基本通達10条関係4）、
  //   土曜日、12/29〜12/31 に当たるときは、その翌日を期限とみなす。
  //   → 翌日も休日なら、さらに翌日へ。結果として「翌日以後で最初の平日」になる。
  // ---------------------------------------------------------------------------
  function holidayMap(holidays) {
    if (!holidays) return {};
    // data/holidays.json の形式 { holidays: {...} } でも、{ 'YYYY-MM-DD': '名称' } でも受け付ける
    return holidays.holidays && typeof holidays.holidays === 'object' ? holidays.holidays : holidays;
  }

  // 休日ならその理由（文字列）、平日なら null
  function nonBusinessReason(iso, holidays) {
    var map = holidayMap(holidays);
    var md = iso.slice(5);
    if (map[iso]) return '祝日（' + map[iso] + '）';
    if (md === '01-02' || md === '01-03') return '年始の休日（' + Number(iso.slice(8)) + '日）';
    if (md === '12-29' || md === '12-30' || md === '12-31') return '年末の休日（12/' + Number(iso.slice(8)) + '）';
    var wd = fromIso(iso).getUTCDay();
    if (wd === 0) return '日曜日';
    if (wd === 6) return '土曜日';
    return null;
  }

  function isBusinessDay(iso, holidays) {
    return nonBusinessReason(iso, holidays) === null;
  }

  // iso が休日なら翌日以後で最初の平日を返す。平日ならそのまま。
  function adjustToBusinessDay(iso, holidays) {
    var d = iso;
    var guard = 0;
    while (!isBusinessDay(d, holidays)) {
      d = addDays(d, 1);
      if (++guard > 31) throw new Error('平日が見つかりません: ' + iso);
    }
    return d;
  }

  // ---------------------------------------------------------------------------
  // 期限項目の生成
  // ---------------------------------------------------------------------------
  function makeItem(statutoryDate, fields, holidays) {
    var dueDate = adjustToBusinessDay(statutoryDate, holidays);
    var holidayRule = fields.local ? HOLIDAY_RULE_LOCAL : HOLIDAY_RULE_NATIONAL;
    var item = {
      dueDate: dueDate,
      weekday: weekdayOf(dueDate),
      statutoryDate: statutoryDate,
      shifted: dueDate !== statutoryDate,
      shiftReason: dueDate !== statutoryDate ? nonBusinessReason(statutoryDate, holidays) : null,
      tax: fields.tax,
      procedure: fields.procedure,
      period: fields.period,
      basis: fields.basis,
      statutoryBasis: fields.basis, // 休日延長の条文を付ける前の根拠条文
      holidayRule: holidayRule,
      note: fields.note || '',
      category: fields.category,
      order: fields.order || 0,
    };
    if (item.shifted) {
      item.basis = item.basis + '（休日による延長: ' + holidayRule + '）';
    }
    return item;
  }

  function formatYen(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円';
  }

  // ---- 法人 -----------------------------------------------------------------

  // 法人税の中間申告の判定（法法71①）
  function corpTaxInterimRequired(prevCorpTax, prevMonths) {
    var amount = (prevCorpTax / prevMonths) * 6;
    return { required: amount > THRESHOLDS.corpTaxInterim, amount: amount };
  }

  // 消費税の中間申告の回数（消法42①④⑥）。0, 1, 3, 11 のいずれか。
  function consumptionInterimCount(prevConsumptionTax, prevMonths) {
    var monthly = prevConsumptionTax / prevMonths;
    if (monthly > THRESHOLDS.consumptionMonthly) return 11;
    if (monthly * 3 > THRESHOLDS.consumptionQuarterly) return 3;
    if (monthly * 6 > THRESHOLDS.consumptionHalf) return 1;
    return 0;
  }

  // 決算月 fiscalEndMonth、事業年度終了の年 endYear の事業年度について期限を作る
  function corporateFiscalYearItems(input, endYear, holidays) {
    var items = [];
    var e = monthIndex(endYear, input.fiscalEndMonth); // 事業年度の最終月
    var s = e - 11; // 事業年度の開始月（12か月の事業年度を前提）
    var fyLabel = monthLabel(s) + '〜' + monthLabel(e) + '期';
    var prevMonths = input.prevFiscalMonths || 12;

    // 法人税の確定申告（法法74①、延長特例は法法75の2①）
    var corpExt = !!input.corpTaxExtension;
    items.push(
      makeItem(
        endOfMonth(e + (corpExt ? 3 : 2)),
        {
          tax: '法人税・地方法人税',
          procedure: '確定申告・納付' + (corpExt ? '（申告期限の延長特例: +1か月）' : ''),
          period: fyLabel,
          basis: corpExt ? '法法74①、75の2①' : '法法74①',
          note: corpExt
            ? '延長期間の法人税には利子税がかかります。延長月数は1か月で計算しています（会計監査人設置法人等の最大4か月延長は未対応）。'
            : '',
          category: 'corp-tax',
          order: 10,
        },
        holidays,
      ),
    );

    // 法人税の中間申告（法法71①）
    if (input.prevCorpTax != null) {
      var ct = corpTaxInterimRequired(input.prevCorpTax, prevMonths);
      if (ct.required) {
        items.push(
          makeItem(
            endOfMonth(s + 7), // 6月経過日（開始月+6か月の初日）から2月以内
            {
              tax: '法人税・地方法人税',
              procedure: '中間申告・納付',
              period: fyLabel + '（' + periodLabel(s, s + 5) + '）',
              basis: '法法71①',
              note:
                '前期法人税額（入力値）×6/' + prevMonths + ' = ' + formatYen(ct.amount) +
                ' > 10万円のため必要。仮決算による中間申告（法法72）も選択可。',
              category: 'corp-tax',
              order: 11,
            },
            holidays,
          ),
        );
      }
    }

    // 消費税の確定申告（消法45①、延長特例は消法45の2①）
    // 消費税の延長特例は、法人税の延長特例を受けている法人だけが使える（消法45の2①）
    var consExt = !!input.consumptionTaxExtension && corpExt;
    items.push(
      makeItem(
        endOfMonth(e + (consExt ? 3 : 2)),
        {
          tax: '消費税・地方消費税',
          procedure: '確定申告・納付' + (consExt ? '（申告期限の延長特例: +1か月）' : ''),
          period: fyLabel,
          basis: consExt ? '消法45①、45の2①' : '消法45①',
          note: consExt ? '延長期間の消費税には利子税がかかります。' : '',
          category: 'consumption-tax',
          order: 20,
        },
        holidays,
      ),
    );

    // 消費税の中間申告（消法42）
    if (input.prevConsumptionTax != null) {
      var count = consumptionInterimCount(input.prevConsumptionTax, prevMonths);
      var baseNote = '前期確定消費税額（国税分・入力値）' + formatYen(input.prevConsumptionTax) + 'に基づき年' + count + '回。';
      if (count === 1) {
        items.push(
          makeItem(
            endOfMonth(s + 7),
            {
              tax: '消費税・地方消費税',
              procedure: '中間申告・納付（年1回）',
              period: fyLabel + '（' + periodLabel(s, s + 5) + '）',
              basis: '消法42⑥',
              note: baseNote,
              category: 'consumption-tax',
              order: 21,
            },
            holidays,
          ),
        );
      } else if (count === 3) {
        for (var q = 0; q < 3; q++) {
          var qEnd = s + q * 3 + 2;
          items.push(
            makeItem(
              endOfMonth(qEnd + 2),
              {
                tax: '消費税・地方消費税',
                procedure: '中間申告・納付（年3回・第' + (q + 1) + '回）',
                period: fyLabel + '（' + periodLabel(qEnd - 2, qEnd) + '）',
                basis: '消法42④',
                note: baseNote,
                category: 'consumption-tax',
                order: 21,
              },
              holidays,
            ),
          );
        }
      } else if (count === 11) {
        for (var k = 0; k < 11; k++) {
          var due;
          var basis = '消法42①';
          var note = baseNote;
          if (consExt && k <= 1) {
            // 延長特例法人：開始後2か月分は「開始日から3月を経過した日から2月以内」（国税庁タックスアンサーNo.6609 注5）
            due = endOfMonth(s + 4);
            basis = '消法42①（延長特例法人の取扱い: 国税庁タックスアンサーNo.6609 注5）';
            note += '消費税の延長特例を受けているため、開始後2か月分の期限が後ろにずれます。';
          } else if (k === 0) {
            // 開始後1か月分は「開始日から2月を経過した日から2月以内」（消法42①かっこ書）
            due = endOfMonth(s + 3);
          } else {
            due = endOfMonth(s + k + 2);
          }
          items.push(
            makeItem(
              due,
              {
                tax: '消費税・地方消費税',
                procedure: '中間申告・納付（年11回・第' + (k + 1) + '回）',
                period: fyLabel + '（' + periodLabel(s + k, s + k) + '）',
                basis: basis,
                note: note,
                category: 'consumption-tax',
                order: 21,
              },
              holidays,
            ),
          );
        }
      }
    }
    return items;
  }

  // ---- 個人 -----------------------------------------------------------------

  // 暦年 taxYear 分の所得税・消費税と、その年の予定納税
  function individualYearItems(taxYear, holidays) {
    var next = taxYear + 1;
    return [
      makeItem(
        ymd(next, 3, 15),
        {
          tax: '所得税・復興特別所得税',
          procedure: '確定申告・納付',
          period: taxYear + '年分',
          basis: '所法120①',
          note: '申告期間は原則2/16から。納付期限も同日（国税庁タックスアンサーNo.2020）。',
          category: 'income-tax',
          order: 10,
        },
        holidays,
      ),
      makeItem(
        ymd(next, 3, 31),
        {
          tax: '消費税・地方消費税',
          procedure: '確定申告・納付',
          period: taxYear + '年分',
          basis: '措法86の4①',
          note: '課税事業者の場合。',
          category: 'consumption-tax',
          order: 20,
        },
        holidays,
      ),
      makeItem(
        ymd(taxYear, 7, 31),
        {
          tax: '所得税・復興特別所得税',
          procedure: '予定納税（第1期）',
          period: taxYear + '年分',
          basis: '所法104①',
          note: '予定納税基準額が15万円以上の場合（6/15までに税務署から通知）。納期は7/1〜7/31。',
          category: 'income-tax',
          order: 11,
        },
        holidays,
      ),
      makeItem(
        ymd(taxYear, 11, 30),
        {
          tax: '所得税・復興特別所得税',
          procedure: '予定納税（第2期）',
          period: taxYear + '年分',
          basis: '所法104①',
          note: '予定納税基準額が15万円以上の場合（6/15までに税務署から通知）。納期は11/1〜11/30。',
          category: 'income-tax',
          order: 11,
        },
        holidays,
      ),
    ];
  }

  // ---- 共通（法人・個人） --------------------------------------------------

  // 源泉所得税（原則: 支払月の翌月10日）。支払月 payIdx の分。
  function withholdingMonthlyItem(payIdx, holidays) {
    return makeItem(
      dayOfMonth(payIdx + 1, 10),
      {
        tax: '源泉所得税・復興特別所得税',
        procedure: '納付',
        period: monthLabel(payIdx) + '支払分',
        basis: '所法183①、199、204①ほか',
        note: '',
        category: 'withholding',
        order: 30,
      },
      holidays,
    );
  }

  // 源泉所得税の納期の特例（所法216）。暦年 payYear の上期・下期。
  function withholdingSpecialItems(payYear, holidays) {
    var note =
      '納期の特例の対象は給与・退職手当等と所法204①二の報酬・料金（税理士・弁護士等）に限られます。それ以外の源泉所得税は翌月10日が期限です。';
    return [
      makeItem(
        ymd(payYear, 7, 10),
        {
          tax: '源泉所得税・復興特別所得税',
          procedure: '納付（納期の特例）',
          period: payYear + '年1月〜6月支払分',
          basis: '所法216',
          note: note,
          category: 'withholding',
          order: 30,
        },
        holidays,
      ),
      makeItem(
        ymd(payYear + 1, 1, 20),
        {
          tax: '源泉所得税・復興特別所得税',
          procedure: '納付（納期の特例）',
          period: payYear + '年7月〜12月支払分',
          basis: '所法216',
          note: note,
          category: 'withholding',
          order: 30,
        },
        holidays,
      ),
    ];
  }

  // 1/31 期限の3手続（償却資産申告・法定調書・給与支払報告書）。dueYear 年の1/31 期限分。
  function january31Items(dueYear, holidays) {
    var prev = dueYear - 1;
    var hoteiNote = '主な法定調書（源泉徴収票・支払調書等）と合計表。';
    if (dueYear >= 2027) {
      hoteiNote +=
        '令和9年1月1日以後に提出する給与所得の源泉徴収票は、市区町村へ給与支払報告書を提出すれば税務署へ提出したものとみなされます（国税庁タックスアンサーNo.7411）。';
    }
    return [
      makeItem(
        ymd(dueYear, 1, 31),
        {
          tax: '固定資産税（償却資産）',
          procedure: '償却資産申告（市町村）',
          period: dueYear + '年1月1日現在',
          basis: '地方税法383',
          note: '事業用の償却資産を所有している場合。',
          category: 'local',
          local: true,
          order: 40,
        },
        holidays,
      ),
      makeItem(
        ymd(dueYear, 1, 31),
        {
          tax: '所得税（法定調書）',
          procedure: '法定調書・同合計表の提出（税務署）',
          period: prev + '年支払分',
          basis: '所法225①、226①ほか',
          note: hoteiNote,
          category: 'statutory-report',
          order: 41,
        },
        holidays,
      ),
      makeItem(
        ymd(dueYear, 1, 31),
        {
          tax: '個人住民税',
          procedure: '給与支払報告書の提出（市町村）',
          period: prev + '年支払分',
          basis: '地方税法317の6①',
          note: '',
          category: 'local',
          local: true,
          order: 42,
        },
        holidays,
      ),
    ];
  }

  // ---------------------------------------------------------------------------
  // 入力チェック
  // ---------------------------------------------------------------------------
  function validate(input) {
    var errors = [];
    if (!input || typeof input !== 'object') return ['入力がありません。'];
    if (input.entityType !== 'corporation' && input.entityType !== 'individual') {
      errors.push('区分は corporation（法人）または individual（個人）を指定してください。');
    }
    if (!Number.isInteger(input.year) || input.year < 1900 || input.year > 2999) {
      errors.push('対象年は西暦の整数で指定してください。');
    }
    if (input.entityType === 'corporation') {
      if (!Number.isInteger(input.fiscalEndMonth) || input.fiscalEndMonth < 1 || input.fiscalEndMonth > 12) {
        errors.push('決算月は1〜12の整数で指定してください。');
      }
      ['prevCorpTax', 'prevConsumptionTax'].forEach(function (key) {
        var v = input[key];
        if (v != null && (typeof v !== 'number' || !isFinite(v) || v < 0)) {
          errors.push(key + ' は0以上の数値で指定してください（未入力は null）。');
        }
      });
      if (input.prevFiscalMonths != null) {
        var pm = input.prevFiscalMonths;
        if (!Number.isInteger(pm) || pm < 1 || pm > 12) errors.push('前期の月数は1〜12の整数で指定してください。');
      }
    }
    return errors;
  }

  // ---------------------------------------------------------------------------
  // メイン
  // ---------------------------------------------------------------------------

  /**
   * 対象年（1月1日〜12月31日）に期限が到来する申告・納付の一覧を返す。
   *
   * @param {object} input
   *   entityType               'corporation' | 'individual'
   *   year                     対象年（西暦）
   *   withholdingSpecial       源泉所得税の納期の特例の承認あり
   *   -- 法人のみ --
   *   fiscalEndMonth           決算月（1〜12。事業年度は12か月、末日決算を前提）
   *   corpTaxExtension         法人税の申告期限の延長特例あり
   *   consumptionTaxExtension  消費税の申告期限の延長特例あり（法人税の延長特例が前提）
   *   prevCorpTax              前期の法人税額（円）。null なら中間申告を判定しない
   *   prevConsumptionTax       前期の確定消費税額（国税分、円）。null なら中間申告を判定しない
   *   prevFiscalMonths         前期の月数（省略時12）
   * @param {object} options
   *   holidays                 祝日データ（data/holidays.json の内容、または { 'YYYY-MM-DD': '名称' }）
   * @returns {{ items: object[], warnings: string[] }}
   */
  function computeDeadlines(input, options) {
    var errors = validate(input);
    if (errors.length) {
      var err = new Error(errors.join('\n'));
      err.validationErrors = errors;
      throw err;
    }
    var holidays = (options && options.holidays) || null;
    var year = input.year;
    var warnings = [];
    var candidates = [];

    if (!holidays) {
      warnings.push('祝日データが渡されていないため、土日・年末年始のみで休日判定しています。');
    } else if (holidays.firstYear != null && (year < holidays.firstYear || year > holidays.lastYear)) {
      warnings.push(
        year + '年の祝日データがありません（同梱データは' + holidays.firstYear + '〜' + holidays.lastYear +
          '年）。祝日による延長が反映されていない可能性があります。data/holidays.json を更新してください。',
      );
    }

    if (input.entityType === 'corporation') {
      // 対象年に期限が来うる事業年度（前年・当年・翌年に終了する事業年度）をまとめて計算し、後で絞り込む
      for (var endYear = year - 1; endYear <= year + 1; endYear++) {
        candidates = candidates.concat(corporateFiscalYearItems(input, endYear, holidays));
      }
      if (input.consumptionTaxExtension && !input.corpTaxExtension) {
        warnings.push(
          '消費税の申告期限の延長特例は、法人税の申告期限の延長特例を受けている法人だけが使えます（消法45の2①）。消費税は延長なしで計算しました。',
        );
      }
      if (input.prevCorpTax == null) {
        warnings.push('前期の法人税額が未入力のため、法人税の中間申告は判定していません。');
      } else if (!corpTaxInterimRequired(input.prevCorpTax, input.prevFiscalMonths || 12).required) {
        warnings.push('法人税の中間申告は不要と判定しました（前期法人税額×6/前期月数が10万円以下。法法71①ただし書）。');
      }
      if (input.prevConsumptionTax == null) {
        warnings.push('前期の消費税額が未入力のため、消費税の中間申告は判定していません。');
      } else if (consumptionInterimCount(input.prevConsumptionTax, input.prevFiscalMonths || 12) === 0) {
        warnings.push(
          '消費税の中間申告は不要と判定しました（前期確定消費税額が年換算48万円以下）。任意の中間申告制度（消法42⑧）を届け出ている場合は年1回の中間申告が必要です。',
        );
      }
      if (input.prevCorpTax != null || input.prevConsumptionTax != null) {
        warnings.push(
          '中間申告は、入力した前期税額を対象年に期限が来るすべての中間申告に当てはめて判定しています。基礎となる「直前の事業年度」が異なる中間申告（例: 前年度分の年11回中間申告の最終回）が含まれる場合は、その事業年度の実績で確認してください。',
        );
      }
    } else {
      for (var taxYear = year - 1; taxYear <= year; taxYear++) {
        candidates = candidates.concat(individualYearItems(taxYear, holidays));
      }
    }

    // 源泉所得税
    if (input.withholdingSpecial) {
      for (var py = year - 1; py <= year; py++) {
        candidates = candidates.concat(withholdingSpecialItems(py, holidays));
      }
    } else {
      for (var idx = monthIndex(year - 1, 11); idx <= monthIndex(year, 12); idx++) {
        candidates.push(withholdingMonthlyItem(idx, holidays));
      }
    }

    // 1/31 期限の手続
    for (var dy = year; dy <= year + 1; dy++) {
      candidates = candidates.concat(january31Items(dy, holidays));
    }

    var from = ymd(year, 1, 1);
    var to = ymd(year, 12, 31);
    var items = candidates.filter(function (it) {
      return it.dueDate >= from && it.dueDate <= to;
    });
    items.sort(function (a, b) {
      if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      if (a.order !== b.order) return a.order - b.order;
      return a.period < b.period ? -1 : a.period > b.period ? 1 : 0;
    });
    items.forEach(function (it) {
      delete it.order;
    });
    return { items: items, warnings: warnings };
  }

  // ---------------------------------------------------------------------------
  // CSV 書き出し
  // ---------------------------------------------------------------------------
  var CSV_COLUMNS = [
    ['期限日', 'dueDate'],
    ['曜日', 'weekday'],
    ['法定の期限（休日調整前）', 'statutoryDate'],
    ['税目', 'tax'],
    ['手続', 'procedure'],
    ['対象期間', 'period'],
    ['根拠条文', 'basis'],
    ['備考', 'note'],
  ];

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // 期限一覧を CSV 文字列にする（改行は CRLF。Excel 向けの BOM は呼び出し側で付ける）
  function toCsv(items) {
    var lines = [CSV_COLUMNS.map(function (c) { return csvCell(c[0]); }).join(',')];
    items.forEach(function (it) {
      lines.push(CSV_COLUMNS.map(function (c) { return csvCell(it[c[1]]); }).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  return {
    computeDeadlines: computeDeadlines,
    toCsv: toCsv,
    adjustToBusinessDay: adjustToBusinessDay,
    isBusinessDay: isBusinessDay,
    nonBusinessReason: nonBusinessReason,
    corpTaxInterimRequired: corpTaxInterimRequired,
    consumptionInterimCount: consumptionInterimCount,
    validate: validate,
    THRESHOLDS: THRESHOLDS,
  };
});
