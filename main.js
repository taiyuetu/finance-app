'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const isSmoke = !!process.env.ELECTRON_SMOKE_TEST;
let mainWindow = null;

/* ---------- 数据持久化（JSON 文件存于 userData） ---------- */

function dataFile() {
  return path.join(app.getPath('userData'), 'finance-data.json');
}

/**
 * 产品改名（个人财务管家 → 真好管账）后 Electron 的 userData 目录名随之变化，
 * 首次启动时把旧目录里的账本复制到新目录，保证老用户数据不丢（旧文件保留作备份）。
 */
function migrateLegacyData() {
  const cur = dataFile();
  try { if (fs.existsSync(cur)) return; } catch { /* 读取失败也继续尝试迁移 */ }
  const osHome = require('node:os').homedir();
  const base = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(osHome, 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? path.join(osHome, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(osHome, '.config'));
  for (const dir of ['个人财务管家', 'finance-app']) {
    const old = path.join(base, dir, 'finance-data.json');
    try {
      if (!fs.existsSync(old)) continue;
      fs.mkdirSync(path.dirname(cur), { recursive: true });
      fs.copyFileSync(old, cur);
      console.log('[data] 已迁移旧账本:', old, '→', cur);
      return;
    } catch (err) {
      console.error('[data] 数据迁移失败:', err.message);
      return;
    }
  }
}

function defaultData() {
  return {
    version: 1,
    transactions: [],
    budgets: {},
    debts: [],
    settings: { currency: 'CNY', createdAt: new Date().toISOString() }
  };
}

function readData() {
  try {
    const raw = fs.readFileSync(dataFile(), 'utf8');
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') throw new Error('数据格式错误');
    return {
      version: 1,
      transactions: Array.isArray(d.transactions) ? d.transactions : [],
      budgets: d.budgets && typeof d.budgets === 'object' ? d.budgets : {},
      debts: Array.isArray(d.debts) ? d.debts : [],
      settings: d.settings && typeof d.settings === 'object' ? d.settings : {}
    };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[data] 读取失败:', err.message);
    return defaultData();
  }
}

let lastWrittenRaw = null; // 本进程最近一次写入的内容（用于忽略自身触发的文件监视事件）

function writeData(data) {
  const file = dataFile();
  const tmp = file + '.tmp';
  const json = JSON.stringify(data, null, 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, file); // 原子替换，避免写一半损坏
  lastWrittenRaw = json;
}

/* 外部修改监视：MCP 服务器等进程直接改写数据文件时，通知渲染进程同步刷新 */
function startDataWatcher() {
  const file = dataFile();
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* 忽略 */ }
  fs.watchFile(file, { interval: 1500 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return; } // 文件被删除或正在替换
    if (raw === lastWrittenRaw) return; // 自己写的，忽略
    lastWrittenRaw = raw;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('data:external-changed');
  });
}

function isValidData(d) {
  return (
    d && typeof d === 'object' &&
    Array.isArray(d.transactions) &&
    d.transactions.every(
      (t) => t && typeof t.id === 'string' &&
        (t.type === 'income' || t.type === 'expense') &&
        typeof t.amount === 'number' && Number.isFinite(t.amount) && t.amount >= 0 &&
        typeof t.category === 'string' && typeof t.date === 'string'
    ) &&
    (d.budgets === undefined || (d.budgets && typeof d.budgets === 'object' && !Array.isArray(d.budgets))) &&
    (d.debts === undefined || (Array.isArray(d.debts) && d.debts.every(
      (x) => x && typeof x.id === 'string' && typeof x.platform === 'string' &&
        typeof x.total === 'number' && Number.isFinite(x.total) && x.total >= 0
    )))
  );
}

/* ---------- IPC ---------- */

ipcMain.handle('data:get', () => readData());

ipcMain.handle('data:set', (_e, data) => {
  try {
    if (!isValidData(data)) return { ok: false, error: '数据校验失败' };
    writeData({
      version: 1,
      transactions: data.transactions,
      budgets: data.budgets || {},
      debts: Array.isArray(data.debts) ? data.debts : [],
      settings: data.settings || {}
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('data:path', () => dataFile());

ipcMain.handle('data:export', async (_e, csv, suggestedName) => {
  try {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出 CSV',
      defaultPath: path.join(app.getPath('documents'), suggestedName || `财务记录-${Date.now()}.csv`),
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, csv, 'utf8'); // csv 已含 BOM，Excel 可正确识别中文
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ---------- 账单文件导入（读文件字节，编码识别在渲染进程完成） ---------- */

ipcMain.handle('import:pick', async () => {
  try {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择账单文件',
      defaultPath: app.getPath('documents'),
      filters: [
        { name: '账单文件 (CSV / TXT)', extensions: ['csv', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    const file = filePaths[0];
    const stat = fs.statSync(file);
    if (stat.size > 20 * 1024 * 1024) return { ok: false, error: '文件过大（超过 20MB）' };
    const buf = fs.readFileSync(file);
    return { ok: true, name: path.basename(file), bytes: buf }; // Buffer 经 IPC 序列化为 Uint8Array
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ---------- 窗口 ---------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    title: '真好管账',
    backgroundColor: '#f4f6fb',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 冒烟测试：把渲染进程的报错打到终端，加载完成后自动退出
  if (isSmoke) {
    console.log('[smoke] userData=' + app.getPath('userData'));
    mainWindow.webContents.on('console-message', (...args) => {
      const e = args[0];
      const info = args[1] !== undefined
        ? { level: args[1], message: args[2], line: args[3], sourceId: args[4] }
        : { level: e && e.level, message: e && e.message, line: e && e.line, sourceId: e && e.sourceId };
      console.log(`[renderer][level=${info.level}] ${info.message} (${info.sourceId}:${info.line})`);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[smoke] renderer loaded ok');
      mainWindow.webContents
        .executeJavaScript(`
          (async () => {
            const report = { apiReady: !!window.api, nav: document.querySelectorAll('.nav-item').length };
            for (const v of ['dashboard', 'transactions', 'import', 'budget', 'debts', 'settings']) {
              document.querySelector('.nav-item[data-view="' + v + '"]').click();
              await new Promise((r) => setTimeout(r, 60));
              report[v] = document.getElementById('view-' + v).innerHTML.length;
            }
            report.txRows = document.querySelectorAll('#tx-list tbody tr').length;
            report.budgetRows = document.querySelectorAll('.budget-row').length;
            report.debtRows = document.querySelectorAll('.debt-table tbody tr').length;
            report.debtReminders = document.querySelectorAll('.list-row.remind').length;
            document.querySelector('.nav-item[data-view="dashboard"]').click();
            await new Promise((r) => setTimeout(r, 60));
            const cb = document.querySelector('#chart-bars');
            const cd = document.querySelector('#chart-donut');
            report.charts = cb && cd ? cb.width + 'x' + cb.height + '/' + cd.width + 'x' + cd.height : 'missing';
            report.stats = [...document.querySelectorAll('.stat-value')].map((e) => e.textContent).join(' | ');
            return JSON.stringify(report);
          })()
        `)
        .then((s) => console.log('[smoke] dom ' + s))
        .catch((err) => console.error('[smoke] dom eval failed: ' + err.message))
        .finally(() => setTimeout(() => app.quit(), 800));
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error(`[smoke] load failed: ${code} ${desc}`);
      app.exit(1);
    });
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  migrateLegacyData();
  startDataWatcher();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
