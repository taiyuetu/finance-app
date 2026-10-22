'use strict';

/**
 * finance-core.js — 与渲染进程（renderer/app.js）同构的财务核心逻辑
 * 供 MCP 服务器（mcp-server.js）读写同一份 finance-data.json 使用。
 * 数据规范化 / 还款计划 / 提前结清计算与应用内完全一致。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/* ================= 常量（与应用一致） ================= */

const CATEGORIES = {
  expense: ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '人情', '还款', '其他'],
  income: ['工资', '奖金', '兼职', '投资', '红包', '其他']
};

const REPAY_METHODS = {
  principal: '等额本金',
  equal: '等额本息',
  daily: '按日计息',
  minimum: '每期最低还款',
  interest: '先息后本还款',
  private: '民间借贷'
};
const LEGACY_KIND = { installment: 'equal', minimum: 'minimum', interest: 'interest' };

/* ================= 工具函数 ================= */

const round2 = (n) => Math.round(n * 100) / 100;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const pad2 = (n) => String(n).padStart(2, '0');
const ym = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const ymNow = () => ym(new Date());

function parseDate(s) {
  const [y, m, d] = String(s || '').split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}
const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function addMonths(s, n) {
  const d = parseDate(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return fmtDate(d);
}
function daysDiff(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
function shiftMonth(ymStr, delta) {
  const [y, m] = ymStr.split('-').map(Number);
  return ym(new Date(y, m - 1 + delta, 1));
}
function endOfMonthStr(ymStr) {
  const [y, m] = ymStr.split('-').map(Number);
  return fmtDate(new Date(y, m, 0));
}
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isYm = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));

/* ================= 数据规范化（与应用 normalize 同构） ================= */

function normalizeDebt(x) {
  let minRate = Number(x.minRate);
  if (!isFinite(minRate) || minRate <= 0) minRate = 0.1;
  else if (minRate > 1) minRate = minRate / 100;
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
      if (p.principal != null && isFinite(Number(p.principal))) pay.principal = round2(Number(p.principal));
      if (p.interest != null && isFinite(Number(p.interest))) pay.interest = round2(Number(p.interest));
      if (p.settle) pay.settle = true;
      return pay;
    }),
    createdAt: Number(x.createdAt || 0)
  };
}

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
    budgets: d && d.budgets && typeof d.budgets === 'object' && !Array.isArray(d.budgets) ? d.budgets : {},
    debts: (Array.isArray(d && d.debts) ? d.debts : [])
      .filter((x) => x && typeof x === 'object')
      .map(normalizeDebt),
    settings: normalizeSettings(d && d.settings)
  };
}

/* ================= 分类 ================= */

/** 某类型的分类列表：用户自定义优先，否则内置默认 + 历史用过 */
function catList(data, type) {
  const s = data && data.settings;
  const custom = s && s.categories && Array.isArray(s.categories[type]) ? s.categories[type] : null;
  if (custom && custom.length) return custom;
  return CATEGORIES[type] || CATEGORIES.expense;
}
function catOptionsList(data, type) {
  const used = (data.transactions || [])
    .filter((t) => t.type === type)
    .map((t) => t.category)
    .filter((c) => c && !catList(data, type).includes(c));
  return [...catList(data, type), ...used];
}

/* ================= 数据文件读写 ================= */

function defaultDataFile() {
  const home = os.homedir();
  let base;
  if (process.platform === 'win32') {
    base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support');
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  }
  // Electron 的 userData 目录取 package.json 的 productName（真好管账）；
  // 兼容旧版目录名：个人财务管家（旧版 productName）、finance-app（README 早期写法）
  const primary = path.join(base, '真好管账', 'finance-data.json');
  const legacyName = path.join(base, '个人财务管家', 'finance-data.json');
  const legacy = path.join(base, 'finance-app', 'finance-data.json');
  if (!fs.existsSync(primary)) {
    if (fs.existsSync(legacyName)) return legacyName;
    if (fs.existsSync(legacy)) return legacy;
  }
  return primary;
}

function dataFile() {
  return process.env.FINANCE_DATA_FILE || defaultDataFile();
}

function readData() {
  try {
    const raw = fs.readFileSync(dataFile(), 'utf8');
    return normalize(JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`读取数据失败: ${err.message}`);
    return normalize(null);
  }
}

function writeData(data) {
  const file = dataFile();
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(normalize(data), null, 2), 'utf8');
  fs.renameSync(tmp, file); // 原子替换（与应用一致），避免写一半损坏
}

/** 串行化读-改-写，避免并发工具调用互相覆盖 */
let _lock = Promise.resolve();
function withData(fn) {
  const run = _lock.then(async () => {
    const data = readData();
    const result = await fn(data);
    writeData(data);
    return result;
  });
  _lock = run.catch(() => {});
  return run;
}

/* ================= 还款计划（与应用 debtSchedule 同构） ================= */

function equalPerPeriod(total, rate, n) {
  if (!(total > 0) || n <= 0) return 0;
  if (!(rate > 0)) return round2(total / n);
  const f = Math.pow(1 + rate, n);
  const per = (total * rate * f) / (f - 1);
  return isFinite(per) && per > 0 ? round2(per) : round2(total / n);
}

/**
 * 生成某笔负债的还款计划表：
 * - principal（等额本金）：每期归还本金固定不变，利息按剩余本金计逐期递减，末期轧差
 * - equal（等额本息）：每期还款（本金+利息）总额固定，利息随剩余本金递减，末期轧差
 * - daily（按日计息·借呗口径）：每期本金固定，利息 = 剩余本金 × 日利率 × 当期实际天数
 * - minimum（每期最低还款）：按最低还款比例逐期冲抵本金
 * - interest（先息后本还款）：每期只还利息，末期还本
 * - private（民间借贷）：约定还款日一次性还本付息
 * 每期状态：paid 已还 / overdue 逾期 / due 待还
 */
function debtSchedule(d) {
  const paidMap = new Map((d.payments || []).map((p) => [Number(p.no), p]));
  const rows = [];
  const today = todayStr();
  const total = round2(Number(d.total) || 0);
  const rate = Math.max(0, Number(d.annualRate) || 0) / 1200;
  const push = (no, date, amount, interest, principal) => {
    const p = paidMap.get(no);
    let a = round2(amount), it = round2(interest), pr = round2(principal);
    if (p && p.principal != null) {
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
        if (remain - principal < 1) principal = remain;
        amount = round2(principal + interest);
      }
      push(i, date, amount, interest, principal);
      remain = round2(remain - principal);
      if (!p && principal <= 0) break;
    }
  } else if (d.kind === 'private') {
    const annual = Math.max(0, Number(d.annualRate) || 0) / 100;
    const days = Math.max(0, daysDiff(d.borrowDate || today, d.firstDue));
    const interest = annual > 0 ? round2((total * annual * days) / 365) : 0;
    push(1, d.firstDue, round2(total + interest), interest, total);
  } else {
    const n = Math.max(1, Math.round(Number(d.periods) || 1));
    if (d.kind === 'interest') {
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
        if (remain <= 0 && i < n) {
          for (let j = i + 1; j <= n; j++) push(j, addMonths(d.firstDue, j - 1), 0, 0, 0);
          break;
        }
      }
    } else if (d.kind === 'daily') {
      // 按日计息（借呗口径）：每期本金固定，利息 = 剩余本金 × 日利率 × 当期实际天数，末期轧差
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
        if (remain <= 0 && i < n) {
          for (let j = i + 1; j <= n; j++) push(j, addMonths(d.firstDue, j - 1), 0, 0, 0);
          break;
        }
      }
    } else {
      const per = equalPerPeriod(total, rate, n);
      let remain = total;
      for (let i = 1; i <= n; i++) {
        const interest = rate > 0 ? round2(remain * rate) : 0;
        let principal = round2(per - interest);
        let amount = per;
        if (i === n || principal >= remain) { principal = remain; amount = round2(principal + interest); }
        push(i, addMonths(d.firstDue, i - 1), amount, interest, principal);
        remain = round2(remain - principal);
        if (remain <= 0 && i < n) {
          for (let j = i + 1; j <= n; j++) push(j, addMonths(d.firstDue, j - 1), 0, 0, 0);
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

/** 单笔负债汇总（与应用 debtInfo 同构） */
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

/** 全部负债汇总（与应用 debtSummary 同构） */
function debtSummary(debts) {
  const m = ymNow();
  const nextM = shiftMonth(m, 1);
  const s = {
    count: debts.length, total: 0, paid: 0, remaining: 0,
    dueMonth: 0, dueMonthCount: 0, dueNextMonth: 0, dueNextMonthCount: 0,
    overdueCount: 0, soonCount: 0,
    paidCount: 0, unpaidCount: 0, next: null
  };
  debts.forEach((d) => {
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
      if (!s.next || r.date < s.next.date) s.next = { date: r.date, amount: r.amount, no: r.no, debtId: d.id, platform: d.platform };
    });
  });
  ['total', 'paid', 'remaining', 'dueMonth', 'dueNextMonth'].forEach((k) => { s[k] = round2(s[k]); });
  return s;
}

/* ================= 提前结清（与应用 settleAmount 同构） ================= */

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

/** 可标记还款截止日：本月 + 下月最后一日（与应用一致） */
const payWindowEnd = () => endOfMonthStr(shiftMonth(ymNow(), 1));
const canMarkPaid = (dateStr) => String(dateStr || '') <= payWindowEnd();

module.exports = {
  CATEGORIES, REPAY_METHODS, LEGACY_KIND,
  round2, newId, pad2, ym, todayStr, ymNow,
  parseDate, fmtDate, addMonths, daysDiff, shiftMonth, endOfMonthStr, isYmd, isYm,
  normalize, normalizeDebt, normalizeSettings, catList, catOptionsList,
  dataFile, defaultDataFile, readData, writeData, withData,
  equalPerPeriod, debtSchedule, debtInfo, debtSummary, settleAmount, payWindowEnd, canMarkPaid
};
