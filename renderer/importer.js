'use strict';

/**
 * 账单导入引擎（renderer/importer.js）
 * 解析支付宝 / 微信支付 / 各银行导出的 CSV 流水文件，输出统一的交易行数组。
 *
 * 设计说明：
 * - 不依赖 app.js：可选分类列表通过 opts.cats(type) 注入；
 * - 表头按关键词识别列（不写死列序），兼容各版本账单的格式差异；
 * - 收支方向判定优先级：方向列（收/支、借贷方向） > 借贷金额两列 > 金额正负 > 摘要关键词；
 * - 「收/支 = 其他 / / 」（自转账、余额充值等）识别为「不计收支」，默认不导入；
 *   但其中的还款类（还信用卡、还花呗…）判为支出，退款类与收益发放类判为收入；
 * - 交易状态为关闭/失败/含退款的记录默认不导入，但保留在预览里可手动勾选；
 *   含退款的记录会预填为收入（钱已退回）。
 *
 * 对外 API：
 *   Stmt.decode(bytes)                      字节 → 文本（BOM / UTF-8 / GBK / UTF-16）
 *   Stmt.parse(text, opts)                  文本 → { source, sourceLabel, rows, skipped } 或 { error }
 *   Stmt.autoCategory(type, text, hint, av) 关键词自动分类（返回 av 中的分类名）
 *   Stmt.fingerprint(tx)                    查重指纹：日期|类型|金额|备注
 */
const Stmt = (function () {

  /* ================= 编码识别 ================= */

  function toU8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (Array.isArray(bytes)) return new Uint8Array(bytes);
    if (bytes && bytes.type === 'Buffer' && Array.isArray(bytes.data)) return new Uint8Array(bytes.data);
    if (bytes && bytes.buffer) return new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength);
    return new Uint8Array(0);
  }

  /** 按 BOM / 严格 UTF-8 / GB18030 的顺序解码账单文件 */
  function decode(bytes) {
    if (typeof bytes === 'string') return bytes;
    const u8 = toU8(bytes);
    try {
      if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
        return new TextDecoder('utf-8').decode(u8.subarray(3));
      }
      if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) {
        return new TextDecoder('utf-16le').decode(u8.subarray(2));
      }
      if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) {
        return new TextDecoder('utf-16be').decode(u8.subarray(2));
      }
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(u8);
      } catch (_) { /* 非 UTF-8，继续尝试中文编码 */ }
      const encs = ['gb18030', 'gbk', 'big5'];
      for (let i = 0; i < encs.length; i++) {
        try { return new TextDecoder(encs[i]).decode(u8); } catch (_) { /* 尝试下一种 */ }
      }
    } catch (_) { /* TextDecoder 不可用：逐字节降级 */ }
    try { return new TextDecoder('utf-8').decode(u8); } catch (_) { /* 最终兜底 */ }
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  /* ================= CSV ================= */

  /** 依据前若干行里「出现 ≥3 次分隔符」的行数挑选分隔符（, / tab / ;） */
  function pickDelimiter(text) {
    const lines = text.slice(0, 12000).split(/\r?\n/).filter((l) => l.trim()).slice(0, 40);
    const cands = [',', '\t', ';'];
    let best = ',', bestScore = 0;
    for (const d of cands) {
      let score = 0;
      for (const l of lines) if (l.split(d).length >= 4) score++;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  /** 支持引号字段（含 "" 转义与跨行字段）的 CSV 解析 */
  function parseCsv(text, delim) {
    const rows = [];
    let row = [], cell = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else inQ = false;
        } else cell += c;
      } else if (c === '"') {
        inQ = true;
      } else if (c === delim) {
        row.push(cell); cell = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /* ================= 单元格解析 ================= */

  const pad2s = (n) => String(n).padStart(2, '0');
  const getCell = (cells, i) => (i >= 0 && cells && i < cells.length ? cells[i] : null);
  const cellText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  /** 2024-01-05 / 2024/1/5 / 2024年1月5日 / 20240105 / 01-05-2024(月-日-年) → YYYY-MM-DD */
  function parseDateCell(v) {
    const s = cellText(v);
    if (!s) return null;
    let m = s.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2s(mo)}-${pad2s(d)}`;
      return null;
    }
    m = s.match(/(\d{4})(\d{2})(\d{2})/); // 20240105 / 时间戳前 8 位
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3];
      if (y >= 1990 && y <= 2999 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2s(mo)}-${pad2s(d)}`;
    }
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); // 01/05/2024（月/日/年）
    if (m) {
      const mo = +m[1], d = +m[2];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${m[3]}-${pad2s(mo)}-${pad2s(d)}`;
    }
    return null;
  }

  /** ¥1,234.56 / -12.50 / （12.50）/ 12.50元 → 数值（可能为负） */
  function parseAmount(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = cellText(v);
    if (!s || s === '-' || s === '—' || s === '/' || s === '¥' || s === '￥') return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/^（.*）$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[¥￥$€£,，\s]/g, '').replace(/^(人民币|RMB|CNY)/i, '');
    if (s[0] === '+') s = s.slice(1);
    if (s[0] === '-') { neg = true; s = s.slice(1); }
    s = s.replace(/元$/, '');
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }

  /* ================= 表头识别与列映射 ================= */

  const HEADER_HINTS = [
    '交易时间', '交易日期', '记账日期', '交易日', '日期', '交易对方', '对方户名', '对方名称',
    '收付方名称', '商品说明', '商品名称', '摘要', '说明', '用途', '收/支', '借贷方向',
    '收付标志', '方向', '金额', '发生额', '余额', '交易状态', '当前状态', '状态',
    '支付方式', '收/付款方式', '交易分类', '交易类型', '类型', '备注', '交易单号',
    '商家订单号', '交易号', '凭证号', '借方', '贷方', '时间'
  ];

  function headerScore(cells) {
    let score = 0;
    for (const raw of cells) {
      const c = cellText(raw);
      if (c && HEADER_HINTS.some((h) => c.includes(h))) score++;
    }
    return score;
  }

  /** 表头行 = 前 40 行里命中关键词最多的行（并列时取最靠前的） */
  function findHeaderIdx(rows) {
    let best = -1, bestScore = 2;
    const n = Math.min(rows.length, 40);
    for (let i = 0; i < n; i++) {
      const s = headerScore(rows[i]);
      if (s > bestScore) { bestScore = s; best = i; }
    }
    return best;
  }

  /** 按关键词把表头映射到各语义列（返回列下标，-1 表示没有） */
  function mapColumns(header) {
    const h = header.map((c) => cellText(c).replace(/\s/g, ''));
    const pick = (patterns) => {
      for (const p of patterns) {
        for (let i = 0; i < h.length; i++) if (h[i] && p.test(h[i])) return i;
      }
      return -1;
    };
    return {
      // 日期列优先取「日期」型列；「交易时间」列（可能只是 HH:mm:ss）作为兜底
      date: pick([/交易日期/, /记账日期/, /账单日期/, /^日期$/, /交易日/, /记账日/, /日期/, /交易时间/, /记账时间/, /^时间$/, /时间/]),
      time: pick([/交易时间/, /记账时间/, /^时间$/, /时间/]),
      cp: pick([/交易对方/, /对方户名/, /对方名称/, /收.?付方名称/, /交易对手/, /收款人/, /付款人/, /对方信息/, /对方/]),
      desc: pick([/商品说明/, /商品名称/, /^商品$/, /交易摘要/, /^摘要$/, /摘要/, /交易内容/, /说明/, /用途/, /^项目$/]),
      note: pick([/^备注$/, /备注/, /附言/, /^摘要$/, /摘要/]),
      dir: pick([/收.?.?支/, /借贷方向/, /收付标志/, /收支标志/, /借贷标志/, /收付方向/, /收支方向/, /^方向$/, /资金流向/, /借贷/]),
      debit: pick([/借方发生额/, /借方金额/, /借方.*额/, /^借方$/, /支出金额/, /付出金额/]),
      credit: pick([/贷方发生额/, /贷方金额/, /贷方.*额/, /^贷方$/, /收入金额/, /入账金额/]),
      // 排除借/贷两列，避免把「借方金额」当成总金额
      amount: pick([/^(?!(借|贷)).*(金额|发生额)([（(](元|人民币|RMB|CNY)[）)])?$/]),
      status: pick([/交易状态/, /当前状态/, /^状态$/]),
      cat: pick([/交易分类/, /交易类型/, /^分类$/, /^类型$/]),
      balance: pick([/^余额$/, /余额/]),
      pay: pick([/收.?付款方式/, /支付方式/, /付款方式/, /出入账渠道/, /渠道/])
    };
  }

  const SOURCE_LABELS = { wechat: '微信支付', alipay: '支付宝', bank: '银行流水', generic: '通用账单' };

  /** 识别来源：先看表头特征（更可靠），再看文件开头文本 */
  function detectSource(text, header) {
    const h = header.join(',');
    if (/当前状态/.test(h) && /交易单号/.test(h)) return 'wechat';
    if (/商家订单号/.test(h) || (/交易分类/.test(h) && /收.?付款方式/.test(h))) return 'alipay';
    const head = text.slice(0, 600);
    if (/微信支付|微信账单/.test(head)) return 'wechat';
    if (/支付宝/.test(head)) return 'alipay';
    if (/收.?.?支/.test(h)) return 'generic';
    return 'bank';
  }

  /* ================= 收支方向 ================= */

  /** 方向列取值 → 'expense' | 'income' | 'neutral' | null（null = 空值/无法识别） */
  function dirToType(v) {
    const s = cellText(v);
    if (!s) return null;
    if (/^(支出|付款|付出|出账|转出|借方|借|出|付|D|Dr|DEBIT)$/i.test(s)) return 'expense';
    if (/^(收入|收款|进账|入账|转入|贷方|贷|入|收|C|Cr|CREDIT)$/i.test(s)) return 'income';
    if (/^(其他|其它|不计收支|不计|中性|—|–|-|\/|\/\/|N\/A|NA)$/i.test(s)) return 'neutral';
    if (/支出|付款|借方|转出|出账|扣款|支出方/.test(s)) return 'expense';
    if (/收入|收款|贷方|转入|入账|进账/.test(s)) return 'income';
    if (/其他|不计|中性/.test(s)) return 'neutral';
    return null;
  }

  const OUT_KW = /(支出|消费|转出|转账至|转出至|支取|取现|提现|还款|还卡|还贷|缴费|代扣|扣款|划扣|支付|付款|网购|充值|冲正|预授权|汇出|采购|手续费|年费|代缴|划转)/;
  const IN_KW = /(收入|工资|薪资|发薪|转入|存入|收款|入账|退款|返还|利息|红利|分红|奖金|报销|汇入|收到|进项|收益|结息)/;

  /** 没有方向列的银行流水：靠摘要 / 交易类型关键词猜测 */
  function guessType(text) {
    if (OUT_KW.test(text)) return 'expense';
    if (IN_KW.test(text)) return 'income';
    return null;
  }

  /*
   * 「不计收支」/ 无方向条目的兜底判向：
   * 账单里还款（还信用卡 / 还花呗等）、退款、收益发放通常收/支列为「其他 / /」，
   * 但按记账习惯它们应分别计入支出 / 收入 / 收入。自转账、余额充值等仍保持不计收支。
   */
  const NEUTRAL_REFUND_KW = /(退款|退货|退还|退单|理赔|退运费|运费险|先行赔付)/;
  const NEUTRAL_IN_KW = /(收益发放|收益到账|收益|派息|分红|红利|结息|利息|生息|理财到账|基金分红|红包到账)/;
  const NEUTRAL_OUT_KW = /(还款|还贷|还卡|还信用卡|还花呗|还借呗|分期还款|提前还款|代还)/;

  /** 中性 / 无方向条目 → 'expense' | 'income' | null（null = 保持不计收支） */
  function refineNeutralType(text) {
    if (NEUTRAL_REFUND_KW.test(text)) return 'income'; // 退款：钱退回来，计收入
    if (NEUTRAL_IN_KW.test(text)) return 'income';     // 收益 / 分红 / 结息发放：计收入
    if (NEUTRAL_OUT_KW.test(text)) return 'expense';  // 还款：还出去的钱，计支出
    return null;
  }

  const BAD_STATUS = /(关闭|失败|取消|撤销|作废|拒绝|未支付|待支付|等待付款|待付款|超时|已过期|失效)/;
  const REFUND_STATUS = /(退款|退货|退还|冲正)/;

  /* ================= 自动分类 ================= */

  const TEXT_RULES = {
    expense: [
      [/(还款|还贷|还卡|还信用卡|还花呗|还借呗|借呗|分期还款|提前还款|微粒贷|安逸花|度小满|信用贷)/, '还款'],
      [/(美团|饿了么|肯德基|KFC|麦当劳|汉堡王|德克士|必胜客|星巴克|瑞幸|喜茶|奈雪|蜜雪|茶百道|CoCo|海底捞|呷哺|火锅|烧烤|烤肉|串串|麻辣烫|米线|面馆|餐厅|饭店|饭馆|小吃|快餐|食堂|外卖|咖啡|奶茶|烘焙|蛋糕|面包|果汁|水果|生鲜|果蔬|菜市场|农贸|沙县|黄焖鸡|兰州拉面|早餐|午饭|晚饭|夜宵|酒楼|酒家|西餐|日料|寿司|披萨|轻食|大排档)/i, '餐饮'],
      [/(滴滴|嘀嗒|花小猪|打车|出租车|快车|专车|地铁|公交|巴士|高铁|动车|火车|铁路|12306|航空|机票|机场|航班|东方航空|南方航空|春秋航空|加油|中石油|中石化|壳牌|停车|车位|高速|ETC|通行费|共享单车|哈啰|青桔|汽车票|船票|轮渡|租车|代驾|顺风车)/, '交通'],
      [/(房租|租金|物业|水费|电费|燃气|暖气|供暖|宽带|网费|水电|房东|公寓|污水处理)/, '居住'],
      [/(医院|药房|药店|诊所|体检|口腔|眼科|牙科|医疗|药品|疾控|卫生服务|防疫)/, '医疗'],
      [/(书店|图书|书籍|教材|课程|培训|学费|网课|教育|学校|幼儿园|文具|考试|考证|驾校)/, '教育'],
      [/(随礼|份子|礼金|随份|婚礼|婚宴|答谢|人情|红包|压岁钱|奠仪)/, '人情'],
      [/(电影|影城|影院|KTV|游戏|健身|运动|会员|视频|音乐|爱奇艺|优酷|腾讯视频|芒果TV|B站|哔哩|网易云|QQ音乐|门票|景区|旅游|酒店|民宿|度假|乐园|剧本杀|桌游|网吧|展览|演唱会)/i, '娱乐'],
      [/(淘宝|天猫|京东|拼多多|唯品会|苏宁|国美|亚马逊|当当|严选|小米商城|华为商城|商场|百货|超市|便利店|全家|罗森|7-11|711|服装|鞋帽|童装|数码|电器|家居|母婴|化妆品|护肤|美妆|日用品|烟酒|杂货)/i, '购物']
    ],
    income: [
      [/(工资|薪资|发薪|月薪|薪金|代发)/, '工资'],
      [/(奖金|年终|绩效|过节费|补贴|津贴|提成|奖励)/, '奖金'],
      [/(兼职|稿费|稿酬|讲课费|劳务费|外快|临时工|跑腿|打赏)/, '兼职'],
      [/(收益|分红|利息|结息|理财|基金|股票|股息|红利|余额宝|零钱通|证券|黄金|派息|债)/, '投资'],
      [/(红包|转账|收款|抢红包|汇款)/, '红包']
    ]
  };

  const HINT_RULES = {
    expense: [
      [/(餐饮|美食|食品|外卖)/, '餐饮'],
      [/(出行|交通|用车|打车|加油|航班|铁路|汽车)/, '交通'],
      [/(住房|房租|物业|缴费|水电|生活服务)/, '居住'],
      [/(医疗|健康|医药|药品)/, '医疗'],
      [/(教育|培训|学习|图书)/, '教育'],
      [/(还款|信贷|信用|借贷)/, '还款'],
      [/(人情|往来|婚礼|礼品)/, '人情'],
      [/(娱乐|休闲|运动|健身|影视|旅游|旅行|酒店)/, '娱乐'],
      [/(日用|百货|商超|超市|便利|购物|网购|服饰|数码|电器|美妆|母婴)/, '购物'],
      [/(红包|转账)/, '人情']
    ],
    income: [
      [/(工资|薪酬|劳务)/, '工资'],
      [/(奖金|绩效|奖励)/, '奖金'],
      [/(理财|投资|金融|收益)/, '投资'],
      [/(红包|转账|收款)/, '红包'],
      [/(兼职|稿酬)/, '兼职']
    ]
  };

  /**
   * 自动分类：先按说明文本关键词，再按账单自带分类（如支付宝「交易分类」），
   * 最后落到「其他」；结果保证落在可用分类列表 avail 内。
   */
  function autoCategory(type, text, hint, avail) {
    const list = Array.isArray(avail) ? avail : [];
    const match = (rules) => {
      const arr = rules[type] || [];
      for (let i = 0; i < arr.length; i++) if (arr[i][0].test(text || '')) return arr[i][1];
      return null;
    };
    let cat = match(TEXT_RULES) || match(HINT_RULES) || '其他';
    if (list.length) {
      if (list.includes(cat)) return cat;
      if (list.includes('其他')) return '其他';
      return list[0];
    }
    return cat;
  }

  /* ================= 查重指纹 ================= */

  function fingerprint(t) {
    const amt = (Math.round((Number(t.amount) || 0) * 100) / 100).toFixed(2);
    const note = String(t.note == null ? '' : t.note).replace(/\s+/g, '');
    return `${t.date}|${t.type}|${amt}|${note}`;
  }

  /* ================= 主入口 ================= */

  /**
   * 解析账单文本。
   * opts.cats(type) → 该类型的可用分类数组（用于自动分类兜底）
   * 返回 { source, sourceLabel, rows, skipped } 或 { error }
   */
  function parse(text, opts) {
    const catsOf = opts && typeof opts.cats === 'function' ? opts.cats : null;
    text = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    if (!text.trim()) return { error: '文件内容为空' };

    const rows = parseCsv(text, pickDelimiter(text));
    if (!rows.length) return { error: '无法解析该文件：不是有效的 CSV 明细' };

    const hi = findHeaderIdx(rows);
    if (hi < 0) return { error: '未找到表头行：请使用支付宝 / 微信支付 / 网银导出的 CSV 明细文件' };

    const header = rows[hi];
    const cols = mapColumns(header);
    const source = detectSource(text, header);
    if (cols.date < 0 || (cols.amount < 0 && cols.debit < 0 && cols.credit < 0)) {
      return { error: '未能识别「日期」或「金额」列，暂不支持该账单格式', source, sourceLabel: SOURCE_LABELS[source] };
    }

    const out = [];
    let skipped = 0;

    for (let i = hi + 1; i < rows.length; i++) {
      const cells = rows[i];
      if (!cells || !cells.some((c) => cellText(c))) continue; // 空行

      const date = parseDateCell(getCell(cells, cols.date)) ||
        (cols.time >= 0 && cols.time !== cols.date ? parseDateCell(getCell(cells, cols.time)) : null);
      if (!date) { skipped++; continue; } // 合计行、分隔线、页脚等

      // ---- 金额 ----
      let debit = 0, credit = 0;
      if (cols.debit >= 0) debit = Math.abs(parseAmount(getCell(cells, cols.debit)) || 0);
      if (cols.credit >= 0) credit = Math.abs(parseAmount(getCell(cells, cols.credit)) || 0);
      let raw = null;
      if ((debit > 0 || credit > 0) && cols.amount < 0) raw = debit > 0 ? debit : credit; // 只有借/贷两列
      if (raw == null && cols.amount >= 0) raw = parseAmount(getCell(cells, cols.amount));
      if (raw == null && (debit > 0 || credit > 0)) raw = debit > 0 ? debit : credit;
      if (raw == null || !(Math.abs(raw) > 0)) { skipped++; continue; }
      const amount = Math.round(Math.abs(raw) * 100) / 100;

      // ---- 说明文本（判向与分类都要用） ----
      const parts = [getCell(cells, cols.cp), getCell(cells, cols.desc), getCell(cells, cols.note)]
        .map(cellText)
        .filter((x) => x && x !== '-' && x !== '—');
      const note = parts.filter((x, i) => parts.indexOf(x) === i).join(' · ').slice(0, 80);
      const hint = cellText(getCell(cells, cols.cat));
      const status = cols.status >= 0 ? cellText(getCell(cells, cols.status)) : '';

      // ---- 收支方向 ----
      let type = null, reason = '';
      const textForDir = `${note} ${hint}`.trim(); // 对方 + 摘要 + 备注 + 账单分类
      if (cols.dir >= 0) {
        const d = dirToType(getCell(cells, cols.dir));
        if (d === 'expense' || d === 'income') type = d;
        else if (d === 'neutral') {
          type = refineNeutralType(textForDir); // 「其他 / /」里的还款、退款、收益发放仍判收支
          if (!type) reason = 'neutral';        // 自转账、余额充值等 → 不计收支（空值继续向下猜）
        }
      }
      if (!type && !reason) {
        if (debit > 0 && credit <= 0) type = 'expense';
        else if (credit > 0 && debit <= 0) type = 'income';
      }
      if (!type && !reason && raw < 0) type = 'expense'; // 负数金额
      if (!type && !reason) {
        type = guessType(textForDir) || refineNeutralType(textForDir);
        if (!type) reason = 'unknown';
      }

      // ---- 交易状态：关闭/失败 → 无效；含退款 → 本次资金已退回（都默认不导入，但保留可见） ----
      let flag = '', tip = '';
      if (status && BAD_STATUS.test(status)) {
        flag = status.slice(0, 8); tip = `交易状态：${status}，默认不导入`;
      } else if (status && REFUND_STATUS.test(status)) {
        flag = status.slice(0, 8);
        if (!type) type = 'income'; // 收/支为空或 / 的退款条目 → 收入
        tip = `交易状态：${status}，钱已退回，默认不导入（如需计入收入可手动勾选）`;
      } else if (reason === 'neutral') {
        flag = '不计收支'; tip = '自转账 / 余额充值等不计入收支，默认不导入';
      } else if (reason === 'unknown') {
        flag = '无方向'; tip = '无法判断收入或支出，请在「类型」列手动选择';
      }

      const row = {
        idx: out.length,
        date,
        type: type || '',
        amount,
        note,
        text: `${note} ${hint}`.trim(),
        hint,
        cat: '',
        status,
        flag,
        tip,
        checked: false,
        userSet: false,
        dup: null
      };
      if (row.type && catsOf) row.cat = autoCategory(row.type, row.text, hint, catsOf(row.type));
      out.push(row);
    }

    if (!out.length) return { error: '文件里没有解析到有效记录（可能只有表头或合计行）', source, sourceLabel: SOURCE_LABELS[source] };

    return {
      source,
      sourceLabel: SOURCE_LABELS[source] || '未知格式',
      rows: out,
      skipped
    };
  }

  return { decode, parse, autoCategory, fingerprint, detectSource };
})();
