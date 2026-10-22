'use strict';

/**
 * mcp-server.js — 「个人财务管家」MCP 服务器
 *
 * 让外部 AI Agent（Claude Desktop / Claude Code / Cursor / pi / 任意 MCP 客户端）
 * 通过 MCP 协议查询与记账，读写与应用同一份 finance-data.json。
 *
 * 用法：
 *   node mcp-server.js                     # stdio 传输（本地客户端配置拉起）
 *   node mcp-server.js --http [端口]        # Streamable HTTP 传输（默认 3721，监听 127.0.0.1）
 *   node mcp-server.js --http 3721 --host 0.0.0.0 --token 密码   # 局域网/远程 + Bearer 鉴权
 *   FINANCE_DATA_FILE=/path/to/finance-data.json node mcp-server.js  # 指定数据文件
 *
 * 注意：stdio 模式下 stdout 是协议通道，日志一律走 stderr。
 */

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const core = require('./finance-core.js');

const log = (...a) => console.error('[mcp]', ...a);

/* ================= 工具公共部分 ================= */

const AMOUNT = z.number().positive().describe('金额（元，正数）');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式 YYYY-MM-DD').describe('日期 YYYY-MM-DD');
const TX_TYPE = z.enum(['expense', 'income']).describe('类型：expense 支出 / income 收入');
const KIND = z.enum(['equal', 'minimum', 'interest', 'private'])
  .describe('还款方式：equal 每月等额还款 / minimum 每期最低还款 / interest 先息后本 / private 民间借贷');

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: String(msg) }], isError: true });

const findTx = (data, id) => data.transactions.find((t) => t.id === String(id));
const findDebt = (data, id) => data.debts.find((d) => d.id === String(id));

/** 负债对外展示：基本信息 + 汇总 + 下一期 */
function debtView(d) {
  const i = core.debtInfo(d);
  return {
    id: d.id,
    platform: d.platform,
    kind: d.kind,
    kindLabel: core.REPAY_METHODS[d.kind],
    total: d.total,
    annualRate: d.annualRate,
    minRate: d.minRate,
    borrowDate: d.borrowDate,
    firstDue: d.firstDue,
    periods: d.periods,
    note: d.note,
    已还期数: `${i.paidCount}/${i.count}`,
    已还现金: i.cashPaid,
    剩余本金: i.remaining,
    剩余应还计划: i.planSum,
    还款进度: `${i.pct.toFixed(1)}%`,
    下期应还: i.next ? { no: i.next.no, date: i.next.date, amount: i.next.amount, status: i.next.status } : null,
    逾期期数: i.overdue.length,
    结清: i.done,
    预计还清日期: i.payoffDate
  };
}

function budgetViews(data) {
  const m = core.ymNow();
  const spent = {};
  data.transactions.forEach((t) => {
    if (t.type === 'expense' && t.date.startsWith(m)) spent[t.category] = core.round2((spent[t.category] || 0) + t.amount);
  });
  return Object.entries(data.budgets || {})
    .filter(([, v]) => Number(v) > 0)
    .map(([cat, limit]) => {
      const used = spent[cat] || 0;
      const pct = Number(limit) > 0 ? (used / Number(limit)) * 100 : 0;
      return { category: cat, monthlyBudget: core.round2(Number(limit)), thisMonthSpent: used, pct: Math.round(pct), status: pct >= 100 ? '超支' : pct >= 80 ? '预警' : '正常' };
    });
}

/* ================= 构建 MCP 服务器 ================= */

function buildServer() {
  const server = new McpServer({ name: 'finance-app', version: '1.0.0' });

  /* ---------- 总览与查询 ---------- */

  server.registerTool('get_summary', {
    description: '财务总览：总资产、本月/本年收入支出、预算执行、负债汇总（总负债/净资产/下期还款/逾期提醒）。',
    inputSchema: {}
  }, async () => {
    const data = core.readData();
    const m = core.ymNow();
    const year = m.slice(0, 4);
    const monthTx = data.transactions.filter((t) => t.date.startsWith(m));
    const sum = (arr, type) => core.round2(arr.reduce((s, t) => s + (t.type === type ? t.amount : 0), 0));
    const assets = core.round2(sum(data.transactions, 'income') - sum(data.transactions, 'expense'));
    const ds = core.debtSummary(data.debts);
    return ok({
      数据文件: core.dataFile(),
      货币: (data.settings && data.settings.currency) || 'CNY',
      总资产: assets,
      本月: { 收入: sum(monthTx, 'income'), 支出: sum(monthTx, 'expense'), 交易笔数: monthTx.length },
      本年: {
        收入: sum(data.transactions.filter((t) => t.date.startsWith(year)), 'income'),
        支出: sum(data.transactions.filter((t) => t.date.startsWith(year)), 'expense')
      },
      预算执行: budgetViews(data),
      负债: {
        平台数: ds.count,
        总负债: ds.total,
        已还现金: ds.paid,
        剩余应还: ds.remaining,
        净资产: core.round2(assets - ds.remaining),
        本月应还: `${ds.dueMonth}（${ds.dueMonthCount} 期）`,
        下月应还: `${ds.dueNextMonth}（${ds.dueNextMonthCount} 期）`,
        逾期期数: ds.overdueCount,
        七天内到期: ds.soonCount,
        最近一笔待还: ds.next
      }
    });
  });

  server.registerTool('list_transactions', {
    description: '查询交易记录，可按月份（YYYY-MM）、类型、分类、关键字（备注/分类模糊匹配）筛选，按日期倒序返回，支持分页。',
    inputSchema: {
      month: z.string().regex(/^\d{4}-\d{2}$/, '格式 YYYY-MM').optional().describe('筛选月份 YYYY-MM'),
      type: TX_TYPE.optional(),
      category: z.string().optional().describe('筛选分类'),
      keyword: z.string().optional().describe('备注/分类关键字模糊搜索'),
      limit: z.number().int().positive().max(500).optional().describe('最多返回条数，默认 100'),
      offset: z.number().int().min(0).optional().describe('跳过条数（分页）')
    }
  }, async ({ month, type, category, keyword, limit, offset }) => {
    const data = core.readData();
    let list = data.transactions;
    if (month) list = list.filter((t) => t.date.startsWith(month));
    if (type) list = list.filter((t) => t.type === type);
    if (category) list = list.filter((t) => t.category === category);
    if (keyword) {
      const q = String(keyword).toLowerCase();
      list = list.filter((t) => (t.note + t.category + (t.src || '')).toLowerCase().includes(q));
    }
    list = [...list].sort((a, b) => (a.date === b.date ? (b.createdAt || 0) - (a.createdAt || 0) : (a.date < b.date ? 1 : -1)));
    const total = list.length;
    const off = offset || 0;
    const lim = limit || 100;
    list = list.slice(off, off + lim);
    const income = core.round2(list.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0));
    const expense = core.round2(list.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0));
    return ok({ 总条数: total, 本页: list.length, 偏移: off, 本页收入: income, 本页支出: expense, 记录: list });
  });

  server.registerTool('list_categories', {
    description: '列出收支分类（用户自定义优先，含历史使用过的分类）。',
    inputSchema: {}
  }, async () => {
    const data = core.readData();
    return ok({
      支出分类: core.catOptionsList(data, 'expense'),
      收入分类: core.catOptionsList(data, 'income'),
      是否自定义: !!(data.settings && data.settings.categories)
    });
  });

  server.registerTool('get_budgets', {
    description: '查看各分类月度预算与本月执行进度（含超 80% 预警、超 100% 超支标记）。',
    inputSchema: {}
  }, async () => {
    const data = core.readData();
    return ok({ 月份: core.ymNow(), 预算: budgetViews(data) });
  });

  server.registerTool('get_data_path', {
    description: '返回当前账本数据文件（finance-data.json）的完整路径。',
    inputSchema: {}
  }, async () => ok({ path: core.dataFile() }));

  /* ---------- 记账 ---------- */

  server.registerTool('add_transaction', {
    description: '记一笔账（支出或收入）。会立即保存到账本并进入总览统计、预算执行。',
    inputSchema: {
      type: TX_TYPE,
      amount: AMOUNT,
      category: z.string().min(1).describe('分类，如 餐饮/交通/工资（可用 list_categories 查看）'),
      date: DATE.optional().describe('日期，默认今天'),
      note: z.string().max(200).optional().describe('备注')
    }
  }, async ({ type, amount, category, date, note }) => {
    const t = {
      id: core.newId(), type, amount: core.round2(amount),
      category: String(category).trim(), date: date || core.todayStr(),
      note: String(note || ''), src: '', paymentKey: '', createdAt: Date.now()
    };
    await core.withData((data) => { data.transactions.push(t); });
    return ok({ 已记账: t });
  });

  server.registerTool('update_transaction', {
    description: '修改一笔交易（按 id）：可改金额、类型、分类、日期、备注，只传要改的字段。',
    inputSchema: {
      id: z.string().describe('交易 id'),
      type: TX_TYPE.optional(),
      amount: z.number().positive().optional(),
      category: z.string().min(1).optional(),
      date: DATE.optional(),
      note: z.string().max(200).optional()
    }
  }, async (args) => {
    const { id, ...patch } = args;
    return core.withData((data) => {
      const t = findTx(data, id);
      if (!t) throw new Error(`未找到交易 ${id}`);
      if (patch.type !== undefined) t.type = patch.type;
      if (patch.amount !== undefined) t.amount = core.round2(patch.amount);
      if (patch.category !== undefined) t.category = String(patch.category).trim();
      if (patch.date !== undefined) t.date = patch.date;
      if (patch.note !== undefined) t.note = String(patch.note);
      return ok({ 已更新: t });
    }).catch((e) => fail(e.message));
  });

  server.registerTool('delete_transaction', {
    description: '删除一笔交易（按 id）。若删除的是负债还款交易，对应期数的还款标记也会一并撤销（与应用行为一致）。',
    inputSchema: { id: z.string().describe('交易 id') }
  }, async ({ id }) => core.withData((data) => {
    const i = data.transactions.findIndex((t) => t.id === String(id));
    if (i < 0) throw new Error(`未找到交易 ${id}`);
    const [t] = data.transactions.splice(i, 1);
    let undone = null;
    if (t.paymentKey && t.paymentKey !== '' && !t.paymentKey.endsWith(':settle')) {
      const [debtId, no] = t.paymentKey.split(':');
      const d = data.debts.find((x) => x.id === debtId);
      if (d) {
        const j = (d.payments || []).findIndex((p) => String(p.no) === String(no));
        if (j >= 0) { d.payments.splice(j, 1); undone = { debtId, no: Number(no) }; }
      }
    } else if (t.paymentKey && t.paymentKey.endsWith(':settle')) {
      const debtId = t.paymentKey.split(':')[0];
      const d = data.debts.find((x) => x.id === debtId);
      if (d) { d.payments = []; undone = { debtId, all: true }; }
    }
    return ok({ 已删除: t, 撤销的还款标记: undone });
  }).catch((e) => fail(e.message)));

  /* ---------- 预算 ---------- */

  server.registerTool('set_budget', {
    description: '设置某分类的月度预算（元）。传 0 表示清除该分类预算。',
    inputSchema: {
      category: z.string().min(1).describe('支出分类'),
      amount: z.number().min(0).describe('月度预算金额，0 = 清除')
    }
  }, async ({ category, amount }) => core.withData((data) => {
    const cat = String(category).trim();
    if (core.round2(amount) <= 0) delete data.budgets[cat];
    else data.budgets[cat] = core.round2(amount);
    return ok({ 预算: data.budgets });
  }));

  server.registerTool('delete_budget', {
    description: '删除某分类的月度预算。',
    inputSchema: { category: z.string().min(1) }
  }, async ({ category }) => core.withData((data) => {
    delete data.budgets[String(category).trim()];
    return ok({ 预算: data.budgets });
  }));

  /* ---------- 负债 ---------- */

  server.registerTool('list_debts', {
    description: '列出全部负债平台及汇总（剩余本金、还款进度、下期应还、逾期提醒），并给出整体总负债/本月应还/下月应还。',
    inputSchema: {}
  }, async () => {
    const data = core.readData();
    return ok({ 汇总: core.debtSummary(data.debts), 负债: data.debts.map(debtView) });
  });

  server.registerTool('get_debt_schedule', {
    description: '查看某笔负债的完整还款计划表：每期金额/本金/利息/日期/状态（已还/待还/逾期）。',
    inputSchema: { id: z.string().describe('负债 id（可用 list_debts 查询）') }
  }, async ({ id }) => {
    const data = core.readData();
    const d = findDebt(data, id);
    if (!d) throw new Error(`未找到负债 ${id}`);
    const i = core.debtInfo(d);
    return ok({
      负债: debtView(d),
      还款计划: i.rows.map((r) => ({ 期数: r.no, 日期: r.date, 应还: r.amount, 本金: r.principal, 利息: r.interest, 状态: r.status })),
      未来利息合计: i.futureInterest
    });
  });

  server.registerTool('add_debt', {
    description: '新增一笔负债（如信用卡、网贷、房贷、民间借贷），自动按还款方式与年利率计算每期应还计划。',
    inputSchema: {
      platform: z.string().min(1).describe('欠款平台名称，如 支付宝借呗'),
      total: AMOUNT.describe('欠款总金额（本金）'),
      kind: KIND.optional().describe('还款方式，默认 equal'),
      annualRate: z.number().min(0).optional().describe('年利率（百分数），如 15.5 表示 15.5%；0 或不填为无息'),
      borrowDate: DATE.optional().describe('欠债日期，默认今天'),
      firstDue: DATE.optional().describe('首期应还日期，默认欠债日期 + 1 个月'),
      periods: z.number().int().positive().max(600).optional().describe('还款期数（等额/先息后本必填，默认 12）'),
      minRate: z.number().min(0).max(100).optional().describe('最低还款比例（百分数，仅 minimum 方式使用，默认 10）'),
      note: z.string().max(200).optional()
    }
  }, async (args) => {
    const kind = args.kind && core.REPAY_METHODS[args.kind] ? args.kind : 'equal';
    const borrowDate = args.borrowDate || core.todayStr();
    const payload = {
      id: core.newId(),
      platform: String(args.platform).trim(),
      kind,
      total: core.round2(Math.max(0, args.total)),
      borrowDate,
      firstDue: args.firstDue || core.addMonths(borrowDate, 1),
      periods: Math.max(1, Math.round(args.periods || (kind === 'private' ? 1 : 12))),
      perPeriod: 0,
      minRate: args.minRate != null ? Math.min(1, Math.max(0.01, args.minRate / 100)) : 0.1,
      annualRate: core.round2(Math.max(0, args.annualRate || 0)),
      note: String(args.note || '').trim(),
      payments: [],
      createdAt: Date.now()
    };
    payload.perPeriod = (core.debtSchedule(payload)[0] || {}).amount || 0;
    await core.withData((data) => { data.debts.push(core.normalizeDebt(payload)); });
    return ok({ 已新增负债: debtView(core.normalizeDebt(payload)), 首期应还: core.debtSchedule(payload)[0] || null });
  });

  server.registerTool('update_debt', {
    description: '修改一笔负债（按 id）：平台名、总金额、年利率、期数、首期日期、还款方式等，修改后还款计划自动重算。已记录的还款会保留。',
    inputSchema: {
      id: z.string().describe('负债 id'),
      platform: z.string().min(1).optional(),
      total: z.number().min(0).optional(),
      kind: KIND.optional(),
      annualRate: z.number().min(0).optional(),
      borrowDate: DATE.optional(),
      firstDue: DATE.optional(),
      periods: z.number().int().positive().max(600).optional(),
      minRate: z.number().min(0).max(100).optional(),
      note: z.string().max(200).optional()
    }
  }, async (args) => {
    const { id, ...patch } = args;
    return core.withData((data) => {
      const d = findDebt(data, id);
      if (!d) throw new Error(`未找到负债 ${id}`);
      if (patch.platform !== undefined) d.platform = String(patch.platform).trim();
      if (patch.total !== undefined) d.total = core.round2(Math.max(0, patch.total));
      if (patch.kind !== undefined && core.REPAY_METHODS[patch.kind]) d.kind = patch.kind;
      if (patch.annualRate !== undefined) d.annualRate = core.round2(Math.max(0, patch.annualRate));
      if (patch.borrowDate !== undefined) d.borrowDate = patch.borrowDate;
      if (patch.firstDue !== undefined) d.firstDue = patch.firstDue;
      if (patch.periods !== undefined) d.periods = Math.max(1, Math.round(patch.periods));
      if (patch.minRate !== undefined) d.minRate = Math.min(1, Math.max(0.01, patch.minRate / 100));
      if (patch.note !== undefined) d.note = String(patch.note);
      const rows = core.debtSchedule(d);
      d.perPeriod = (rows[0] || {}).amount || 0;
      return ok({ 已更新: debtView(d), 下期应还: rows.find((r) => !r.paid) || null });
    }).catch((e) => fail(e.message));
  });

  server.registerTool('delete_debt', {
    description: '删除一笔负债（按 id）。若其还款已生成交易记录，可提示用户在应用内确认是否同时处理；此操作只删负债本身。',
    inputSchema: {
      id: z.string().describe('负债 id'),
      confirm: z.boolean().optional().describe('必须传 true 才执行删除（防误删）')
    }
  }, async ({ id, confirm }) => {
    if (!confirm) return fail('需传 confirm=true 确认删除');
    return core.withData((data) => {
      const i = data.debts.findIndex((d) => d.id === String(id));
      if (i < 0) throw new Error(`未找到负债 ${id}`);
      const [d] = data.debts.splice(i, 1);
      const linked = data.transactions.filter((t) => t.paymentKey && t.paymentKey.startsWith(d.id + ':'));
      return ok({ 已删除负债: debtView(d), 关联的还款交易: linked });
    }).catch((e) => fail(e.message));
  });

  server.registerTool('mark_repayment', {
    description: '标记某负债某一期已还款：记录还款并自动生成一笔分类为「还款」的支出交易（与应用内「标记还款」完全一致）。仅开放至本月+下月，更往后的期次需 force。',
    inputSchema: {
      id: z.string().describe('负债 id'),
      no: z.number().int().positive().describe('期数'),
      date: DATE.optional().describe('实际还款日期，默认今天'),
      amount: z.number().min(0).optional().describe('实还金额，默认按计划表该期金额'),
      force: z.boolean().optional().describe('允许标记本月+下月之后的期次')
    }
  }, async ({ id, no, date, amount, force }) => core.withData((data) => {
    const d = findDebt(data, id);
    if (!d) throw new Error(`未找到负债 ${id}`);
    const rows = core.debtSchedule(d);
    const row = rows.find((r) => r.no === Number(no));
    if (!row) throw new Error(`期数超出计划范围（共 ${rows.length} 期）`);
    if (row.paid) throw new Error(`第 ${no} 期已标记还款，如需修改请先 undo_repayment`);
    const payDate = date || core.todayStr();
    if (!force && row.date > core.payWindowEnd()) {
      return fail(`第 ${no} 期应还日期 ${row.date} 晚于开放窗口（${core.payWindowEnd()}，本月+下月）；如确要提前标记，请传 force=true`);
    }
    const payAmount = core.round2(amount != null ? amount : row.amount);
    d.payments.push({ no: row.no, date: payDate, amount: payAmount });
    const t = {
      id: core.newId(), type: 'expense', amount: payAmount, category: '还款',
      date: payDate, note: `${d.platform} 第${row.no}期`, paymentKey: `${d.id}:${row.no}`, createdAt: Date.now()
    };
    data.transactions.push(t);
    const info = core.debtInfo(d);
    return ok({
      已标记还款: { 平台: d.platform, 期数: row.no, 日期: payDate, 金额: payAmount },
      自动生成的交易: t,
      负债进度: { 已还期数: `${info.paidCount}/${info.count}`, 剩余本金: info.remaining, 下期应还: info.next }
    });
  }).catch((e) => fail(e.message)));

  server.registerTool('undo_repayment', {
    description: '撤销某负债某一期的还款标记，并删除对应自动生成的「还款」支出交易。',
    inputSchema: {
      id: z.string().describe('负债 id'),
      no: z.number().int().positive().describe('期数')
    }
  }, async ({ id, no }) => core.withData((data) => {
    const d = findDebt(data, id);
    if (!d) throw new Error(`未找到负债 ${id}`);
    const key = `${d.id}:${Number(no)}`;
    const j = (d.payments || []).findIndex((p) => String(p.no) === String(no) && !p.settle);
    const k = data.transactions.findIndex((t) => t.paymentKey === key);
    if (j < 0 && k < 0) throw new Error(`第 ${no} 期没有还款记录`);
    const removedPayment = j >= 0 ? d.payments.splice(j, 1)[0] : null;
    const removedTx = k >= 0 ? data.transactions.splice(k, 1)[0] : null;
    return ok({ 已撤销: { 平台: d.platform, 期数: Number(no) }, 移除的还款记录: removedPayment, 移除的交易: removedTx });
  }).catch((e) => fail(e.message)));

  server.registerTool('settle_debt', {
    description: '提前结清某笔负债：归还剩余本金 + 已产生利息（未来期次不计息），生成一笔「提前结清」支出交易。先传 preview=true 查看金额。',
    inputSchema: {
      id: z.string().describe('负债 id'),
      preview: z.boolean().optional().describe('true 只预览金额不实际结清'),
      date: DATE.optional().describe('结清日期，默认今天')
    }
  }, async ({ id, preview, date }) => {
    const data = core.readData();
    const d = findDebt(data, id);
    if (!d) throw new Error(`未找到负债 ${id}`);
    const info = core.debtInfo(d);
    if (info.done) return fail('该负债已结清');
    const calc = core.settleAmount(d);
    if (preview) {
      return ok({ 预览: { 平台: d.platform, 剩余本金: calc.principal, 已产生利息: calc.interest, 合计需还: calc.total }, 明细: calc.parts });
    }
    const payDate = date || core.todayStr();
    const t = await core.withData((dd) => {
      const target = findDebt(dd, id);
      calc.parts.forEach((p) => {
        const existing = (target.payments || []).find((x) => Number(x.no) === p.no);
        const rec = { no: p.no, date: payDate, amount: p.amount, interest: p.interest, principal: p.principal, settle: true };
        if (existing) Object.assign(existing, rec);
        else target.payments.push(rec);
      });
      const tx = {
        id: core.newId(), type: 'expense', amount: calc.total, category: '还款',
        date: payDate, note: `${target.platform} 提前结清${calc.parts.length > 1 ? `（${calc.parts.length} 期）` : ''}`,
        paymentKey: `${target.id}:settle`, createdAt: Date.now()
      };
      dd.transactions.push(tx);
      return tx;
    });
    return ok({ 已结清: { 平台: d.platform, 本金: calc.principal, 利息: calc.interest, 合计: calc.total }, 自动生成的交易: t });
  });

  return server;
}

/* ================= 启动 ================= */

function parseArgs(argv) {
  const args = { http: null, host: '127.0.0.1', token: process.env.MCP_TOKEN || '', port: 3721 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--http') { args.http = true; const n = Number(argv[i + 1]); if (Number.isFinite(n)) { args.port = n; i++; } }
    else if (a === '--host') args.host = argv[++i] || '127.0.0.1';
    else if (a === '--token') args.token = argv[++i] || '';
    else if (a === '--port') args.port = Number(argv[++i]) || 3721;
  }
  return args;
}

async function startStdio() {
  const server = buildServer();
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  await server.connect(new StdioServerTransport());
  log(`stdio 传输已启动，数据文件: ${core.dataFile()}`);
}

function startHttp({ host, port, token }) {
  const sessions = new Map(); // sessionId -> { server, transport }

  const httpServer = http.createServer(async (req, res) => {
    // CORS（浏览器类 MCP 客户端）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    // Bearer 鉴权（配置了 token 才启用）
    if (token) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }));
        return;
      }
    }

    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/mcp') { res.writeHead(404).end('Not Found'); return; }

    try {
      const sid = req.headers['mcp-session-id'];
      let entry = sid ? sessions.get(String(sid)) : null;

      if (req.method === 'POST') {
        if (!entry) {
          // 新会话：initialize 请求 → 创建 server + transport
          const server = buildServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, { server, transport });
              log(`HTTP 会话建立: ${id}`);
            }
          });
          transport.onclose = () => {
            if (transport.sessionId) { sessions.delete(transport.sessionId); log(`HTTP 会话关闭: ${transport.sessionId}`); }
          };
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        }
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!entry) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: '无效或已过期的会话' }, id: null }));
          return;
        }
        await entry.transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405).end('Method Not Allowed');
    } catch (err) {
      log('请求处理出错:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null }));
      }
    }
  });

  httpServer.listen(port, host, () => {
    log(`Streamable HTTP 传输已启动: http://${host}:${port}/mcp`);
    log(`数据文件: ${core.dataFile()}`);
    log(token ? '已启用 Bearer 鉴权（MCP_TOKEN）' : '未设置 token：任何能访问该端口的客户端均可连接（默认仅本机）');
  });
}

const args = parseArgs(process.argv.slice(2));
if (args.http) startHttp(args);
else startStdio().catch((err) => { log('启动失败:', err.message); process.exit(1); });
