'use strict';
// E2E：负债「平台账单 + 从账单粘贴批量导入」保存流程回归测试（临时验证脚本）
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 用临时目录当 userData，避免写脏真实账本
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-e2e-'));
app.setPath('userData', tmp);

ipcMain.handle('data:get', () => ({ version: 1, transactions: [], budgets: {}, debts: [], settings: { currency: 'CNY' } }));
ipcMain.handle('data:set', () => true);
ipcMain.handle('data:path', () => path.join(tmp, 'finance-data.json'));
ipcMain.handle('data:export', () => null);
ipcMain.handle('import:pick', () => ({ ok: false, canceled: true }));

async function scenario() {
  const R = [];
  const push = (name, pass, extra) => R.push({ name, pass: !!pass, extra: extra == null ? '' : String(extra) });
  const Q = (s) => document.querySelector(s);
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const fill = (sel, val, type) => { const el = Q(sel); if (!el) return; el.value = val; fire(el, type || 'input'); };
  const err = () => { const el = Q('#d-err'); return el ? el.textContent.trim() : ''; }; // 弹窗已关闭 = 没有错误

  const BILL =
    '2026年12月5日 3665.36 含利息516.08\n' +
    '2027年1月5日 3679.92 含利息457.87\n' +
    '2027年2月5日 3694.14 含利息401.37';
  const rows = parsePlanText(BILL, '2026-12-01');
  const principal = Math.round(rows.reduce((s, p) => s + p.amount - p.interest, 0) * 100) / 100;

  const setup = (platform) => {
    openDebtForm(null);
    fill('#d-platform', platform);
    fill('#d-borrow', '2026-11-01', 'change');
    fill('#d-rate', '16.06');
    fill('#d-plan-src', 'manual', 'change');
  };

  /* 场景 A：选平台账单 → 粘贴 → 不点「解析并填入」直接保存 */
  setup('测试A借呗');
  push('A1 切到平台账单后出现粘贴框', !!Q('#d-plan-text'));
  push('A2 切换后只有 1 行空占位期次', document.querySelectorAll('#d-plan-body tr').length === 1);
  const ta = Q('#d-plan-text');
  ta.value = BILL;
  fire(ta, 'input');
  push('A3 粘贴后自动解析 3 期', (state.debtForm.manualPlan || []).length === 3, JSON.stringify(state.debtForm.manualPlan));
  push('A4 表格已填入 3 行', document.querySelectorAll('#d-plan-body tr').length === 3);
  push('A5 还款期数自动 = 3', Q('#d-periods').value === '3', Q('#d-periods').value);
  fill('#d-total', String(principal));
  saveDebtForm();
  push('A6 直接点保存不再报错', err() === '', err());
  const da = (state.data.debts || []).find((d) => d.platform === '测试A借呗');
  push('A7 负债已保存且为平台账单计划', !!(da && da.planSource === 'manual'));
  push('A8 保存的期次金额与账单一致',
    !!(da && da.manualPlan.length === 3 && da.manualPlan[0].amount === 3665.36 && da.manualPlan[0].interest === 516.08),
    da && JSON.stringify(da.manualPlan));
  push('A9 期数已回写', !!(da && da.periods === 3), da && da.periods);

  /* 场景 B：粘贴后不触发任何事件，直接点保存（兜底解析） */
  setup('测试B信用卡');
  const taB = Q('#d-plan-text');
  taB.value = BILL; // 不派发 input，模拟「粘贴完立刻点保存」
  fill('#d-total', String(principal));
  saveDebtForm();
  push('B1 未触发 input 也能保存', err() === '', err());
  const db = (state.data.debts || []).find((d) => d.platform === '测试B信用卡');
  push('B2 期次正确落库', !!(db && db.manualPlan.length === 3), db && JSON.stringify(db.manualPlan));

  /* 场景 C：粘贴了无法解析的文本 → 应给出可读提示，而不是「第 1 期金额需大于 0」 */
  setup('测试C乱码');
  Q('#d-plan-text').value = '这行没有日期只有金额 123.45';
  fire(Q('#d-plan-text'), 'input');
  fill('#d-total', '1000');
  saveDebtForm();
  push('C1 解析失败时提示可读', err().includes('还没解析进计划表'), err());
  push('C2 不再误报「第 1 期的应还金额需大于 0」', !err().includes('第 1 期的应还金额'), err());
  push('C3 弹窗仍打开（保存被拦下）', !!state.debtForm);
  closeForm();

  /* 场景 D：欠款总金额与计划本金对不上 → 一键按计划回填后再保存 */
  setup('测试D借呗');
  const taD = Q('#d-plan-text');
  taD.value = BILL;
  fire(taD, 'input');
  fill('#d-total', '99999');
  saveDebtForm();
  push('D1 总额不一致时拦截并提示', err().includes('不一致'), err());
  const syncBtn = document.querySelector('[data-action="debt-total-sync"]');
  push('D2 预览里提供「按计划本金合计填入总金额」按钮', !!syncBtn);
  if (syncBtn) syncBtn.click();
  push('D3 点击后总金额已回填', Q('#d-total').value === String(principal), Q('#d-total').value);
  saveDebtForm();
  push('D4 回填后保存成功', err() === '' && !state.debtForm, err());

  /* 场景 E：「＋ 添加一期 / 删除该期」就地更新，不重建弹窗（重建会重放 .modal 的 pop 打开动画） */
  setup('测试E借呗');
  const modal1 = document.querySelector('.modal');
  const before = document.querySelectorAll('#d-plan-body tr').length;
  document.querySelector('[data-action="debt-plan-add"]').click();
  push('E1 弹窗节点未重建（不会重放打开动画）', !!modal1 && document.querySelector('.modal') === modal1);
  push('E2 就地新增一行', document.querySelectorAll('#d-plan-body tr').length === before + 1,
    document.querySelectorAll('#d-plan-body tr').length + '/' + (before + 1));
  push('E3 还款期数同步更新', Q('#d-periods').value === String(before + 1), Q('#d-periods').value);
  const ae = document.activeElement;
  push('E4 焦点自动落到新行「应还金额」',
    !!(ae && ae.dataset && ae.dataset.planK === 'amount' && Number(ae.dataset.planIdx) === before),
    ae && ae.dataset ? `${ae.dataset.planK}#${ae.dataset.planIdx}` : String(ae));
  push('E5 粘贴框等其它表单内容未丢失', !!Q('#d-plan-text') && Q('#d-platform').value === '测试E借呗', Q('#d-platform').value);
  const delBtn = document.querySelector(`#d-plan-body [data-action="debt-plan-del"][data-idx="${before}"]`);
  if (delBtn) delBtn.click();
  push('E6 删除也是同一弹窗节点', document.querySelector('.modal') === modal1);
  push('E7 就地减少一行', document.querySelectorAll('#d-plan-body tr').length === before,
    document.querySelectorAll('#d-plan-body tr').length + '/' + before);
  closeForm();

  return R;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const timer = setTimeout(() => { console.error('TIMEOUT'); app.exit(2); }, 30000);
  try {
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    const res = await win.webContents.executeJavaScript(`(${scenario.toString()})()`, true);
    let fail = 0;
    res.forEach((r) => {
      if (!r.pass) fail++;
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  | ' + r.extra : ''}`);
    });
    console.log(`\n${res.length - fail} passed, ${fail} failed`);
    clearTimeout(timer);
    app.exit(fail ? 1 : 0);
  } catch (err) {
    console.error('E2E error:', err && err.stack || err);
    clearTimeout(timer);
    app.exit(2);
  }
});
