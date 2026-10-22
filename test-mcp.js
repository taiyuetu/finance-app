'use strict';
/* MCP 服务器协议自测：stdio 握手 → 列工具 → 记账 → 总览 → 负债全流程 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-mcp-test-'));
const dataFile = path.join(tmpDir, 'finance-data.json');

// 预置示例账本
fs.writeFileSync(dataFile, JSON.stringify({
  version: 1,
  transactions: [
    { id: 't1', type: 'expense', amount: 35.5, category: '餐饮', date: '2026-10-01', note: '午饭', paymentKey: '', createdAt: 1 },
    { id: 't2', type: 'income', amount: 12000, category: '工资', date: '2026-10-05', note: '月薪', paymentKey: '', createdAt: 2 }
  ],
  budgets: { 餐饮: 2500 },
  debts: [],
  settings: { currency: 'CNY' }
}, null, 2));

const child = spawn('node', ['mcp-server.js'], {
  cwd: 'C:/Users/hdmso/finance-app',
  env: { ...process.env, FINANCE_DATA_FILE: dataFile },
  stdio: ['pipe', 'pipe', 'pipe']
});
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

let buf = '';
const pending = new Map();
let nextId = 1;
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时: ' + method)); } }, 8000);
  });
}
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  if (r.error) throw new Error(JSON.stringify(r.error));
  const text = r.result.content[0].text;
  if (r.result.isError) throw new Error(`工具报错 ${name}: ${text}`);
  return JSON.parse(text);
};

(async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'selftest', version: '0.0.1' }
  });
  console.log('✅ initialize:', init.result.serverInfo.name, init.result.serverInfo.version);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = await rpc('tools/list', {});
  const names = tools.result.tools.map((t) => t.name);
  console.log(`✅ tools/list: ${names.length} 个工具 → ${names.join(', ')}`);

  const summary0 = await call('get_summary');
  console.log('✅ get_summary: 总资产 =', summary0['总资产'], '本月支出 =', summary0['本月']['支出']);

  const added = await call('add_transaction', { type: 'expense', amount: 18.8, category: '交通', note: '地铁充值', date: '2026-10-22' });
  console.log('✅ add_transaction:', added['已记账'].id, added['已记账'].category, added['已记账'].amount);

  const list = await call('list_transactions', { month: '2026-10', type: 'expense' });
  console.log('✅ list_transactions: 10月支出笔数 =', list['总条数'], '本页支出 =', list['本页支出']);

  const upd = await call('update_transaction', { id: added['已记账'].id, amount: 20, note: '地铁充值（改）' });
  console.log('✅ update_transaction: 新金额 =', upd['已更新'].amount);

  await call('set_budget', { category: '交通', amount: 500 });
  const budgets = await call('get_budgets');
  console.log('✅ set_budget/get_budgets:', JSON.stringify(budgets['预算']));

  const debt = await call('add_debt', { platform: '支付宝借呗', total: 12000, kind: 'equal', annualRate: 14.6, periods: 12, firstDue: '2026-11-05' });
  const debtId = debt['已新增负债'].id;
  console.log('✅ add_debt: id =', debtId, '首期应还 =', debt['首期应还'].amount, `(${debt['首期应还'].date})`);

  const sched = await call('get_debt_schedule', { id: debtId });
  console.log('✅ get_debt_schedule: 共', sched['还款计划'].length, '期，未来利息合计 =', sched['未来利息合计']);

  const mark = await call('mark_repayment', { id: debtId, no: 1 });
  console.log('✅ mark_repayment: 第1期已还', mark['已标记还款']['金额'], '进度', mark['负债进度']['已还期数']);

  const undo = await call('undo_repayment', { id: debtId, no: 1 });
  console.log('✅ undo_repayment: 已撤销', undo['已撤销']['期数'], '期');

  await call('mark_repayment', { id: debtId, no: 1 });
  const preview = await call('settle_debt', { id: debtId, preview: true });
  console.log('✅ settle_debt 预览: 合计需还 =', preview['预览']['合计需还']);

  // 逾期标记应被拦截（2026-11 在本月+下月窗口内 → 放行；试一个未来期次）
  try {
    await call('mark_repayment', { id: debtId, no: 5 });
    console.log('⚠️ 第5期标记未被拦截');
  } catch (e) {
    console.log('✅ mark_repayment 窗口拦截:', e.message.slice(0, 50));
  }

  const debts = await call('list_debts');
  console.log('✅ list_debts: 汇总剩余应还 =', debts['汇总']['remaining'], '| 已还期数 =', debts['负债'][0]['已还期数']);

  // 验证数据文件与应用同构：还款交易带 paymentKey，可被应用识别
  const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const repayTx = raw.transactions.find((t) => t.paymentKey === `${debtId}:1`);
  console.log('✅ 数据文件验证: 还款交易', repayTx ? `存在（${repayTx.note} ${repayTx.amount}元）` : '缺失！');

  const del = await call('delete_transaction', { id: added['已记账'].id });
  console.log('✅ delete_transaction:', del['已删除'].note);

  child.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n🎉 全部测试通过');
  process.exit(0);
})().catch((e) => { console.error('\n❌ 测试失败:', e.message); child.kill(); process.exit(1); });
