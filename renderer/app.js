'use strict';

/* ================= 常量 ================= */

/** 内置分类（默认值；用户可在设置页新增/编辑/删除，自定义结果存于 settings.categories） */
const CATEGORIES = {
  expense: ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '人情', '还款', '其他'],
  income: ['工资', '奖金', '兼职', '投资', '红包', '其他']
};

/** 负债还款方式（新增负债时下拉选择） */
const REPAY_METHODS = {
  principal: '等额本金',
  equal: '等额本息',
  daily: '按日计息',
  minimum: '每期最低还款',
  interest: '先息后本还款',
  private: '民间借贷'
};
/** 兼容旧数据：installment → equal（旧「每月等额还款」即等额本息） */
const LEGACY_KIND = { installment: 'equal', minimum: 'minimum', interest: 'interest' };

const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#84cc16', '#f97316', '#64748b'];

const NOTES = {
  餐饮: ['早餐', '午饭', '晚饭', '外卖', '聚餐', '咖啡', '水果'],
  交通: ['地铁', '公交', '打车', '加油', '停车费'],
  购物: ['日用品', '衣服', '数码产品', '网购'],
  居住: ['房租', '水电燃气', '物业费'],
  娱乐: ['电影', '游戏', '旅行', '会员订阅'],
  医疗: ['药品', '门诊'],
  教育: ['课程', '书籍'],
  人情: ['随礼', '红包'],
  还款: ['借呗还款', '信用卡还款', '分期还款', '提前结清'],
  其他: ['杂项'],
  工资: ['月薪'], 奖金: ['绩效奖金'], 兼职: ['兼职收入'],
  投资: ['基金收益', '股票分红'], 红包: ['收到红包']
};

/* ================= 状态 ================= */

const state = {
  data: { version: 1, transactions: [], budgets: {}, settings: {} },
  view: 'dashboard',
  txMonth: '',
  fType: 'all',
  fCat: 'all',
  fQ: '',
  form: null,
  debtForm: null,
  catForm: null,     // 分类新增/重命名弹窗
  imp: null,         // 导入账单：当前解析与预览状态（null = 未选文件）
  expanded: {},   // 负债页：已展开还款明细的平台
  showFull: {},   // 负债页：显示全部期数
  saveTimer: null,
  pendingReload: false, // 外部（MCP）改写了账本，等弹窗关闭后同步
  dataPathText: ''
};

/* ================= 工具函数 ================= */

const $ = (s, root) => (root || document).querySelector(s);
const $$ = (s, root) => [...(root || document).querySelectorAll(s)];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cny = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' });
const money = (n) => cny.format(Math.round(n * 100) / 100);

const pad2 = (n) => String(n).padStart(2, '0');
const ym = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const ymNow = () => ym(new Date());
const ymLabel = (s) => { const [y, m] = s.split('-'); return `${y}年${Number(m)}月`; };
const dateLabel = (s) => { const [y, m, d] = s.split('-'); return `${y}/${m}/${d}`; };

/* ---- 日期运算（负债还款计划用） ---- */
function parseDate(s) {
  const [y, m, d] = String(s || '').split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}
function fmtDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function addMonths(s, n) {
  const d = parseDate(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return fmtDate(d);
}
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d); }
function daysDiff(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }

function shiftMonth(ymStr, delta) {
  const [y, m] = ymStr.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return ym(d);
}

/** 取某类型的分类列表：用户自定义优先，没自定义时用内置默认 */
function catList(type) {
  const s = state.data && state.data.settings;
  const custom = s && s.categories && Array.isArray(s.categories[type]) ? s.categories[type] : null;
  if (custom && custom.length) return custom;
  return CATEGORIES[type] || CATEGORIES.expense;
}

/** 筛选用分类：自定义分类 + 历史记录里用过的分类（删掉的分类仍能筛选旧账） */
function catOptionsList(type) {
  const used = (state.data.transactions || [])
    .filter((t) => t.type === type)
    .map((t) => t.category)
    .filter((c) => c && !catList(type).includes(c));
  return [...catList(type), ...used];
}

const catColor = (cat, type) => {
  const list = catList(type);
  const i = list.indexOf(cat);
  if (i >= 0) return PALETTE[i % PALETTE.length];
  // 不在列表中（已删除或历史分类）：用名称哈希取色，避免同色扎堆
  let h = 0;
  for (const ch of String(cat)) h = (h * 31 + (ch.codePointAt(0) || 0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

const round2 = (n) => Math.round(n * 100) / 100;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function normalize(d) {
  const txs = Array.isArray(d && d.transactions) ? d.transactions : [];
  return {
    version: 1,
    transactions: txs
      .filter((t) => t && (t.type === 'income' || t.type === 'expense') && isFinite(Number(t.amount)) && typeof t.date === 'string')
      .map((t) => ({
        id: String(t.id || newId()),
        type: t.type,
        amount: round2(Number(t.amount)),
        category: String(t.category || '其他'),
        date: String(t.date),
        note: String(t.note || ''),
        src: t.src ? String(t.src) : '',
        paymentKey: t.paymentKey ? String(t.paymentKey) : '',
        createdAt: Number(t.createdAt || 0)
      })),
    budgets: d && d.budgets && typeof d.budgets === 'object' ? d.budgets : {},
    debts: (Array.isArray(d && d.debts) ? d.debts : [])
      .filter((x) => x && typeof x === 'object')
      .map(normalizeDebt),
    settings: normalizeSettings(d && d.settings)
  };
}

/** 设置规范化：重点校验自定义分类（去空、去重、限量） */
function normalizeSettings(s) {
  const out = s && typeof s === 'object' && !Array.isArray(s) ? { ...s } : {};
  const src = out.categories && typeof out.categories === 'object' ? out.categories : {};
  const cats = {};
  ['expense', 'income'].forEach((type) => {
    if (!Array.isArray(src[type])) return;
    const list = [];
    src[type].forEach((x) => {
      const name = String(x == null ? '' : x).trim().slice(0, 10);
      if (name && !list.includes(name)) list.push(name);
    });
    if (list.length) cats[type] = list;
  });
  if (cats.expense || cats.income) out.categories = cats;
  else delete out.categories;
  return out;
}

/** 负债记录规范化（容错旧数据） */
function normalizeDebt(x) {
  let minRate = Number(x.minRate);
  if (!isFinite(minRate) || minRate <= 0) minRate = 0.1;
  else if (minRate > 1) minRate = minRate / 100; // 兼容存成百分数的情况
  return {
    id: String(x.id || newId()),
    platform: String(x.platform || '未命名平台'),
    kind: (() => { const k = LEGACY_KIND[x.kind] || x.kind; return REPAY_METHODS[k] ? k : 'equal'; })(),
    total: round2(Math.max(0, Number(x.total) || 0)),
    borrowDate: String(x.borrowDate || todayStr()),
    firstDue: String(x.firstDue || todayStr()),
    periods: Math.max(1, Math.round(Number(x.periods) || 12)),
    perPeriod: round2(Math.max(0, Number(x.perPeriod) || 0)),
    minRate: Math.min(1, Math.max(0.01, minRate)),
    annualRate: Math.max(0, Number(x.annualRate) || 0),
    note: String(x.note || ''),
    payments: (Array.isArray(x.payments) ? x.payments : []).map((p) => {
      const pay = {
        no: Math.max(1, Math.round(Number(p.no) || 1)),
        date: String(p.date || todayStr()),
        amount: round2(Math.max(0, Number(p.amount) || 0))
      };
      // 提前结清会锁定该期的本金/利息，没有存档时仍按计划表推算
      if (p.principal != null && isFinite(Number(p.principal))) pay.principal = round2(Number(p.principal));
      if (p.interest != null && isFinite(Number(p.interest))) pay.interest = round2(Number(p.interest));
      if (p.settle) pay.settle = true;
      return pay;
    }),
    createdAt: Number(x.createdAt || 0)
  };
}

const sortedTx = () => [...state.data.transactions].sort((a, b) =>
  a.date === b.date ? (b.createdAt || 0) - (a.createdAt || 0) : (a.date < b.date ? 1 : -1));

const sumBy = (arr, type) => arr.reduce((s, t) => s + (t.type === type ? t.amount : 0), 0);
const sumOfType = (type) => state.data.transactions.reduce((s, t) => s + (t.type === type ? t.amount : 0), 0);

/* ================= 负债模型 ================= */

const debtList = () => (Array.isArray(state.data.debts) ? state.data.debts : []);

/**
 * 生成某笔负债的还款计划表，按还款方式用年利率自动计算每期应还金额：
 * - principal（等额本金）：每期归还本金固定不变，利息按剩余本金计逐期递减，每期应还逐月下降，末期轧差
 * - equal（等额本息·市场口径）：按日计息，总利息 = Σ(计划余额 × 日利率 × 当期实际天数)，
 *   每期定额 =（本金 + 总利息）÷ 期数，每期还款固定，与借呗等平台账单口径一致（非银行年金公式）
 * - daily（按日计息·递减口径）：每期本金固定，利息 = 剩余本金 × 日利率 × 当期实际天数（首期为放款日→首期还款日）
 * - minimum（每期最低还款）：按「最低还款比例」逐期冲抵本金，当期按剩余本金计息
 * - interest（先息后本还款）：每期只还当期利息，末期一次性归还全部本金
 * - private（民间借贷）：按约定还款日一次性还本付息（年利率为 0 则只还本金）
 * 每期状态：paid 已还 / overdue 逾期 / due 待还
 */
function debtSchedule(d) {
  const paidMap = new Map((d.payments || []).map((p) => [Number(p.no), p]));
  const rows = [];
  const today = todayStr();
  const total = round2(Number(d.total) || 0);
  const rate = Math.max(0, Number(d.annualRate) || 0) / 1200; // 年利率(%) → 月利率
  const push = (no, date, amount, interest, principal) => {
    const p = paidMap.get(no);
    let a = round2(amount), it = round2(interest), pr = round2(principal);
    if (p && p.principal != null) {
      // 已锁定本金/利息的还款（提前结清）：以存档为准，确保剩余本金能归零
      a = round2(Number(p.amount) || 0);
      it = round2(Number(p.interest) || 0);
      pr = round2(Number(p.principal) || 0);
    }
    rows.push({ no, date, amount: a, interest: it, principal: pr, paid: !!p, paidInfo: p || null });
  };

  if (d.kind === 'minimum') {
    const minRate = Number(d.minRate) > 0 ? Number(d.minRate) : 0.1;
    let remain = total;
    let i = 0;
    while (remain > 0.009 && i < 240) {
      i += 1;
      const p = paidMap.get(i);
      const interest = p && p.interest != null
        ? round2(Number(p.interest) || 0)
        : (rate > 0 ? round2(remain * rate) : 0);
      const date = addMonths(d.firstDue, i - 1);
      let amount, principal;
      if (p) {
        amount = round2(Number(p.amount) || 0);
        principal = p.principal != null
          ? round2(Number(p.principal) || 0)
          : round2(Math.min(remain, Math.max(0, amount - interest)));
      } else {
        principal = round2(remain * minRate);
        if (remain - principal < 1) principal = remain; // 尾期一次结清
        amount = round2(principal + interest);
      }
      push(i, date, amount, interest, principal);
      remain = round2(remain - principal);
      if (!p && principal <= 0) break; // 兜底：利息吞掉还款时避免死循环
    }
  } else if (d.kind === 'private') {
    // 民间借贷：到约定还款日一次性还本付息；年利率为 0 则只还本金
    const annual = Math.max(0, Number(d.annualRate) || 0) / 100;
    const days = Math.max(0, daysDiff(d.borrowDate || today, d.firstDue));
    const interest = annual > 0 ? round2((total * annual * days) / 365) : 0;
    push(1, d.firstDue, round2(total + interest), interest, total);
  } else {
    const n = Math.max(1, Math.round(Number(d.periods) || 1));
    if (d.kind === 'interest') {
      // 先息后本：每期利息固定 = 本金 × 月利率，末期还本
      const interest = rate > 0 ? round2(total * rate) : 0;
      for (let i = 1; i <= n; i++) {
        const principal = i === n ? total : 0;
        push(i, addMonths(d.firstDue, i - 1), principal + interest, interest, principal);
      }
    } else if (d.kind === 'principal') {
      // 等额本金：每期归还本金固定，利息按剩余本金计，每期应还逐月下降，末期轧差
      const perPri = round2(total / n);
      let remain = total;
      for (let i = 1; i <= n; i++) {
        const interest = rate > 0 ? round2(remain * rate) : 0;
        const principal = i === n ? remain : Math.min(perPri, remain);
        push(i, addMonths(d.firstDue, i - 1), round2(principal + interest), interest, principal);
        remain = round2(remain - principal);
        if (remain <= 0 && i < n) { // 兜底：本金提前还完则补齐剩余期数为 0
          for (let j = i + 1; j <= n; j++) push(j, addMonths(d.firstDue, j - 1), 0, 0, 0);
          break;
        }
      }
    } else if (d.kind === 'daily') {
      // 按日计息（借呗口径）：每期本金固定，利息 = 剩余本金 × 日利率 × 当期实际天数，末期轧差
      // 日利率 = 年利率 ÷ 100 ÷ 365；首期天数 = 放款日 → 首期还款日，之后为相邻两期还款日的实际间隔
      const daily = Math.max(0, Number(d.annualRate) || 0) / 100 / 365;
      const perPri = round2(total / n);
      let remain = total;
      let prevDate = d.borrowDate || today;
      for (let i = 1; i <= n; i++) {
        const date = addMonths(d.firstDue, i - 1);
        const days = Math.max(0, daysDiff(prevDate, date));
        prevDate = date;
        const interest = daily > 0 ? round2(remain * daily * days) : 0;
        const principal = i === n ? remain : Math.min(perPri, remain);
        push(i, date, round2(principal + interest), interest, principal);
        remain = round2(remain - principal);
        if (remain <= 0 && i < n) { // 兜底：本金提前还完则补齐剩余期数为 0
          for (let j = i + 1; j <= n; j++) push(j, addMonths(d.firstDue, j - 1), 0, 0, 0);
          break;
        }
      }
    } else {
      // 等额本息（市场口径·按日计息定额）：与借呗等消费金融平台账单一致，而非银行年金公式
      // ① 总利息 = Σ(计划余额 × 日利率 × 当期实际天数)，计划余额按本金均分逐期递减；
      //    日利率 = 年利率 ÷ 365，首期天数 = 放款日 → 首期还款日，之后为相邻两期还款日实际间隔
      // ② 每期定额 = (本金 + 总利息) ÷ 期数，每期还款固定，本金 = 定额 − 当期利息，末期轧差
      const daily = Math.max(0, Number(d.annualRate) || 0) / 100 / 365;
      const perPri = round2(total / n);
      const dates = [];
      const ints = [];
      let plan = total;
      let prevDate = d.borrowDate || today;
      for (let i = 1; i <= n; i++) {
        const date = addMonths(d.firstDue, i - 1);
        const days = Math.max(0, daysDiff(prevDate, date));
        prevDate = date;
        dates.push(date);
        ints.push(daily > 0 ? round2(plan * daily * days) : 0);
        plan = round2(plan - perPri);
      }
      const per = round2((total + ints.reduce((s, x) => s + x, 0)) / n);
      let remain = total;
      for (let i = 1; i <= n; i++) {
        const interest = ints[i - 1];
        let principal = round2(per - interest);
        let amount = per;
        if (i === n || principal >= remain) { principal = remain; amount = round2(principal + interest); } // 末期轧差
        push(i, dates[i - 1], amount, interest, principal);
        remain = round2(remain - principal);
        if (remain <= 0 && i < n) { // 兜底：本金提前还完则补齐剩余期数为 0
          for (let j = i + 1; j <= n; j++) push(j, dates[j - 1], 0, 0, 0);
          break;
        }
      }
    }
  }

  rows.forEach((r) => {
    r.status = r.paid ? 'paid' : (r.date < today ? 'overdue' : 'due');
    r.diff = daysDiff(today, r.date);
  });
  return rows;
}

/** 单笔负债的汇总信息 */
function debtInfo(d) {
  const rows = debtSchedule(d);
  const paidRows = rows.filter((r) => r.paid);
  const unpaid = rows.filter((r) => !r.paid);
  const total = round2(Number(d.total) || 0);
  const cashPaid = round2((d.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const principalPaid = round2(paidRows.reduce((s, r) => s + (r.principal || 0), 0));
  const periods = Math.max(1, Math.round(Number(d.periods) || 1));
  return {
    rows, paidRows, unpaid, total, cashPaid, principalPaid,
    remaining: Math.max(0, round2(total - principalPaid)),
    paidCount: paidRows.length,
    count: rows.length,
    per: d.kind === 'minimum'
      ? (unpaid[0] ? unpaid[0].amount : 0)
      : (rows[0] ? rows[0].amount : round2(total / periods)),
    next: unpaid[0] || null,
    overdue: unpaid.filter((r) => r.status === 'overdue'),
    planSum: round2(unpaid.reduce((s, r) => s + r.amount, 0)),
    futureInterest: round2(unpaid.reduce((s, r) => s + (r.interest || 0), 0)),
    done: unpaid.length === 0,
    pct: total > 0 ? (principalPaid / total) * 100 : 0,
    payoffDate: rows.length ? rows[rows.length - 1].date : null
  };
}

/** 全部负债汇总 */
function debtSummary() {
  const m = ymNow();
  const nextM = shiftMonth(m, 1);
  const s = {
    count: debtList().length, total: 0, paid: 0, remaining: 0,
    dueMonth: 0, dueMonthCount: 0, dueNextMonth: 0, dueNextMonthCount: 0,
    overdueCount: 0, soonCount: 0,
    paidCount: 0, unpaidCount: 0, next: null
  };
  debtList().forEach((d) => {
    const i = debtInfo(d);
    s.total += i.total;
    s.paid += i.cashPaid;
    s.remaining += i.remaining;
    s.paidCount += i.paidCount;
    i.unpaid.forEach((r) => {
      s.unpaidCount += 1;
      if (r.date.startsWith(m)) { s.dueMonth += r.amount; s.dueMonthCount += 1; }
      if (r.date.startsWith(nextM)) { s.dueNextMonth += r.amount; s.dueNextMonthCount += 1; }
      if (r.diff < 0) s.overdueCount += 1;
      else if (r.diff <= 7) s.soonCount += 1;
      if (!s.next || r.date < s.next.date) s.next = { date: r.date, amount: r.amount, no: r.no, debt: d };
    });
  });
  s.total = round2(s.total);
  s.paid = round2(s.paid);
  s.remaining = round2(s.remaining);
  s.dueMonth = round2(s.dueMonth);
  s.dueNextMonth = round2(s.dueNextMonth);
  return s;
}

/** 未来 N 天（含已逾期）的待还账单，按日期升序 */
function upcoming(days) {
  const out = [];
  debtList().forEach((d) => {
    debtInfo(d).unpaid.forEach((r) => {
      if (r.diff <= days) out.push({ debt: d, no: r.no, date: r.date, amount: r.amount, diff: r.diff, overdue: r.diff < 0 });
    });
  });
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 某月最后一日（'YYYY-MM-DD'） */
function endOfMonthStr(ymStr) {
  const [y, m] = ymStr.split('-').map(Number);
  return fmtDate(new Date(y, m, 0));
}

/** 可标记还款的截止日：本月 + 下月（到下月最后一日），再往后提示未到还款期 */
const payWindowEnd = () => endOfMonthStr(shiftMonth(ymNow(), 1));

/** 是否允许手动标记某期还款 */
function canMarkPaid(dateStr) {
  return String(dateStr || '') <= payWindowEnd();
}

/**
 * 提前还清所需金额：剩余本金 + 已产生（已到期，含本月）的利息
 * 民间借贷按「欠债日 → 今天」的实际天数计息，未来期次一律不计息
 */
function settleAmount(d) {
  const rows = debtSchedule(d).filter((r) => !r.paid);
  const monthEnd = endOfMonthStr(ymNow());
  const total = round2(Number(d.total) || 0);
  const annual = Math.max(0, Number(d.annualRate) || 0) / 100;
  const parts = rows.map((r) => {
    let it;
    if (d.kind === 'private') {
      const days = Math.max(0, daysDiff(d.borrowDate || todayStr(), todayStr()));
      it = annual > 0 ? round2((total * annual * days) / 365) : 0;
    } else {
      it = r.date <= monthEnd ? round2(r.interest || 0) : 0; // 未到期期次不计利息
    }
    const pr = round2(r.principal || 0);
    return { no: r.no, date: r.date, principal: pr, interest: it, amount: round2(pr + it) };
  });
  return {
    parts,
    principal: round2(parts.reduce((s, x) => s + x.principal, 0)),
    interest: round2(parts.reduce((s, x) => s + x.interest, 0)),
    total: round2(parts.reduce((s, x) => s + x.amount, 0))
  };
}

/* ================= 持久化 ================= */

function persist() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    try {
      const r = await window.api.saveData(state.data);
      if (r && r.ok === false) toast('保存失败：' + r.error, true);
    } catch (e) {
      toast('保存失败：' + e.message, true);
    }
  }, 250);
}

/* 账本被外部修改（如 MCP 服务器记账）：直接同步刷新；有弹窗打开时延迟到关闭后 */
async function externalDataChanged() {
  if (state.form || state.debtForm || state.catForm) { state.pendingReload = true; return; }
  try {
    const d = await window.api.loadData();
    state.data = normalize(d);
    render();
    toast('账本已同步更新（来自外部修改）');
  } catch (e) {
    console.error('同步外部数据失败:', e);
  }
}

let toastTimer;
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2600);
}

/* ================= 渲染入口 ================= */

function render() {
  // 记住焦点，重建 DOM 后恢复（避免输入搜索时丢焦点）
  const a = document.activeElement;
  const fid = a && a.id ? a.id : null;
  const selStart = a && typeof a.selectionStart === 'number' ? a.selectionStart : null;

  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + state.view));

  ({
    dashboard: renderDashboard,
    transactions: renderTransactions,
    import: renderImport,
    budget: renderBudget,
    debts: renderDebts,
    settings: renderSettings
  })[state.view]();

  if (fid) {
    const el = document.getElementById(fid);
    if (el) {
      el.focus();
      if (selStart != null && el.setSelectionRange) {
        try { el.setSelectionRange(selStart, selStart); } catch (_) { /* number/date input 不支持 */ }
      }
    }
  }
}

/* ================= 总览 ================= */

function renderDashboard() {
  const el = $('#view-dashboard');
  const txs = state.data.transactions;

  if (!txs.length && !debtList().length) {
    el.innerHTML = `
      <div class="page-head"><div><div class="page-title">总览</div></div></div>
      <div class="card">
        <div class="empty">
          <div class="empty-ico">💰</div>
          <h3>开始记录你的第一笔账</h3>
          <p>每一笔收支都会汇总到这里：<br>余额趋势、支出构成、预算执行一目了然。</p>
          <button class="btn" data-action="add">＋ 记一笔</button>
          <button class="btn ghost" data-action="sample">载入示例数据</button>
        </div>
      </div>`;
    return;
  }

  const m = ymNow();
  const prevM = shiftMonth(m, -1);
  const monthTx = txs.filter((t) => t.date.startsWith(m));
  const prevTx = txs.filter((t) => t.date.startsWith(prevM));

  const monthIn = sumBy(monthTx, 'income');
  const monthOut = sumBy(monthTx, 'expense');
  const prevOut = sumBy(prevTx, 'expense'); // 上月支出
  const balance = sumOfType('income') - sumOfType('expense');
  const monthNet = monthIn - monthOut;

  // 年度口径：自然年（1月1日 - 12月31日）累计收支
  const year = m.slice(0, 4);
  const yearTx = txs.filter((t) => t.date.startsWith(year));
  const yearIn = sumBy(yearTx, 'income');
  const yearOut = sumBy(yearTx, 'expense');
  const yearInCount = yearTx.filter((t) => t.type === 'income').length;
  const yearOutCount = yearTx.filter((t) => t.type === 'expense').length;

  let outDelta = '';
  if (prevOut > 0) {
    const pct = ((monthOut - prevOut) / prevOut) * 100;
    outDelta = `<div class="stat-sub ${pct > 0 ? 'up' : 'down'}">较上月 ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</div>`;
  } else {
    outDelta = `<div class="stat-sub">上月无支出</div>`;
  }

  // 最近 6 个月
  const months = [];
  for (let k = 5; k >= 0; k--) months.push(shiftMonth(m, -k));
  const incSeries = months.map((mm) => sumBy(txs.filter((t) => t.date.startsWith(mm)), 'income'));
  const expSeries = months.map((mm) => sumBy(txs.filter((t) => t.date.startsWith(mm)), 'expense'));
  const labels = months.map((mm) => `${Number(mm.split('-')[1])}月`);

  // 本月支出构成
  const byCat = {};
  monthTx.filter((t) => t.type === 'expense').forEach((t) => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
  const donutItems = Object.entries(byCat)
    .map(([label, value]) => ({ label, value: round2(value), color: catColor(label, 'expense') }))
    .sort((x, y) => y.value - x.value);
  const monthOutR = round2(monthOut);

  // 预算总览
  const budgetCats = Object.entries(state.data.budgets).filter(([, v]) => Number(v) > 0);
  const totalBudget = budgetCats.reduce((s, [, v]) => s + Number(v), 0);
  const budgetSpent = budgetCats.reduce((s, [c]) => s + (byCat[c] || 0), 0);
  const bp = totalBudget > 0 ? (budgetSpent / totalBudget) * 100 : 0;
  const bpClass = bp > 100 ? 'over' : bp > 80 ? 'warn' : '';

  const recent = sortedTx().slice(0, 6);

  /* ---- 负债面板（总览集成） ---- */
  const hasDebt = debtList().length > 0;
  const DS = hasDebt ? debtSummary() : null;
  const rem = [];
  if (hasDebt) {
    const perDebt = {};
    upcoming(7).forEach((r) => {           // 每个平台最多展示 2 笔，避免被单笔负债刷屏
      const c = (perDebt[r.debt.id] = (perDebt[r.debt.id] || 0) + 1);
      if (c <= 2 && rem.length < 5) rem.push(r);
    });
  }

  const debtRow = hasDebt ? `
    <div class="cards">
      <div class="card stat debt">
        <div class="stat-label">总负债（剩余应还）</div>
        <div class="stat-value">${money(DS.remaining)}</div>
        <div class="stat-sub">欠款总金额 ${money(DS.total)} · 已还 ${money(DS.paid)}</div>
      </div>
      <div class="card stat wealth">
        <div class="stat-label">净资产</div>
        <div class="stat-value">${money(balance - DS.remaining)}</div>
        <div class="stat-sub">总资产 − 总负债</div>
      </div>
      <div class="card stat net">
        <div class="stat-label">本月应还</div>
        <div class="stat-value">${money(DS.dueMonth)}</div>
        <div class="stat-sub">${DS.dueMonthCount} 期${DS.next ? ' · 最近 ' + dateLabel(DS.next.date) : ''}</div>
      </div>
      <div class="card stat expense">
        <div class="stat-label">还款提醒</div>
        <div class="stat-value">${DS.overdueCount + DS.soonCount} 笔</div>
        <div class="stat-sub">${DS.overdueCount > 0 ? `<b class="red">${DS.overdueCount} 笔已逾期</b> · ` : ''}未来 7 天 ${DS.soonCount} 笔</div>
      </div>
    </div>` : '';

  const debtGrid = hasDebt ? `
    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <div class="card-title">还款提醒</div>
          <button class="btn ghost sm" data-action="goto" data-view="debts">管理负债</button>
        </div>
        ${rem.length ? rem.map(remindRowHtml).join('') : `
          <div class="empty" style="padding:22px 10px"><p>近 7 天没有待还账单 🎉</p></div>`}
        <div class="hint-line">点「记还款」会自动生成一笔分类为「还款」的支出，并同步到交易记录、预算与支出统计。</div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">各平台负债</div>
          <button class="btn ghost sm" data-action="goto" data-view="debts">查看明细</button>
        </div>
        ${debtList().map((d) => {
          const i = debtInfo(d);
          return `
          <div class="debt-mini">
            <div class="dm-top">
              <span class="dm-name">${esc(d.platform)} <span class="badge kind">${REPAY_METHODS[d.kind]}</span></span>
              <span class="dm-amt">${i.done ? '<span class="badge done">已结清</span>' : money(i.remaining)}</span>
            </div>
            <div class="progress ${i.pct > 100 ? 'over' : ''}"><i style="width:${Math.min(100, i.pct)}%"></i></div>
            <div class="dm-sub">总金额 ${money(d.total)} · 已还 ${i.paidCount}/${i.count} 期 · ${i.done ? '全部结清 ✓' : '下期 ' + dateLabel(i.next.date) + ' ' + money(i.next.amount)}</div>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  el.innerHTML = `
    <div class="page-head">
      <div><div class="page-title">总览</div><div class="page-sub">${ymLabel(m)} · 共 ${txs.length} 笔记录</div></div>
      <button class="btn" data-action="add">＋ 记一笔</button>
    </div>

    <div class="cards">
      <div class="card stat balance">
        <div class="stat-label">总资产</div>
        <div class="stat-value">${money(balance)}</div>
        <div class="stat-sub">收入 ${money(sumOfType('income'))} − 支出 ${money(sumOfType('expense'))}</div>
      </div>
      <div class="card stat income">
        <div class="stat-label">本月收入</div>
        <div class="stat-value">${money(monthIn)}</div>
        <div class="stat-sub">${monthTx.filter((t) => t.type === 'income').length} 笔收入</div>
      </div>
      <div class="card stat expense">
        <div class="stat-label">本月支出</div>
        <div class="stat-value">${money(monthOut)}</div>
        ${outDelta}
      </div>
      <div class="card stat net">
        <div class="stat-label">本月结余</div>
        <div class="stat-value">${money(monthNet)}</div>
        <div class="stat-sub">结余率 ${monthIn > 0 ? ((monthNet / monthIn) * 100).toFixed(1) : '0'}%</div>
      </div>
    </div>

    <div class="cards three">
      <div class="card stat income">
        <div class="stat-label">年度收入</div>
        <div class="stat-value">${money(yearIn)}</div>
        <div class="stat-sub">${year} 年 · ${yearInCount} 笔收入 · 月均 ${money(yearIn / Math.max(1, Number(m.split('-')[1])))}</div>
      </div>
      <div class="card stat expense">
        <div class="stat-label">年度支出</div>
        <div class="stat-value">${money(yearOut)}</div>
        <div class="stat-sub">${year} 年 · ${yearOutCount} 笔支出 · 月均 ${money(yearOut / Math.max(1, Number(m.split('-')[1])))}</div>
      </div>
      <div class="card stat debt">
        <div class="stat-label">下月应还</div>
        <div class="stat-value">${money(hasDebt ? DS.dueNextMonth : 0)}</div>
        <div class="stat-sub">${ymLabel(shiftMonth(m, 1))} · ${hasDebt ? DS.dueNextMonthCount : 0} 期${!hasDebt ? ' · 暂无负债' : DS.dueNextMonthCount === 0 ? ' · 无待还账单' : ''}</div>
      </div>
    </div>

    ${debtRow}

    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <div class="card-title">近 6 个月收支趋势</div>
          <div class="legend">
            <span><i style="background:#22c55e"></i>收入</span>
            <span><i style="background:#6366f1"></i>支出</span>
          </div>
        </div>
        <canvas id="chart-bars" class="chart"></canvas>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">本月支出构成</div>
          <div class="card-note">合计 ${money(monthOutR)}</div>
        </div>
        <canvas id="chart-donut" class="chart"></canvas>
        <div class="donut-legend">
          ${donutItems.slice(0, 8).map((d) => `
            <div class="dl-row" title="${esc(d.label)} ${money(d.value)}">
              <span class="dl-dot" style="background:${d.color}"></span>
              <span class="dl-name">${esc(d.label)}</span>
              <span class="dl-val">${money(d.value)}</span>
            </div>`).join('')}
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <div class="card-title">预算执行（本月）</div>
          <button class="btn ghost sm" data-action="goto" data-view="budget">管理预算</button>
        </div>
        ${totalBudget > 0 ? `
          <div class="budget-total" style="margin-bottom:14px">
            <div class="progress ${bpClass}"><i style="width:${Math.min(100, bp)}%"></i></div>
            <div class="b-pct ${bpClass}">${bp.toFixed(0)}%</div>
          </div>
          <div class="kv"><span class="k">预算总额</span><span class="v">${money(totalBudget)}</span></div>
          <div class="kv"><span class="k">已支出</span><span class="v">${money(budgetSpent)}</span></div>
          <div class="kv"><span class="k">剩余</span><span class="v" style="color:${totalBudget - budgetSpent < 0 ? '#dc2626' : '#16a34a'}">${money(totalBudget - budgetSpent)}</span></div>
        ` : `
          <div class="empty" style="padding:24px 10px">
            <p>还没有设置预算</p>
            <button class="btn ghost" data-action="goto" data-view="budget">去设置</button>
          </div>
        `}
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">最近交易</div>
          <button class="btn ghost sm" data-action="goto" data-view="transactions">查看全部</button>
        </div>
        ${recent.map((t) => `
          <div class="list-row">
            <span class="cat-dot" style="background:${catColor(t.category, t.type)}"></span>
            <div class="row-main">
              <div class="row-title">${esc(t.category)}${t.note ? ' · ' + esc(t.note) : ''}</div>
              <div class="row-sub">${dateLabel(t.date)}</div>
            </div>
            <div class="row-amount ${t.type === 'income' ? 'amount in' : 'amount out'}">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</div>
            <button class="icon-btn" title="编辑" data-action="edit" data-id="${t.id}">✎</button>
          </div>`).join('')}
      </div>
    </div>

    ${debtGrid}
  `;

  window.Charts.bars($('#chart-bars'), labels, [
    { name: '收入', color: '#22c55e', values: incSeries },
    { name: '支出', color: '#6366f1', values: expSeries }
  ]);
  window.Charts.donut($('#chart-donut'), donutItems, { label: '本月支出' });
}

/* ================= 交易记录 ================= */

function monthsInData() {
  const set = new Set(state.data.transactions.map((t) => t.date.slice(0, 7)));
  set.add(ymNow());
  return [...set].sort().reverse();
}

function filteredTx() {
  const q = state.fQ.trim().toLowerCase();
  return sortedTx().filter((t) => {
    if (state.txMonth !== 'all' && !t.date.startsWith(state.txMonth)) return false;
    if (state.fType !== 'all' && t.type !== state.fType) return false;
    if (state.fCat !== 'all' && t.category !== state.fCat) return false;
    if (q && !(`${t.category} ${t.note}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderTransactions() {
  const el = $('#view-transactions');
  const months = monthsInData();
  if (state.txMonth === '') state.txMonth = months[0] === ymNow() && monthsInData().length ? ymNow() : 'all';

  const expCats = catOptionsList('expense');
  const catOptions = ['all', ...expCats, ...catOptionsList('income').filter((c) => !expCats.includes(c))];

  el.innerHTML = `
    <div class="page-head">
      <div><div class="page-title">交易记录</div><div class="page-sub">共 ${state.data.transactions.length} 笔</div></div>
      <button class="btn" data-action="add">＋ 记一笔</button>
    </div>
    <div class="card">
      <div class="toolbar">
        <select id="f-month" title="月份">
          <option value="all" ${state.txMonth === 'all' ? 'selected' : ''}>全部月份</option>
          ${months.map((mm) => `<option value="${mm}" ${state.txMonth === mm ? 'selected' : ''}>${ymLabel(mm)}</option>`).join('')}
        </select>
        <select id="f-type" title="类型">
          <option value="all" ${state.fType === 'all' ? 'selected' : ''}>全部类型</option>
          <option value="expense" ${state.fType === 'expense' ? 'selected' : ''}>支出</option>
          <option value="income" ${state.fType === 'income' ? 'selected' : ''}>收入</option>
        </select>
        <select id="f-cat" title="分类">
          ${catOptions.map((c) => `<option value="${c}" ${state.fCat === c ? 'selected' : ''}>${c === 'all' ? '全部分类' : c}</option>`).join('')}
        </select>
        <input id="f-q" type="search" placeholder="搜索分类 / 备注…" value="${esc(state.fQ)}">
        <div class="spacer"></div>
        <button class="btn plain sm" data-action="nav" data-view="import">导入账单</button>
        <button class="btn plain sm" data-action="export">导出 CSV</button>
      </div>
      <div id="tx-list"></div>
    </div>`;

  renderTxList();
}

function renderTxList() {
  const list = filteredTx();
  const inc = sumBy(list, 'income');
  const out = sumBy(list, 'expense');

  const container = $('#tx-list');
  if (!container) return;

  if (!list.length) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-ico">📄</div>
        <h3>没有符合条件的记录</h3>
        <p>换个筛选条件，或记一笔新账吧</p>
        <button class="btn" data-action="add">＋ 记一笔</button>
        <button class="btn ghost" data-action="nav" data-view="import">导入账单</button>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="summary-line">
      共 <b>${list.length}</b> 笔 ·
      收入 <b style="color:#16a34a">${money(inc)}</b> ·
      支出 <b style="color:#dc2626">${money(out)}</b> ·
      净额 <b>${money(inc - out)}</b>
    </div>
    <table>
      <thead>
        <tr><th style="width:110px">日期</th><th style="width:80px">类型</th><th style="width:110px">分类</th><th>备注</th><th style="width:130px">金额</th><th style="width:80px"></th></tr>
      </thead>
      <tbody>
        ${list.map((t) => `
          <tr>
            <td style="color:#64748b">${dateLabel(t.date)}</td>
            <td><span class="badge ${t.type}">${t.type === 'income' ? '收入' : '支出'}</span></td>
            <td><span class="badge cat">${esc(t.category)}</span></td>
            <td style="color:#475569">${esc(t.note) || '—'}</td>
            <td class="amount ${t.type === 'income' ? 'in' : 'out'}">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="icon-btn" title="编辑" data-action="edit" data-id="${t.id}">✎</button>
              <button class="icon-btn del" title="删除" data-action="delete" data-id="${t.id}">🗑</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

/* ================= 预算 ================= */

function renderBudget() {
  const el = $('#view-budget');
  const m = ymNow();
  const monthExp = {};
  state.data.transactions
    .filter((t) => t.type === 'expense' && t.date.startsWith(m))
    .forEach((t) => { monthExp[t.category] = (monthExp[t.category] || 0) + t.amount; });

  const rows = catList('expense').map((cat) => {
    const budget = Number(state.data.budgets[cat]) || 0;
    const spent = round2(monthExp[cat] || 0);
    const pct = budget > 0 ? (spent / budget) * 100 : 0;
    const cls = pct > 100 ? 'over' : pct > 80 ? 'warn' : '';
    return `
      <div class="budget-row">
        <span class="cat-dot" style="background:${catColor(cat, 'expense')}"></span>
        <div>
          <div class="b-name">${cat}</div>
          <div class="b-sub">本月已花 ${money(spent)}${budget > 0 ? ' / ' + money(budget) : ''}</div>
        </div>
        <div class="b-input-wrap">¥<input type="number" min="0" step="50" data-budget="${cat}" value="${budget > 0 ? budget : ''}" placeholder="未设置"></div>
        <div class="progress ${cls}"><i style="width:${Math.min(100, pct)}%"></i></div>
        <div class="b-pct ${cls}">${budget > 0 ? pct.toFixed(0) + '%' : '—'}</div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="page-head">
      <div><div class="page-title">月度预算</div><div class="page-sub">${ymLabel(m)} · 设置每月各类支出上限，超支自动预警</div></div>
    </div>
    <div class="card">
      ${rows}
    </div>`;
}

/* ================= 负债 ================= */

/** 还款提醒行（总览 + 负债页共用） */
function remindRowHtml(r) {
  const cls = r.diff < 0 ? 'over' : r.diff <= 3 ? 'soon' : '';
  const label = r.diff < 0 ? `逾期 ${-r.diff} 天` : r.diff === 0 ? '今天到期' : `${r.diff} 天后`;
  return `
    <div class="list-row remind${r.overdue ? ' is-over' : ''}">
      <span class="due-pill ${cls}">${label}</span>
      <div class="row-main">
        <div class="row-title">${esc(r.debt.platform)} · 第 ${r.no} 期</div>
        <div class="row-sub">应还 ${dateLabel(r.date)} · ${REPAY_METHODS[r.debt.kind]}</div>
      </div>
      <div class="row-amount">${money(r.amount)}</div>
      <button class="btn sm ${r.overdue ? '' : 'plain'}" data-action="pay" data-id="${r.debt.id}" data-no="${r.no}">记还款</button>
    </div>`;
}

/** 单个平台的每期应还明细 */
function debtDetailHtml(d, i) {
  const full = !!state.showFull[d.id];
  const all = i.rows;
  const shown = full ? all : all.slice(0, 18);
  const withInterest = all.some((r) => (r.interest || 0) > 0);
  return `
    <div class="detail-head">
      <div class="detail-sum">
        <span>总金额 <b>${money(i.total)}</b></span>
        <span>已还现金 <b>${money(i.cashPaid)}</b></span>
        <span>剩余应还 <b class="red">${money(i.remaining)}</b></span>
        <span>后续计划还款 <b>${money(i.planSum)}</b></span>
        ${withInterest ? `<span>其中预计利息 <b>${money(i.futureInterest)}</b></span>` : ''}
        <span>计划还清 <b>${i.payoffDate ? dateLabel(i.payoffDate) : '—'}</b></span>
        ${d.note ? `<span>备注 <b>${esc(d.note)}</b></span>` : ''}
      </div>
      <div class="detail-actions">
        ${!i.done ? `<button class="btn sm plain settle" data-action="debt-settle" data-id="${d.id}" title="一次性归还剩余本金 + 已产生利息">⏩ 提前结清</button>` : ''}
        ${all.length > 18 ? `<button class="link-btn" data-action="debt-full" data-id="${d.id}">${full ? '收起' : '显示全部 ' + all.length + ' 期'}</button>` : ''}
      </div>
    </div>
    <div class="table-wrap">
      <table class="sched">
        <thead>
          <tr>
            <th style="width:66px">期数</th>
            <th style="width:106px">应还日期</th>
            <th style="width:106px">应还金额</th>
            ${withInterest ? '<th style="width:92px">其中利息</th>' : ''}
            <th style="width:96px">状态</th>
            <th style="width:106px">还款日期</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${shown.map((r) => {
            const label = r.paid ? '已还' : r.status === 'overdue' ? `逾期${-r.diff}天` : r.diff === 0 ? '今天到期' : '待还';
            const st = r.paid ? 'paid' : r.status === 'overdue' ? 'over' : 'due';
            return `
              <tr class="${r.paid ? 'row-paid' : r.status === 'overdue' ? 'row-late' : ''}">
                <td>第 ${r.no} 期</td>
                <td>${dateLabel(r.date)}</td>
                <td class="amount">${money(r.amount)}</td>
                ${withInterest ? `<td class="amount soft">${money(r.interest || 0)}</td>` : ''}
                <td><span class="st ${st}">${label}</span></td>
                <td>${r.paidInfo ? dateLabel(r.paidInfo.date) : '—'}</td>
                <td style="text-align:right">
                  ${r.paid
                    ? `<button class="link-btn danger" data-action="unpay" data-id="${d.id}" data-no="${r.no}">${r.paidInfo && r.paidInfo.settle ? '撤销结清' : '撤销还款'}</button>`
                    : canMarkPaid(r.date)
                      ? `<button class="btn sm plain" data-action="pay" data-id="${d.id}" data-no="${r.no}">标记还款</button>`
                      : `<button class="btn sm plain lock" data-action="pay-locked" data-date="${r.date}" title="未到还款期，最早可在 ${dateLabel(r.date)} 前一个月内标记；也可直接提前结清">🔒 未到还款期</button>`}
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${!full && all.length > 18 ? `<div class="hint-line">仅显示前 18 期，共 ${all.length} 期；其余 ${all.length - 18} 期合计 ${money(round2(all.slice(18).reduce((s, r) => s + r.amount, 0)))}。</div>` : ''}
    <div class="hint-line">标记还款仅开放至 <b>${dateLabel(payWindowEnd())}</b>（本月 + 下月，更早的期次为逾期也可标记）；再往后的期次会显示「未到还款期」，如需一次性还清可点右上角「⏩ 提前结清」（含已产生利息，未来期次不计息）。</div>`;
}

function renderDebts() {
  const el = $('#view-debts');
  const list = [...debtList()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  if (!list.length) {
    el.innerHTML = `
      <div class="page-head">
        <div><div class="page-title">负债</div><div class="page-sub">欠款平台 · 还款计划 · 还款提醒</div></div>
      </div>
      <div class="card">
        <div class="empty">
          <div class="empty-ico">💳</div>
          <h3>暂无负债记录</h3>
          <p>把借呗、信用卡、白条等欠款登记进来：<br>自动算出每期应还、剩余应还，并在总览面板提醒你按时还款。</p>
          <button class="btn" data-action="debt-add">＋ 新增负债</button>
          <button class="btn ghost" data-action="sample">载入示例数据</button>
        </div>
      </div>`;
    return;
  }

  const S = debtSummary();
  const infos = list.map((d) => ({ d, i: debtInfo(d) }));
  const soon = upcoming(7);
  const plan = upcoming(30);
  const planSum = round2(plan.reduce((s, r) => s + r.amount, 0));
  const thisDue = round2(infos.reduce((s, x) => s + (x.i.next ? x.i.next.amount : 0), 0));
  const perSum = round2(infos.reduce((s, x) => s + (x.i.per || 0), 0)); // 各平台“每期应还”合计
  const paidSum = round2(infos.reduce((s, x) => s + x.i.cashPaid, 0));   // 各平台已还现金合计

  const stats = `
    <div class="cards">
      <div class="card stat debt">
        <div class="stat-label">全部应还总金额</div>
        <div class="stat-value">${money(S.total)}</div>
        <div class="stat-sub">${list.length} 个欠款平台</div>
      </div>
      <div class="card stat expense">
        <div class="stat-label">剩余应还总额</div>
        <div class="stat-value">${money(S.remaining)}</div>
        <div class="stat-sub">剩余 ${S.unpaidCount} 期未还</div>
      </div>
      <div class="card stat income">
        <div class="stat-label">已还金额（现金）</div>
        <div class="stat-value">${money(S.paid)}</div>
        <div class="stat-sub">共 ${S.paidCount} 期已还</div>
      </div>
      <div class="card stat net">
        <div class="stat-label">本月应还</div>
        <div class="stat-value">${money(S.dueMonth)}</div>
        <div class="stat-sub">${S.dueMonthCount} 期 · 本期合计 ${money(thisDue)}</div>
      </div>
    </div>`;

  const remindCard = `
    <div class="card">
      <div class="card-head">
        <div class="card-title">还款提醒</div>
        <div class="card-note">逾期 + 未来 7 天${soon.length ? ' · ' + soon.length + ' 笔' : ''}</div>
      </div>
      ${soon.length
        ? soon.slice(0, 6).map(remindRowHtml).join('')
        : `<div class="empty" style="padding:26px 10px"><p>近 7 天没有待还账单 🎉</p></div>`}
      <div class="hint-line">点击「记还款」会自动生成一笔分类为「还款」的支出，并同步到交易记录、预算与总览统计。</div>
    </div>`;

  const planCard = `
    <div class="card">
      <div class="card-head">
        <div class="card-title">还款计划（未来 30 天）</div>
        <div class="card-note">合计 ${money(planSum)}</div>
      </div>
      ${plan.length
        ? plan.slice(0, 8).map((r) => `
          <div class="list-row">
            <span class="due-pill ${r.diff < 0 ? 'over' : r.diff <= 3 ? 'soon' : 'ok'}">${dateLabel(r.date).slice(5)}</span>
            <div class="row-main">
              <div class="row-title">${esc(r.debt.platform)} · 第 ${r.no} 期</div>
              <div class="row-sub">${r.diff < 0 ? '已逾期 ' + (-r.diff) + ' 天' : r.diff === 0 ? '今天' : r.diff + ' 天后'} · ${REPAY_METHODS[r.debt.kind]}</div>
            </div>
            <div class="row-amount">${money(r.amount)}</div>
          </div>`).join('')
        : `<div class="empty" style="padding:26px 10px"><p>未来 30 天没有还款计划</p></div>`}
      ${plan.length > 8 ? `<div class="hint-line">仅显示最近 8 笔，共 ${plan.length} 笔待还。</div>` : ''}
    </div>`;

  const rows = infos.map(({ d, i }) => {
    const open = !!state.expanded[d.id];
    const status = i.done
      ? '<span class="badge done">已结清</span>'
      : i.overdue.length
        ? `<span class="badge late">逾期 ${i.overdue.length} 期</span>`
        : '<span class="badge doing">还款中</span>';
    const dueDay = `每月 ${Number(String(d.firstDue).split('-')[2]) || 1} 日`;
    const countCell = d.kind === 'private'
      ? `<b>1</b> 期约定`
      : d.kind !== 'minimum'
        ? `<b>${i.paidCount} / ${i.count}</b> 期`
        : `<b>已还 ${i.paidCount} 期</b><div class="cell-sub">预计共 ${i.count} 期</div>`;
    const annual = Math.max(0, Number(d.annualRate) || 0);
    const perSub = d.kind === 'minimum'
      ? `最低 ${(Math.max(0.01, Number(d.minRate) || 0.1) * 100).toFixed(0)}% 计`
      : d.kind === 'interest'
        ? `年利率 ${annual}% · 每期利息`
        : d.kind === 'private'
          ? annual > 0 ? `年利率 ${annual}% · 到期还本付息` : '无约定利息 · 到期还本'
          : d.kind === 'daily'
            ? annual > 0 ? `年化 ${annual}% · 按日计息` : '免息 · 每期本金均分'
            : d.kind === 'principal'
              ? annual > 0 ? `年利率 ${annual}% · 逐期递减` : '免息 · 每期本金均分'
              : annual > 0 ? `年化 ${annual}% · 按日定额` : '免息 · 每期固定';
    const perCell = d.kind === 'minimum'
      ? `<b>${i.next ? money(i.next.amount) : '—'}</b><div class="cell-sub">${perSub}</div>`
      : `<b>${i.rows[0] ? money(i.rows[0].amount) : money(i.per)}</b><div class="cell-sub">${perSub}</div>`;
    // 下期应还：下一笔待还金额（已结清显示“—”）
    const nextCell = i.next
      ? `<b>${money(i.next.amount)}</b><div class="cell-sub">${dateLabel(i.next.date).slice(5)} · 第 ${i.next.no} 期</div>`
      : `<b>—</b><div class="cell-sub">${i.done ? '已全部结清' : '无待还'}</div>`;
    // 已还金额：实际归还的现金合计
    const paidCell = `<b>${money(i.cashPaid)}</b><div class="cell-sub">${i.paidCount ? `已还 ${i.paidCount} 期 · 占比 ${i.pct.toFixed(0)}%` : '尚未还款'}</div>`;
    return `
      <tr class="debt-main${i.done ? ' done-row' : ''}">
        <td>
          <button class="link-btn plat" data-action="debt-expand" data-id="${d.id}" title="展开/收起还款明细">${open ? '▾' : '▸'} ${esc(d.platform)}</button>
          ${d.note ? `<div class="cell-sub">${esc(d.note)}</div>` : ''}
        </td>
        <td><span class="badge kind">${REPAY_METHODS[d.kind]}</span></td>
        <td>${dateLabel(d.borrowDate)}</td>
        <td>${d.kind === 'private'
          ? `<b>${dateLabel(d.firstDue)}</b><div class="cell-sub">约定还款日</div>`
          : `<b>${dueDay}</b><div class="cell-sub">首期 ${dateLabel(d.firstDue)}</div>`}</td>
        <td>${countCell}</td>
        <td class="amount">${money(d.total)}</td>
        <td class="amount">${perCell}</td>
        <td class="amount">${nextCell}</td>
        <td class="amount">${paidCell}</td>
        <td class="amount">${money(i.remaining)}</td>
        <td>${status}</td>
        <td style="text-align:right;white-space:nowrap">
          ${i.next ? `<button class="icon-btn settle" title="提前还款：一次性结清剩余本金 + 已产生利息" data-action="debt-settle" data-id="${d.id}">⏩</button>` : ''}
          ${i.next ? `<button class="icon-btn pay" title="记本期还款 ${money(i.next.amount)}" data-action="pay" data-id="${d.id}" data-no="${i.next.no}">✓</button>` : ''}
          <button class="icon-btn" title="编辑" data-action="debt-edit" data-id="${d.id}">✎</button>
          <button class="icon-btn del" title="删除" data-action="debt-delete" data-id="${d.id}">🗑</button>
        </td>
      </tr>
      ${open ? `<tr class="debt-detail"><td colspan="12">${debtDetailHtml(d, i)}</td></tr>` : ''}`;
  }).join('');

  el.innerHTML = `
    <div class="page-head">
      <div><div class="page-title">负债</div><div class="page-sub">${list.length} 个平台 · 剩余应还 ${money(S.remaining)} · 本月应还 ${money(S.dueMonth)}</div></div>
      <div class="head-actions">
        <button class="btn plain" data-action="debt-export">导出明细 CSV</button>
        <button class="btn" data-action="debt-add">＋ 新增负债</button>
      </div>
    </div>

    ${stats}

    <div class="grid-2">${remindCard}${planCard}</div>

    <div class="card">
      <div class="card-head">
        <div class="card-title">各平台应还明细</div>
        <div class="card-note">点击平台名称可展开每期应还计划 · 标记还款开放至 ${dateLabel(payWindowEnd())}</div>
      </div>
      <div class="table-wrap">
        <table class="debt-table">
          <thead>
            <tr>
              <th style="width:150px">欠款平台</th>
              <th style="width:88px">还款方式</th>
              <th style="width:92px">欠债日期</th>
              <th style="width:104px">应还日期</th>
              <th style="width:88px">还款期数</th>
              <th style="width:100px">总金额</th>
              <th style="width:106px">每期应还</th>
              <th style="width:112px">下期应还</th>
              <th style="width:106px">已还金额</th>
              <th style="width:100px">剩余应还</th>
              <th style="width:84px">状态</th>
              <th style="width:142px"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td colspan="5">全部应还总金额合计 · ${list.length} 个平台</td>
              <td class="amount">${money(S.total)}</td>
              <td class="amount">${money(perSum)}</td>
              <td class="amount">${money(thisDue)}</td>
              <td class="amount">${money(paidSum)}</td>
              <td class="amount">${money(S.remaining)}</td>
              <td colspan="2"></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="hint-line">「全部应还总金额」= 各平台欠款金额之和；「下期应还」= 该平台下一笔待还金额与日期；「已还金额」= 实际已归还的现金合计；「剩余应还」= 尚未归还的本金；「每期应还」按还款方式（等额本金 / 等额本息 / 按日计息 / 每期最低 / 先息后本）与年利率自动计算。</div>
    </div>`;
}

/* ---------- 新增/编辑负债弹窗 ---------- */

function openDebtForm(d) {
  state.debtForm = d
    ? { ...d, kind: REPAY_METHODS[d.kind] ? d.kind : 'equal', payments: [...(d.payments || [])] }
    : {
        id: null, kind: 'equal', platform: '', total: '',
        borrowDate: todayStr(), firstDue: addMonths(todayStr(), 1),
        periods: 12, perPeriod: '', minRate: 10, annualRate: 0, note: ''
      };
  renderDebtForm();
  $('#modal-root').classList.remove('hidden');
  setTimeout(() => { const el = $('#d-platform'); if (el) el.focus(); }, 30);
}

function syncDebtInputs() {
  const f = state.debtForm;
  if (!f) return;
  const get = (id) => { const el = $(id); return el ? el.value : null; };
  const platform = get('#d-platform'); if (platform !== null) f.platform = platform;
  const total = get('#d-total'); if (total !== null) f.total = total;
  const note = get('#d-note'); if (note !== null) f.note = note;
  const borrow = get('#d-borrow'); if (borrow !== null) f.borrowDate = borrow;
  const first = get('#d-first'); if (first !== null) f.firstDue = first;
  const periods = get('#d-periods'); if (periods !== null) f.periods = periods;
  const per = get('#d-per'); if (per !== null) f.perPeriod = per;
  const minrate = get('#d-minrate'); if (minrate !== null) f.minRate = minrate;
  const rate = get('#d-rate'); if (rate !== null) f.annualRate = rate;
}

function renderDebtForm() {
  const f = state.debtForm;
  if (!f) return;
  const isMin = f.kind === 'minimum';
  const isPrivate = f.kind === 'private';
  const isDaily = f.kind === 'daily';
  const methodOptions = Object.entries(REPAY_METHODS).map(([k, v]) =>
    `<option value="${k}"${f.kind === k ? ' selected' : ''}>${v}</option>`).join('');
  $('#modal-root').innerHTML = `
    <div class="modal wide" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>${f.id ? '编辑负债' : '新增负债'}</h2>
        <button class="icon-btn" data-action="close-modal" title="关闭">✕</button>
      </div>

      <div class="field-row">
        <div class="field">
          <label>欠款平台</label>
          <input id="d-platform" type="text" maxlength="20" placeholder="如：支付宝借呗 / 招商银行信用卡" value="${esc(f.platform)}">
        </div>
        <div class="field">
          <label>备注</label>
          <input id="d-note" type="text" maxlength="30" placeholder="可选" value="${esc(f.note)}">
        </div>
      </div>

      <div class="field">
        <label>欠款总金额（元）</label>
        <input id="d-total" class="big" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" value="${f.total === '' ? '' : esc(f.total)}">
      </div>

      <div class="field-row">
        <div class="field">
          <label>还款方式</label>
          <select id="d-kind">${methodOptions}</select>
        </div>
        <div class="field">
          <label>${isPrivate ? '约定年利率（%）· 0 表示无利息' : (isDaily || f.kind === 'equal') ? '年化利率（%）· 日利率 = 年利率 ÷ 365' : '年利率（%）'}</label>
          <input id="d-rate" type="number" min="0" step="0.01" placeholder="${isPrivate ? '如 12 表示年化 12%，到期还本付息' : '如 12 表示年化 12%'}" value="${f.annualRate === '' || f.annualRate == null ? 0 : esc(f.annualRate)}">
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>欠债日期</label>
          <input id="d-borrow" type="date" value="${esc(f.borrowDate)}">
        </div>
        <div class="field">
          <label>${isMin ? '每期还款日' : isPrivate ? '约定还款日期' : '首期应还日期'}${isPrivate ? '（到此日一次性还本付息）' : '（按欠债日期自动生成）'}</label>
          <input id="d-first" type="date" value="${esc(f.firstDue)}">
        </div>
      </div>

      ${isMin ? `
        <div class="field-row">
          <div class="field">
            <label>每期最低还款比例（%）</label>
            <input id="d-minrate" type="number" min="1" max="100" step="1" value="${f.minRate}">
          </div>
          <div class="field">
            <label>每期应还（元）· 按比例 + 年利率自动计算</label>
            <input id="d-per" class="big" type="text" readonly placeholder="填写金额后自动计算">
          </div>
        </div>` : isPrivate ? `
        <div class="field">
          <label>到期应还（元）· 本金 + 已产生利息，按年利率 × 实际天数自动计算</label>
          <input id="d-per" class="big" type="text" readonly placeholder="填写金额、约定还款日期与年利率后自动计算">
        </div>` : `
        <div class="field-row">
          <div class="field">
            <label>还款期数</label>
            <input id="d-periods" type="number" min="1" max="360" step="1" value="${f.periods}">
          </div>
          <div class="field">
            <label>${f.kind === 'principal' || isDaily ? '首期应还（元）· 按年利率自动计算' : '每期应还（元）· 按年利率自动计算'}</label>
            <input id="d-per" class="big" type="text" readonly placeholder="填写金额、期数与年利率后自动计算">
          </div>
        </div>`}

      <div class="preview-box" id="d-preview"></div>
      <div class="form-error" id="d-err"></div>

      <div class="modal-actions">
        ${f.id ? `<button class="btn danger left" data-action="debt-delete" data-id="${f.id}">删除</button>` : ''}
        <button class="btn plain" data-action="close-modal">取消</button>
        <button class="btn" data-action="debt-save">保存</button>
      </div>
    </div>`;
  updateDebtPreview();
}

/** 用当前表单参数构造临时负债，直接复用 debtSchedule 得到真实计划 */
function draftSchedule(f, total, n) {
  return debtSchedule({
    kind: REPAY_METHODS[f.kind] ? f.kind : 'equal',
    total,
    borrowDate: f.borrowDate || todayStr(),
    firstDue: f.firstDue || todayStr(),
    periods: n,
    minRate: Number(f.minRate) > 0 ? Number(f.minRate) / 100 : 0.1,
    annualRate: Math.max(0, Number(f.annualRate) || 0),
    payments: []
  });
}

function updateDebtPreview() {
  syncDebtInputs();
  const f = state.debtForm;
  const box = $('#d-preview');
  const perEl = $('#d-per');
  if (!f || !box) return;
  const total = Number(f.total) || 0;
  const rate = Math.max(0, Number(f.annualRate) || 0);
  const n = Math.max(1, Math.round(Number(f.periods) || 1));
  if (total <= 0 || !f.firstDue) {
    if (perEl) perEl.value = '';
    box.innerHTML = '填写欠款金额、年利率与日期后，这里会按还款方式自动算出每期应还与还款计划。';
    return;
  }

  const rows = draftSchedule(f, round2(total), n);
  const per = rows[0] ? rows[0].amount : 0;
  const last = rows.length ? rows[rows.length - 1] : null;
  const interestSum = round2(rows.reduce((s, r) => s + (r.interest || 0), 0));
  if (perEl) perEl.value = per > 0 ? per.toFixed(2) : '';

  if (f.kind === 'minimum') {
    const pct = Math.min(100, Math.max(1, Number(f.minRate) || 10));
    box.innerHTML = `本期应还约 <b>${money(per)}</b>（最低 ${pct.toFixed(0)}% + 当期利息）· 年利率 <b>${rate}%</b> · 预计 <b>${rows.length}</b> 期还清 · 还清日约 <b>${rows.length ? dateLabel(last.date) : '—'}</b>`;
  } else if (f.kind === 'private') {
    const days = Math.max(0, daysDiff(f.borrowDate || todayStr(), f.firstDue));
    const principal = round2(per - (rows[0] ? rows[0].interest : 0));
    box.innerHTML = `约定还款日 <b>${dateLabel(f.firstDue)}</b> · 到期一次性归还 <b>${money(per)}</b>${rate > 0 ? `（本金 ${money(principal)} + 利息 ${money(round2(per - principal))}）· 年利率 ${rate}% · 期间 <b>${days}</b> 天` : '（无约定利息，只还本金）'}`;
  } else if (f.kind === 'interest') {
    box.innerHTML = `每期只还利息 <b>${money(per)}</b> · 末期一次性还本付息 <b>${money(last ? last.amount : total)}</b> · 共 <b>${rows.length}</b> 期 · 利息合计 <b>${money(interestSum)}</b> · 还清日 <b>${rows.length ? dateLabel(last.date) : '—'}</b>`;
  } else if (f.kind === 'principal') {
    const perPri = rows[0] ? rows[0].principal : 0;
    box.innerHTML = `首期应还 <b>${money(per)}</b>（每期本金固定 <b>${money(perPri)}</b> + 当期利息，利息随剩余本金递减）· 年利率 ${rate}% · 共 <b>${rows.length}</b> 期 · 末期 <b>${money(last ? last.amount : 0)}</b> · 利息合计 <b>${money(interestSum)}</b> · 还清日 <b>${rows.length ? dateLabel(last.date) : '—'}</b>`;
  } else if (f.kind === 'daily') {
    const firstDays = Math.max(0, daysDiff(f.borrowDate || todayStr(), f.firstDue));
    const perPri = rows[0] ? rows[0].principal : 0;
    const dailyPct = String(Number((rate / 365).toFixed(4)));
    box.innerHTML = `首期（${firstDays} 天）应还 <b>${money(per)}</b>（本金均分 <b>${money(perPri)}</b> + 剩余本金 × 日利率 ${dailyPct}% × 实际天数）· 年化 ${rate}% · 共 <b>${rows.length}</b> 期 · 末期 <b>${money(last ? last.amount : 0)}</b> · 利息合计 <b>${money(interestSum)}</b> · 还清日 <b>${rows.length ? dateLabel(last.date) : '—'}</b>`;
  } else {
    const dailyPct = String(Number((rate / 365).toFixed(4)));
    box.innerHTML = `每期固定应还 <b>${money(per)}</b>（按日计息：日利率 ${dailyPct}% × 当期实际天数，利息随剩余本金递减，本息定额均摊）· 年化 ${rate}% · 共 <b>${rows.length}</b> 期 · 末期 <b>${money(last ? last.amount : 0)}</b> · 利息合计 <b>${money(interestSum)}</b> · 还清日 <b>${rows.length ? dateLabel(last.date) : '—'}</b>`;
  }
}

function saveDebtForm() {
  syncDebtInputs();
  const f = state.debtForm;
  const err = $('#d-err');
  if (!f || !err) return;
  const total = round2(Number(f.total));
  if (!String(f.platform || '').trim()) { err.textContent = '请填写欠款平台名称'; return; }
  if (!f.total || !isFinite(total) || total <= 0) { err.textContent = '请输入有效的欠款总金额'; return; }
  if (!f.borrowDate) { err.textContent = '请选择欠债日期'; return; }
  if (!f.firstDue) { err.textContent = '请选择应还日期'; return; }
  if (f.firstDue < f.borrowDate) { err.textContent = f.kind === 'private' ? '约定还款日期不能早于欠债日期' : '应还日期不能早于欠债日期'; return; }
  if (!REPAY_METHODS[f.kind]) { err.textContent = '请选择还款方式'; return; }
  if (!isFinite(Number(f.annualRate)) || Number(f.annualRate) < 0) { err.textContent = '请输入有效的年利率'; return; }

  // 民间借贷只有约定还款日一期
  const periods = f.kind === 'private' ? 1 : Math.max(1, Math.round(Number(f.periods) || 12));
  // 每期应还完全由「还款方式 + 年利率 + 期数」自动算出，保存时回写存档
  const rows = draftSchedule({ ...f, periods }, total, periods);

  const payload = {
    platform: String(f.platform).trim(),
    kind: f.kind,
    total,
    borrowDate: f.borrowDate,
    firstDue: f.firstDue,
    periods,
    perPeriod: round2(rows[0] && rows[0].amount > 0 ? rows[0].amount : 0),
    minRate: Math.min(1, Math.max(0.01, (Number(f.minRate) || 10) / 100)),
    annualRate: round2(Math.max(0, Number(f.annualRate) || 0)),
    note: String(f.note || '').trim()
  };

  if (f.id) {
    const d = debtList().find((x) => x.id === f.id);
    if (d) Object.assign(d, payload);
  } else {
    state.data.debts.push({ id: newId(), payments: [], createdAt: Date.now(), ...payload });
  }
  persist();
  closeForm();
  render();
  toast(f.id ? '负债已更新 ✓' : '已添加负债 ✓');
}

function deleteDebt(id) {
  const d = debtList().find((x) => x.id === id);
  if (!d) return;
  if (!confirm(`确定删除「${d.platform}」的负债记录？\n已产生的还款交易会保留在账本中。`)) return;
  state.data.debts = debtList().filter((x) => x.id !== id);
  delete state.expanded[id];
  delete state.showFull[id];
  persist();
  closeForm();
  render();
  toast('已删除负债');
}

/* ---------- 还款操作（与交易记录联动） ---------- */

function recordPayment(d, row, date) {
  d.payments = Array.isArray(d.payments) ? d.payments : [];
  if (d.payments.some((p) => Number(p.no) === Number(row.no))) return false;
  d.payments.push({ no: Number(row.no), date, amount: round2(row.amount) });
  state.data.transactions.push({
    id: newId(),
    type: 'expense',
    amount: round2(row.amount),
    category: '还款',
    date,
    note: `${d.platform} 第${row.no}期`,
    paymentKey: `${d.id}:${row.no}`,
    createdAt: Date.now()
  });
  return true;
}

function payDebt(id, no) {
  const d = debtList().find((x) => x.id === id);
  if (!d) return;
  const row = debtSchedule(d).find((r) => r.no === Number(no));
  if (!row) return;
  if (!canMarkPaid(row.date)) {
    toast(`未到还款期 · ${dateLabel(row.date)} 起才可标记还款（当前仅开放至 ${dateLabel(payWindowEnd())}）`, true);
    return;
  }
  if (row.paid || !recordPayment(d, row, todayStr())) { toast('该期已还款', true); return; }
  persist();
  render();
  toast(`已还 ${money(row.amount)} · ${d.platform} 第${row.no}期（已同步到交易记录）`);
}

/** 提前还款：一次性结清剩余本金 + 已产生利息（同步生成一笔支出） */
function settleDebt(id) {
  const d = debtList().find((x) => x.id === id);
  if (!d) return;
  const info = settleAmount(d);
  if (!info.parts.length) { toast('该笔负债已全部结清', true); return; }
  const ok = confirm(`提前还清「${d.platform}」？\n一次性归还 ${money(info.total)}\n= 剩余本金 ${money(info.principal)} + 已产生利息 ${money(info.interest)}\n（未到期期次不计利息，已同步为一笔「还款」支出）`);
  if (!ok) return;

  const date = todayStr();
  d.payments = Array.isArray(d.payments) ? d.payments : [];
  info.parts.forEach((p) => {
    d.payments.push({ no: p.no, date, amount: p.amount, interest: p.interest, principal: p.principal, settle: true });
  });
  state.data.transactions.push({
    id: newId(),
    type: 'expense',
    amount: info.total,
    category: '还款',
    date,
    note: `${d.platform} 提前结清${info.parts.length > 1 ? `（${info.parts.length} 期）` : ''}`,
    paymentKey: `${d.id}:settle`,
    createdAt: Date.now()
  });
  persist();
  render();
  toast(`已提前结清 ${money(info.total)} · ${d.platform} ✓`);
}

/** 撤销提前结清：恢复各期待还，并删除结清交易 */
function unsettleDebt(id) {
  const d = debtList().find((x) => x.id === id);
  if (!d) return;
  d.payments = (d.payments || []).filter((p) => !p.settle);
  state.data.transactions = state.data.transactions.filter((t) => t.paymentKey !== `${id}:settle`);
}

function unpayDebt(id, no) {
  const d = debtList().find((x) => x.id === id);
  if (!d) return;
  const pay = (d.payments || []).find((p) => Number(p.no) === Number(no));
  if (pay && pay.settle) {
    if (!confirm(`撤销「${d.platform}」的提前结清？\n结清交易会一并删除，各期恢复为待还。`)) return;
    unsettleDebt(id);
    persist();
    render();
    toast('已撤销提前结清');
    return;
  }
  if (!confirm(`撤销「${d.platform} 第${no}期」的还款记录？\n对应的交易记录也会一并删除。`)) return;
  d.payments = (d.payments || []).filter((p) => Number(p.no) !== Number(no));
  const key = `${id}:${no}`;
  state.data.transactions = state.data.transactions.filter((t) => t.paymentKey !== key);
  persist();
  render();
  toast('已撤销还款');
}

/* ================= 设置 ================= */

function renderSettings() {
  const el = $('#view-settings');
  const txCount = state.data.transactions.length;
  const budgetCount = Object.values(state.data.budgets).filter((v) => Number(v) > 0).length;
  const debtCount = debtList().length;
  const debtLeft = debtCount ? debtSummary().remaining : 0;

  el.innerHTML = `
    <div class="page-head">
      <div><div class="page-title">设置</div><div class="page-sub">数据、导出与关于</div></div>
    </div>

    <div class="grid-2" style="grid-template-columns:1fr 1fr">
      <div class="card settings-block">
        <h3>数据管理</h3>
        <p>所有数据仅保存在本机，不会上传到任何服务器。</p>
        <div class="kv"><span class="k">交易记录</span><span class="v">${txCount} 笔</span></div>
        <div class="kv"><span class="k">预算分类</span><span class="v">${budgetCount} 个</span></div>
        <div class="kv"><span class="k">负债平台</span><span class="v">${debtCount} 个${debtCount ? ' · 剩余应还 ' + money(debtLeft) : ''}</span></div>
        <div class="kv"><span class="k">货币</span><span class="v">人民币 ¥ (CNY)</span></div>
        <div class="settings-actions" style="margin-top:14px">
          <button class="btn ghost" data-action="nav" data-view="import">导入账单 CSV</button>
          <button class="btn ghost" data-action="export">导出全部记录 CSV</button>
          <button class="btn ghost" data-action="debt-export" ${debtCount ? '' : 'disabled style="opacity:.5"'}>导出负债明细 CSV</button>
          <button class="btn plain" data-action="sample">载入示例数据</button>
          <button class="btn danger" data-action="clear">清空全部数据</button>
        </div>
      </div>

      <div class="card settings-block">
        <h3>数据存储位置</h3>
        <p>你的账本以 JSON 文件形式存放在应用数据目录，可手动备份。</p>
        <div class="path-box" id="data-path">${esc(state.dataPathText) || '读取中…'}</div>

        <h3 style="margin-top:20px">关于</h3>
        <div class="kv"><span class="k">应用</span><span class="v">真好管账 v1.1.0</span></div>
        <div class="kv"><span class="k">技术栈</span><span class="v">Electron + 原生 JS</span></div>
        <div class="kv"><span class="k">快捷键</span><span class="v">Ctrl+N 记账 · Esc 关闭弹窗</span></div>
      </div>
    </div>

    <div class="card" style="margin-top:4px">
      <div class="card-head">
        <div class="card-title">分类管理</div>
        <div class="card-note">记账时可选的支出 / 收入分类，支持新增、编辑与删除</div>
      </div>
      <div class="cat-mgr">
        ${['expense', 'income'].map((type) => {
          const list = catList(type);
          const label = type === 'expense' ? '支出分类' : '收入分类';
          return `
          <div class="cat-group">
            <div class="cat-group-head">
              <span class="cat-group-title">${label}<i>${list.length}</i></span>
              <button class="btn ghost sm" data-action="cat-add" data-type="${type}">＋ 新增分类</button>
            </div>
            <div class="cat-chips">
              ${list.map((c) => `
                <span class="cat-item">
                  <i class="cat-dot" style="background:${catColor(c, type)}"></i>${esc(c)}
                  <button class="icon-btn" title="重命名" data-action="cat-edit" data-type="${type}" data-cat="${esc(c)}">✎</button>
                  <button class="icon-btn del" title="删除" data-action="cat-del" data-type="${type}" data-cat="${esc(c)}">🗑</button>
                </span>`).join('')}
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="hint-line">重命名会同步更新该分类的历史记录与预算；删除不会删除任何交易记录（旧记录仍可在筛选中选到）。每种类型至少保留 1 个分类。</div>
    </div>`;

  window.api.dataPath().then((p) => {
    state.dataPathText = p;
    const box = $('#data-path');
    if (box) box.textContent = p;
  }).catch(() => {});
}

/* ================= 导入账单 ================= */

let impDragDepth = 0; // 拖拽高亮用的进入计数（dragleave 会因子元素反复触发）

/** 导入页初始态：拖拽区 + 各平台导出指引 */
function importEmptyHtml() {
  const err = state.imp && state.imp.error;
  return `
    <div class="page-head">
      <div><div class="page-title">导入账单</div><div class="page-sub">支付宝 / 微信支付 / 银行流水 → 自动变成收支记录</div></div>
    </div>
    <div class="card">
      <div class="drop-zone" id="drop-zone">
        <div class="dz-ico">📥</div>
        <h3>把账单文件拖到这里</h3>
        <button class="btn" data-action="imp-pick">选择账单文件</button>
        <p class="dz-note">支持 CSV 明细账单（UTF-8 / GBK 编码均可）<br>文件只在本机解析，不会上传到任何服务器</p>
      </div>
      ${err ? `<div class="imp-error">⚠ ${esc(err)}</div>` : ''}
    </div>
    <div class="grid-2" style="grid-template-columns:repeat(3,1fr);margin-top:14px">
      <div class="card settings-block">
        <h3>🟣 支付宝</h3>
        <p>支付宝 App →「我的」→「账单」→ 右上角「…」→「开具交易流水证明」，或网页版 bills.alipay.com 下载明细 CSV。</p>
      </div>
      <div class="card settings-block">
        <h3>🟢 微信支付</h3>
        <p>微信 →「我」→「服务」→「钱包」→「账单」→ 右上角「…」→「下载账单」→「用于个人对账」导出 CSV。</p>
      </div>
      <div class="card settings-block">
        <h3>🏦 网银流水</h3>
        <p>各银行手机银行 / 网银的「交易明细 / 流水」导出功能，选择 CSV 明细文件即可（GBK 编码也支持）。</p>
      </div>
    </div>
    <div class="card">
      <div class="hint-line" style="margin-top:0">导入流程：<b>选择文件</b> → 自动识别格式、判断收支、匹配分类 → <b>逐条预览</b>（可改类型 / 分类，自动查重）→ <b>导入</b>。导入后可在「交易记录」中继续编辑或删除。</div>
    </div>`;
}

function impFilteredRows() {
  const imp = state.imp;
  if (!imp || !Array.isArray(imp.rows)) return [];
  if (imp.filter === 'ok') return imp.rows.filter((r) => r.checked && r.type);
  if (imp.filter === 'flag') return imp.rows.filter((r) => r.dup || r.flag);
  return imp.rows;
}

function impStats() {
  const rows = (state.imp && state.imp.rows) || [];
  let sel = 0, exp = 0, inc = 0, dup = 0, flag = 0;
  rows.forEach((r) => {
    if (r.dup) dup++;
    if (r.flag) flag++;
    if (r.checked && r.type) {
      sel++;
      if (r.type === 'income') inc += r.amount;
      else exp += r.amount;
    }
  });
  return {
    total: rows.length,
    sel,
    exp: round2(exp),
    inc: round2(inc),
    dup,
    flag,
    flagged: rows.filter((r) => r.dup || r.flag).length
  };
}

/** 查重：已存在（账本中完全相同）/ 文件内重复 / 疑似重复（同日同金额）默认不勾选 */
function impRecomputeDup() {
  const imp = state.imp;
  if (!imp || !Array.isArray(imp.rows)) return;
  const exact = new Set();
  const near = new Set();
  state.data.transactions.forEach((t) => {
    exact.add(Stmt.fingerprint(t));
    near.add(`${t.date}|${t.type}|${round2(t.amount).toFixed(2)}`);
  });
  const seen = new Set();
  imp.rows.forEach((r) => {
    r.dup = null;
    if (!r.type) { if (!r.userSet) r.checked = false; return; }
    const fp = Stmt.fingerprint(r);
    const nk = `${r.date}|${r.type}|${round2(r.amount).toFixed(2)}`;
    if (exact.has(fp)) r.dup = { label: '已存在', tip: '账本中已有相同记录，导入会重复' };
    else if (seen.has(fp)) r.dup = { label: '文件内重复', tip: '同一文件中出现过相同记录' };
    else if (near.has(nk)) r.dup = { label: '疑似重复', tip: '账本中有同日同金额的记录，请确认' };
    seen.add(fp);
    if (!r.userSet) r.checked = !r.dup && !r.flag;
  });
}

function impRowHtml(r) {
  const cats = r.type ? catList(r.type) : [];
  const cat = cats.includes(r.cat) ? r.cat : (cats[0] || '');
  const mark = r.dup || (r.flag ? { label: r.flag, tip: r.tip } : null);
  const sign = r.type === 'income' ? '+' : r.type === 'expense' ? '−' : '';
  return `
    <tr class="${r.checked ? '' : 'off'}">
      <td><input type="checkbox" class="imp-cb" data-i="${r.idx}" ${r.checked ? 'checked' : ''}></td>
      <td style="color:#64748b;white-space:nowrap">${dateLabel(r.date)}</td>
      <td>
        <select class="imp-type" data-i="${r.idx}" title="类型">
          <option value="" ${r.type ? '' : 'selected'}>不导入</option>
          <option value="expense" ${r.type === 'expense' ? 'selected' : ''}>支出</option>
          <option value="income" ${r.type === 'income' ? 'selected' : ''}>收入</option>
        </select>
      </td>
      <td>${r.type
        ? `<select class="imp-cat" data-i="${r.idx}" title="分类">${cats.map((c) => `<option value="${esc(c)}" ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`
        : '<span class="imp-na">—</span>'}</td>
      <td><span class="imp-note">${r.note ? esc(r.note) : '<span class="imp-na">—</span>'}</span>${mark ? `<span class="badge flag ${r.dup ? 'dup' : ''}" title="${esc(mark.tip || '')}">${esc(mark.label)}</span>` : ''}</td>
      <td class="amount ${r.type === 'income' ? 'in' : r.type === 'expense' ? 'out' : 'none'}">${sign}${money(r.amount)}</td>
    </tr>`;
}

function renderImport() {
  const el = $('#view-import');
  if (!el) return;
  const imp = state.imp;
  if (!imp || !Array.isArray(imp.rows) || !imp.rows.length) { el.innerHTML = importEmptyHtml(); return; }

  const main = $('.main');
  const scroll = main ? main.scrollTop : 0;
  // 记住当前焦点控件，重建 DOM 后恢复（改下拉 / 勾选不丢焦点）
  const ae = document.activeElement;
  let focusSel = '';
  if (ae) {
    if (ae.id === 'imp-all' || ae.id === 'imp-filter') focusSel = '#' + ae.id;
    else if (ae.dataset && ae.dataset.i != null && /imp-(cb|type|cat)/.test(ae.className || '')) {
      const cls = (ae.className.match(/imp-(?:cb|type|cat)/) || [''])[0];
      if (cls) focusSel = `.${cls}[data-i="${ae.dataset.i}"]`;
    }
  }

  const st = impStats();
  const list = impFilteredRows();
  const limit = imp.limit || 200;
  const shown = list.slice(0, limit);
  const filter = imp.filter || 'all';
  const typed = imp.rows.filter((r) => r.type);
  const allChecked = typed.length > 0 && typed.every((r) => r.checked);

  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">导入账单</div>
        <div class="page-sub">${esc(imp.fileName || '')} · 识别为 <b>${esc(imp.sourceLabel || '未知格式')}</b> · 共 ${st.total} 条${imp.skipped ? ` · 跳过 ${imp.skipped} 行无效行` : ''}</div>
      </div>
      <div class="head-actions">
        <button class="btn plain" data-action="imp-reset">重新选择</button>
        <button class="btn" data-action="imp-import" ${st.sel ? '' : 'disabled style="opacity:.5"'}>导入 ${st.sel} 笔</button>
      </div>
    </div>

    <div class="card">
      <div class="toolbar">
        <label class="imp-all"><input type="checkbox" id="imp-all" ${allChecked ? 'checked' : ''}> 全选</label>
        <select id="imp-filter" title="筛选">
          <option value="all" ${filter === 'all' ? 'selected' : ''}>显示全部 ${st.total} 条</option>
          <option value="ok" ${filter === 'ok' ? 'selected' : ''}>只看已勾选 ${st.sel} 条</option>
          <option value="flag" ${filter === 'flag' ? 'selected' : ''}>只看重复 / 忽略 ${st.flagged} 条</option>
        </select>
        <div class="spacer"></div>
        <div class="summary-line" style="margin:0">
          已选 <b>${st.sel}</b> 笔 · 支出 <b style="color:#dc2626">${money(st.exp)}</b> · 收入 <b style="color:#16a34a">${money(st.inc)}</b>
          · 重复 <b>${st.dup}</b> · 已忽略 <b>${st.flag}</b>
        </div>
      </div>
      <div class="table-wrap">
        <table class="imp-table">
          <thead>
            <tr><th style="width:34px"></th><th style="width:98px">日期</th><th style="width:92px">类型</th><th style="width:132px">分类</th><th>说明</th><th style="width:118px">金额</th></tr>
          </thead>
          <tbody>${shown.map(impRowHtml).join('')}</tbody>
        </table>
      </div>
      ${list.length > shown.length ? `<div class="imp-more"><button class="btn plain sm" data-action="imp-more">显示更多（已显示 ${shown.length} / ${list.length} 条）</button></div>` : ''}
      <div class="hint-line">带「已存在 / 文件内重复 / 疑似重复」标记的记录默认不勾选，避免重复记账；还款类自动计为支出，退款与收益发放类自动计为收入；「不计收支」（自转账、余额充值等）、已关闭与含退款状态的交易默认跳过（含退款的已预填收入），均可逐条调整。导入后可在「交易记录」中继续编辑或删除。</div>
    </div>`;

  if (main && scroll) main.scrollTop = scroll;
  if (focusSel) { const fe = el.querySelector(focusSel); if (fe) fe.focus(); }
}

/** 解析文件 → 建立预览（含查重） */
async function ingestStatement(name, bytes) {
  try {
    const parsed = Stmt.parse(Stmt.decode(bytes), { cats: (type) => catList(type) });
    if (parsed.error) {
      state.imp = { fileName: name, error: parsed.error, rows: null };
      renderImport();
      toast(parsed.error, true);
      return;
    }
    state.imp = {
      fileName: name,
      source: parsed.source,
      sourceLabel: parsed.sourceLabel,
      rows: parsed.rows,
      skipped: parsed.skipped || 0,
      error: '',
      limit: 200,
      filter: 'all'
    };
    impRecomputeDup();
    renderImport();
    const st = impStats();
    toast(`已解析 ${st.total} 条（${parsed.sourceLabel}）· 勾选 ${st.sel} 笔待导入`);
  } catch (err) {
    toast('解析失败：' + err.message, true);
  }
}

async function pickStatementFile() {
  try {
    const r = await window.api.pickStatement();
    if (!r || r.canceled) return;
    if (!r.ok) { toast(r.error || '读取文件失败', true); return; }
    await ingestStatement(r.name, r.bytes);
  } catch (err) {
    toast('读取文件失败：' + err.message, true);
  }
}

/** 把勾选的行写入账本 */
function doImport() {
  const rows = ((state.imp && state.imp.rows) || []).filter((r) => r.checked && r.type && r.amount > 0);
  if (!rows.length) { toast('请先勾选要导入的记录', true); return; }
  const now = Date.now();
  let exp = 0, inc = 0;
  rows.forEach((r, i) => {
    const cats = catList(r.type);
    const cat = cats.includes(r.cat) ? r.cat : (cats.includes('其他') ? '其他' : (cats[0] || '其他'));
    state.data.transactions.push({
      id: newId(),
      type: r.type,
      amount: round2(Math.abs(r.amount)),
      category: cat,
      date: r.date,
      note: r.note || '',
      src: (state.imp && state.imp.source) || '',
      paymentKey: '',
      createdAt: now - (rows.length - i)
    });
    if (r.type === 'income') inc += r.amount;
    else exp += r.amount;
  });
  state.imp = null;
  state.txMonth = 'all';
  state.fType = 'all';
  state.fCat = 'all';
  state.fQ = '';
  persist();
  state.view = 'transactions';
  render();
  toast(`已导入 ${rows.length} 笔 · 支出 ${money(round2(exp))} · 收入 ${money(round2(inc))}`);
}

/** 导入页内的 change 事件；处理了返回 true */
function impChange(e) {
  const imp = state.imp;
  if (!imp || !Array.isArray(imp.rows)) return false;
  const t = e.target;
  const cls = (t && t.className && String(t.className)) || '';

  if (t.id === 'imp-all') {
    const on = !!t.checked;
    let n = 0;
    imp.rows.forEach((r) => { if (r.type) { r.checked = on; r.userSet = true; n++; } });
    if (!n) toast('当前没有可勾选的记录（请先在「类型」列选择支出 / 收入）', true);
    renderImport();
    return true;
  }
  if (t.id === 'imp-filter') { imp.filter = t.value; imp.limit = 200; renderImport(); return true; }
  if (/\bimp-cb\b/.test(cls)) {
    const r = imp.rows[Number(t.dataset.i)];
    if (r) { r.checked = !!t.checked; r.userSet = true; }
    renderImport();
    return true;
  }
  if (/\bimp-type\b/.test(cls)) {
    const r = imp.rows[Number(t.dataset.i)];
    if (r) {
      r.type = t.value === 'income' || t.value === 'expense' ? t.value : '';
      r.userSet = true;
      r.cat = r.type ? Stmt.autoCategory(r.type, r.text, r.hint, catList(r.type)) : '';
      impRecomputeDup();
      r.checked = !!r.type && !r.dup;
      renderImport();
    }
    return true;
  }
  if (/\bimp-cat\b/.test(cls)) {
    const r = imp.rows[Number(t.dataset.i)];
    if (r) r.cat = t.value;
    return true;
  }
  return false;
}

/* ================= 记账弹窗 ================= */

function openForm(tx) {
  state.form = tx
    ? { ...tx }
    : { id: null, type: 'expense', amount: '', category: '', date: todayStr(), note: '' };
  renderForm();
  $('#modal-root').classList.remove('hidden');
  setTimeout(() => { const el = $('#f-amount'); if (el) el.focus(); }, 30);
}

function closeForm() {
  $('#modal-root').classList.add('hidden');
  $('#modal-root').innerHTML = '';
  state.form = null;
  state.debtForm = null;
  state.catForm = null;
  if (state.pendingReload) { state.pendingReload = false; externalDataChanged(); }
}

/* ---------- 分类新增 / 重命名弹窗 ---------- */

function openCatForm(type, oldName) {
  state.catForm = { type, oldName: oldName || null, value: oldName || '' };
  renderCatForm();
  $('#modal-root').classList.remove('hidden');
  setTimeout(() => { const el = $('#cat-name'); if (el) { el.focus(); el.select(); } }, 30);
}

function renderCatForm() {
  const c = state.catForm;
  if (!c) return;
  const label = c.type === 'expense' ? '支出' : '收入';
  const used = c.oldName
    ? state.data.transactions.filter((t) => t.type === c.type && t.category === c.oldName).length
    : 0;
  $('#modal-root').innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>${c.oldName ? '重命名' : '新增'}${label}分类</h2>
        <button class="icon-btn" data-action="close-modal" title="关闭">✕</button>
      </div>

      <div class="field">
        <label>分类名称（最多 10 个字）</label>
        <input id="cat-name" type="text" maxlength="10" placeholder="如：宠物、旅行、理财" value="${esc(c.value)}">
      </div>

      ${c.oldName ? `<div class="hint-line">该分类下已有 <b>${used}</b> 笔记录，重命名后会同步更新${c.type === 'expense' ? '这些记录、预算与筛选项' : '这些记录与筛选项'}。</div>` : `<div class="hint-line">新增后即可在「记一笔」与预算页中选择该分类。</div>`}
      <div class="form-error" id="cat-err"></div>

      <div class="modal-actions">
        <button class="btn plain" data-action="close-modal">取消</button>
        <button class="btn" data-action="cat-save">保存</button>
      </div>
    </div>`;
}

function saveCatForm() {
  const c = state.catForm;
  const err = $('#cat-err');
  const input = $('#cat-name');
  if (!c || !err || !input) return;
  const name = input.value.trim().slice(0, 10);
  if (!name) { err.textContent = '请输入分类名称'; return; }
  if (name === c.oldName) { closeForm(); return; }
  const list = [...catList(c.type)];
  if (list.includes(name)) { err.textContent = `「${name}」已存在，请换一个名称`; return; }

  const label = c.type === 'expense' ? '支出' : '收入';
  let msg = '';
  if (c.oldName) {
    // 重命名：列表 + 历史记录 + 预算 + 筛选项
    const i = list.indexOf(c.oldName);
    if (i < 0) { closeForm(); return; }
    list[i] = name;
    let n = 0;
    state.data.transactions.forEach((t) => {
      if (t.type === c.type && t.category === c.oldName) { t.category = name; n += 1; }
    });
    if (c.type === 'expense' && state.data.budgets[c.oldName] !== undefined) {
      state.data.budgets[name] = round2(Number(state.data.budgets[c.oldName]) || 0);
      delete state.data.budgets[c.oldName];
    }
    if (state.fCat === c.oldName) state.fCat = name;
    msg = `已重命名为「${name}」${n ? ` · ${n} 笔记录已同步` : ''}`;
  } else {
    list.push(name);
    msg = `已新增${label}分类「${name}」`;
  }

  const s = state.data.settings || (state.data.settings = {});
  const cats = s.categories || (s.categories = {});
  cats[c.type] = list;
  if (state.fType !== 'all' && state.fType !== c.type) state.fCat = 'all';
  persist();
  closeForm();
  render();
  toast(msg + ' ✓');
}

function deleteCategory(type, name) {
  const list = [...catList(type)];
  if (list.length <= 1) { toast('每种类型至少保留 1 个分类', true); return; }
  const label = type === 'expense' ? '支出' : '收入';
  const used = state.data.transactions.filter((t) => t.type === type && t.category === name).length;
  const msg = used
    ? `删除${label}分类「${name}」？\n该分类下已有 ${used} 笔记录：记录会保留，且仍可在筛选中选择。`
    : `删除${label}分类「${name}」？`;
  if (!confirm(msg)) return;

  const s = state.data.settings || (state.data.settings = {});
  const cats = s.categories || (s.categories = {});
  cats[type] = list.filter((c) => c !== name);
  if (type === 'expense' && state.data.budgets[name] !== undefined) delete state.data.budgets[name];
  if (state.fCat === name) state.fCat = 'all';
  persist();
  render();
  toast(`已删除${label}分类「${name}」`);
}

function syncFormInputs() {
  const f = state.form;
  if (!f) return;
  const amt = $('#f-amount'), date = $('#f-date'), note = $('#f-note');
  if (amt) f.amount = amt.value;
  if (date) f.date = date.value;
  if (note) f.note = note.value;
}

function renderForm() {
  const f = state.form;
  if (!f) return;
  const cats = [...catList(f.type)];
  if (f.category && !cats.includes(f.category)) cats.push(f.category); // 分类被删过时仍保留可选
  const isIncome = f.type === 'income';

  $('#modal-root').innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>${f.id ? '编辑记录' : '记一笔'}</h2>
        <button class="icon-btn" data-action="close-modal" title="关闭">✕</button>
      </div>

      <div class="seg">
        <button data-action="form-type" data-type="expense" class="${!isIncome ? 'active' : ''}">支出</button>
        <button data-action="form-type" data-type="income" class="${isIncome ? 'active' : ''}">收入</button>
      </div>

      <div class="field">
        <label>金额（元）</label>
        <input id="f-amount" class="big" type="number" min="0" step="0.01" inputmode="decimal"
               placeholder="0.00" value="${f.amount === '' ? '' : esc(f.amount)}">
      </div>

      <div class="field">
        <label>分类</label>
        <div class="chips">
          ${cats.map((c) => `
            <button type="button" class="chip ${f.category === c ? 'active' : ''} ${isIncome ? 'income-chip' : ''}"
                    data-action="form-cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>日期</label>
          <input id="f-date" type="date" value="${esc(f.date)}">
        </div>
        <div class="field">
          <label>备注</label>
          <input id="f-note" type="text" maxlength="30" placeholder="可选" value="${esc(f.note)}">
        </div>
      </div>

      <div class="form-error" id="f-err"></div>

      <div class="modal-actions">
        ${f.id ? `<button class="btn danger left" data-action="delete" data-id="${f.id}">删除</button>` : ''}
        <button class="btn plain" data-action="close-modal">取消</button>
        <button class="btn" data-action="save-form">保存</button>
      </div>
    </div>`;
}

function saveForm() {
  syncFormInputs();
  const f = state.form;
  const err = $('#f-err');
  const amount = round2(Number(f.amount));
  if (!f.amount || !isFinite(amount) || amount <= 0) { err.textContent = '请输入有效金额（大于 0）'; return; }
  if (!f.category) { err.textContent = '请选择分类'; return; }
  if (!f.date) { err.textContent = '请选择日期'; return; }

  if (f.id) {
    const t = state.data.transactions.find((x) => x.id === f.id);
    if (t) Object.assign(t, { type: f.type, amount, category: f.category, date: f.date, note: f.note.trim() });
  } else {
    state.data.transactions.push({
      id: newId(),
      type: f.type,
      amount,
      category: f.category,
      date: f.date,
      note: f.note.trim(),
      createdAt: Date.now()
    });
  }
  persist();
  closeForm();
  render();
  toast(f.id ? '已更新 ✓' : '已记账 ✓');
}

function deleteTx(id) {
  if (!confirm('确定删除这笔记录吗？')) return;
  const before = state.data.transactions.length;
  const tx = state.data.transactions.find((t) => t.id === id);
  // 若这笔支出是负债还款自动生成的，同时撤销对应期数的还款标记
  if (tx && tx.paymentKey) {
    const [did, no] = String(tx.paymentKey).split(':');
    const d = debtList().find((x) => x.id === did);
    if (d && d.payments) {
      d.payments = no === 'settle'
        ? d.payments.filter((p) => !p.settle)          // 提前结清：恢复全部期数
        : d.payments.filter((p) => String(p.no) !== String(no));
    }
  }
  state.data.transactions = state.data.transactions.filter((t) => t.id !== id);
  if (state.data.transactions.length === before) return;
  persist();
  closeForm();
  render();
  toast('已删除');
}

/* ================= 数据操作 ================= */

function exportCsv() {
  const rows = [['日期', '类型', '分类', '备注', '金额']];
  [...state.data.transactions]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .forEach((t) => {
      rows.push([t.date, t.type === 'income' ? '收入' : '支出', t.category, t.note, t.amount.toFixed(2)]);
    });
  const csv = '\uFEFF' + rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');

  window.api.exportCsv(csv, `财务记录-${todayStr()}.csv`)
    .then((r) => {
      if (r && r.ok) toast('已导出到 ' + r.path);
      else if (r && !r.canceled) toast('导出失败：' + r.error, true);
    })
    .catch((e) => toast('导出失败：' + e.message, true));
}

function exportDebts() {
  if (!debtList().length) { toast('暂无负债数据', true); return; }
  const rows = [['平台', '还款方式', '年利率(%)', '欠债日期', '应还日期', '期数', '总金额', '每期应还', '已还现金', '剩余应还', '状态']];
  debtList().forEach((d) => {
    const i = debtInfo(d);
    rows.push([
      d.platform, REPAY_METHODS[d.kind], Math.max(0, Number(d.annualRate) || 0),
      d.borrowDate, `每月${Number(String(d.firstDue).split('-')[2]) || 1}日`,
      d.kind !== 'minimum' ? `${i.paidCount}/${i.count}` : `已还${i.paidCount}/预计${i.count}`,
      i.total.toFixed(2), i.per.toFixed(2), i.cashPaid.toFixed(2), i.remaining.toFixed(2),
      i.done ? '已结清' : i.overdue.length ? `逾期${i.overdue.length}期` : '还款中'
    ]);
  });
  rows.push([]);
  rows.push(['平台', '期数', '应还日期', '应还金额', '状态', '还款日期']);
  debtList().forEach((d) => {
    debtSchedule(d).forEach((r) => {
      rows.push([
        d.platform, `第${r.no}期`, r.date, r.amount.toFixed(2),
        r.paid ? '已还' : r.status === 'overdue' ? '逾期' : '待还',
        r.paidInfo ? r.paidInfo.date : ''
      ]);
    });
  });
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n');

  window.api.exportCsv(csv, `负债明细-${todayStr()}.csv`)
    .then((r) => {
      if (r && r.ok) toast('已导出到 ' + r.path);
      else if (r && !r.canceled) toast('导出失败：' + r.error, true);
    })
    .catch((e) => toast('导出失败：' + e.message, true));
}

function seededRand(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function loadSample() {
  if ((state.data.transactions.length || debtList().length) && !confirm('载入示例数据会与现有记录合并，确定继续吗？')) return;

  const rnd = seededRand(20250101);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const between = (a, b) => a + rnd() * (b - a);
  const now = new Date();
  const txs = [];

  const plan = [
    ['餐饮', 12, [60, 140]], ['交通', 6, [30, 80]], ['购物', 4, [100, 500]],
    ['居住', 2, [200, 3200]], ['娱乐', 3, [50, 260]], ['医疗', 1, [30, 200]],
    ['教育', 1, [40, 200]], ['其他', 2, [20, 100]]
  ];

  for (let k = 5; k >= 0; k--) {
    const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const year = d.getFullYear(), month = d.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const maxDay = k === 0 ? now.getDate() : daysInMonth;
    const dateOn = (day) => `${year}-${pad2(month + 1)}-${pad2(Math.min(day, maxDay))}`;

    // 工资（每月 10 日）
    if (maxDay >= 10 || k > 0) {
      txs.push({ id: newId(), type: 'income', amount: 12000, category: '工资', date: dateOn(10), note: '月薪', createdAt: Date.now() - k * 1e9 });
    }
    // 偶发奖金
    if (rnd() < 0.35 && (maxDay >= 20 || k > 0)) {
      txs.push({ id: newId(), type: 'income', amount: round2(between(800, 3000)), category: rnd() < 0.5 ? '奖金' : '投资', date: dateOn(20), note: pick(['绩效奖金', '季度奖', '基金收益']), createdAt: Date.now() - k * 1e8 });
    }

    for (const [cat, n, [lo, hi]] of plan) {
      const cnt = Math.max(cat === '居住' ? 1 : 0, Math.round(n * between(0.75, 1.25)));
      for (let i = 0; i < cnt; i++) {
        const day = 1 + Math.floor(rnd() * maxDay);
        txs.push({
          id: newId(),
          type: 'expense',
          amount: round2(between(lo, hi)),
          category: cat,
          date: dateOn(day),
          note: pick(NOTES[cat] || ['']),
          createdAt: Date.now() - k * 1e7 - i
        });
      }
    }
  }

  state.data.transactions.push(...txs);

  // —— 负债示例（已有负债时不重复生成）——
  let debtSampleCount = 0;
  if (!debtList().length) {
    const mkDebt = (o) => ({ payments: [], note: '', minRate: 0.1, annualRate: 0, noAuto: false, createdAt: Date.now(), ...o });
    const samples = [
      // 支付宝借呗：借 5 万分 12 期，年利率 12%，已还 6 期（等额本息）
      mkDebt({
        id: newId(), platform: '支付宝借呗', kind: 'equal', total: 50000,
        borrowDate: addMonths(todayStr(), -6), firstDue: addMonths(todayStr(), -5),
        periods: 12, annualRate: 12, note: '消费周转'
      }),
      // 信用卡：欠 3 万，每期最低还款 + 年利率 18%（首期已逾期，演示还款提醒）
      mkDebt({
        id: newId(), platform: '招商银行信用卡', kind: 'minimum', total: 30000,
        borrowDate: addMonths(todayStr(), -2), firstDue: addDays(todayStr(), -4),
        periods: 12, minRate: 0.1, annualRate: 18, noAuto: true, note: '账单日每月 5 日'
      }),
      // 京东白条：先息后本 3 期免息，已结清示例
      mkDebt({
        id: newId(), platform: '京东白条', kind: 'interest', total: 2400,
        borrowDate: addMonths(todayStr(), -4), firstDue: addMonths(todayStr(), -3),
        periods: 3, annualRate: 0, note: '手机分期 · 已结清'
      }),
      // 借呗式：借 2 万分 6 期，年化 10.95%（日利率 0.03%）按日计息，首期约 33 天
      mkDebt({
        id: newId(), platform: '美团生意贷', kind: 'daily', total: 20000,
        borrowDate: addMonths(todayStr(), -3), firstDue: addMonths(todayStr(), -2),
        periods: 6, annualRate: 10.95, note: '日利率 0.03% · 按日计息'
      })
    ];
    samples.forEach((d) => {
      if (!d.noAuto) debtSchedule(d).forEach((r) => { if (r.date <= todayStr()) recordPayment(d, r, r.date); });
      delete d.noAuto;
      state.data.debts.push(d);
    });
    debtSampleCount = samples.length;
  }

  Object.assign(state.data.budgets, { 餐饮: 2500, 交通: 800, 购物: 1500, 居住: 3000, 娱乐: 600, 医疗: 300, 其他: 500 });
  persist();
  render();
  toast(`已载入 ${txs.length} 笔交易示例${debtSampleCount ? ` + ${debtSampleCount} 个负债示例` : ''}`);
}

function clearAll() {
  if (!confirm('确定清空全部数据吗？此操作不可恢复（建议先导出 CSV）。')) return;
  if (state.data.transactions.length && !confirm('再次确认：真的要删除所有记录吗？')) return;
  state.data.transactions = [];
  state.data.budgets = {};
  state.data.debts = [];
  state.expanded = {};
  state.showFull = {};
  state.txMonth = 'all';
  persist();
  render();
  toast('已清空全部数据');
}

/* ================= 事件绑定 ================= */

function bindEvents() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');

    // 点击弹窗遮罩：记账 / 新增负债弹窗不允许点遮罩关闭，只能手动关闭（✕ / 取消 / Esc）。
    // 否则在输入框中按住鼠标拖选文字、光标移出弹窗外松开时，会误触发遮罩点击导致弹窗消失。
    if (e.target.id === 'modal-root') {
      if (state.catForm) closeForm(); // 分类弹窗保留点遮罩关闭
      return;
    }
    if (!t) return;

    const a = t.dataset.action;
    switch (a) {
      case 'nav':
      case 'goto':
        state.view = t.dataset.view;
        render();
        break;
      case 'add': openForm(null); break;
      case 'edit': {
        const tx = state.data.transactions.find((x) => x.id === t.dataset.id);
        if (tx) openForm(tx);
        break;
      }
      case 'delete': deleteTx(t.dataset.id); break;
      case 'close-modal': closeForm(); break;
      case 'save-form': saveForm(); break;
      case 'form-type':
        syncFormInputs();
        state.form.type = t.dataset.type;
        state.form.category = '';
        renderForm();
        setTimeout(() => { const el = $('#f-amount'); if (el) { el.focus(); el.select && el.select(); } }, 10);
        break;
      case 'form-cat':
        syncFormInputs();
        state.form.category = t.dataset.cat;
        renderForm();
        break;
      case 'sample': loadSample(); break;
      case 'clear': clearAll(); break;
      case 'export': exportCsv(); break;
      case 'imp-pick': pickStatementFile(); break;
      case 'imp-reset': state.imp = null; renderImport(); break;
      case 'imp-more': state.imp.limit = (state.imp.limit || 200) + 300; renderImport(); break;
      case 'imp-import': doImport(); break;
      case 'cat-add': openCatForm(t.dataset.type, null); break;
      case 'cat-edit': openCatForm(t.dataset.type, t.dataset.cat); break;
      case 'cat-save': saveCatForm(); break;
      case 'cat-del': deleteCategory(t.dataset.type, t.dataset.cat); break;
      case 'debt-export': exportDebts(); break;
      case 'debt-add': openDebtForm(null); break;
      case 'debt-edit': {
        const d = debtList().find((x) => x.id === t.dataset.id);
        if (d) openDebtForm(d);
        break;
      }
      case 'debt-save': saveDebtForm(); break;
      case 'debt-delete': deleteDebt(t.dataset.id); break;
      case 'debt-expand': {
        const id = t.dataset.id;
        state.expanded[id] = !state.expanded[id];
        render();
        break;
      }
      case 'debt-full': {
        const id = t.dataset.id;
        state.showFull[id] = !state.showFull[id];
        render();
        break;
      }
      case 'pay': payDebt(t.dataset.id, t.dataset.no); break;
      case 'pay-locked': toast(`未到还款期 · 该期应还日为 ${dateLabel(t.dataset.date)}，当前仅开放至 ${dateLabel(payWindowEnd())}；如需提前还清可点「⏩ 提前结清」`, true); break;
      case 'debt-settle': settleDebt(t.dataset.id); break;
      case 'unpay': unpayDebt(t.dataset.id, t.dataset.no); break;
    }
  });

  document.addEventListener('change', (e) => {
    if (state.view === 'import' && impChange(e)) return;
    const id = e.target.id;
    // 还款方式下拉：切换后需重建表单（最低还款/等额/先息后本的字段不同）
    if (state.debtForm && id === 'd-kind') {
      syncDebtInputs();
      state.debtForm.kind = e.target.value;
      renderDebtForm();
      return;
    }
    // 欠债日期变化 → 首期应还日期自动重算（= 欠债日期 + 1 个月，可再手动改）
    if (state.debtForm && id === 'd-borrow' && e.target.value) {
      state.debtForm.borrowDate = e.target.value;
      const autoFirst = addMonths(e.target.value, 1);
      state.debtForm.firstDue = autoFirst;
      const fe = $('#d-first');
      if (fe) fe.value = autoFirst;
    }
    if (id === 'f-month') { state.txMonth = e.target.value; render(); }
    else if (id === 'f-type') { state.fType = e.target.value; state.fCat = 'all'; render(); }
    else if (id === 'f-cat') { state.fCat = e.target.value; render(); }
    else if (e.target.dataset && e.target.dataset.budget !== undefined) {
      const cat = e.target.dataset.budget;
      const v = Number(e.target.value);
      if (v > 0) state.data.budgets[cat] = round2(v);
      else delete state.data.budgets[cat];
      persist();
      render();
    }
    if (state.debtForm && String(e.target.id || '').startsWith('d-')) updateDebtPreview();
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'f-q') { state.fQ = e.target.value; renderTxList(); }
    if (state.debtForm && String(e.target.id || '').startsWith('d-')) updateDebtPreview();
  });

  // 导入账单页：拖拽解析文件（必须 preventDefault，否则 Electron 会导航到文件）
  document.addEventListener('dragover', (e) => {
    if (state.view !== 'import') return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragenter', (e) => {
    if (state.view !== 'import') return;
    impDragDepth += 1;
    const z = document.getElementById('drop-zone');
    if (z) z.classList.add('drag');
  });
  document.addEventListener('dragleave', () => {
    if (state.view !== 'import') return;
    impDragDepth = Math.max(0, impDragDepth - 1);
    if (!impDragDepth) { const z = document.getElementById('drop-zone'); if (z) z.classList.remove('drag'); }
  });
  document.addEventListener('drop', (e) => {
    if (state.view !== 'import') return;
    e.preventDefault();
    impDragDepth = 0;
    const z = document.getElementById('drop-zone');
    if (z) z.classList.remove('drag');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    f.arrayBuffer()
      .then((buf) => ingestStatement(f.name, buf))
      .catch((err) => toast('读取文件失败：' + err.message, true));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (state.form || state.debtForm || state.catForm)) { closeForm(); return; }
    // Enter = 提交当前打开的弹窗（记账 / 新增负债 / 分类），无需逐个字段绑定：
    // - isComposing：中文输入法选词的回车不触发提交
    // - BUTTON：焦点在按钮上时交给原生点击，避免与「保存」按钮重复触发
    // - TEXTAREA：保留换行
    if (e.key === 'Enter' && !e.isComposing && (state.form || state.debtForm || state.catForm)) {
      const tag = e.target && e.target.tagName;
      if (tag === 'BUTTON' || tag === 'TEXTAREA') return;
      e.preventDefault();
      if (state.debtForm) saveDebtForm();
      else if (state.catForm) saveCatForm();
      else saveForm();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && !state.form) {
      e.preventDefault();
      openForm(null);
    }
  });
}

/* ================= 启动 ================= */

async function init() {
  try {
    const d = await window.api.loadData();
    state.data = normalize(d);
  } catch (e) {
    console.error('加载数据失败:', e);
    toast('加载数据失败：' + e.message, true);
  }

  if (window.api.onDataChanged) window.api.onDataChanged(externalDataChanged);

  const months = monthsInData();
  state.txMonth = months.includes(ymNow()) ? ymNow() : 'all';

  bindEvents();
  render();
}

document.addEventListener('DOMContentLoaded', init);
