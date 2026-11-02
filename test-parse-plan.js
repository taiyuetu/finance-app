// 粘贴账单解析的单元测试（从 renderer/app.js 中提取 parsePlanText 运行）
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/renderer/app.js', 'utf8');
const m = src.match(/function parsePlanText\(text, yearHint\) \{[\s\S]*?\n\}/);
if (!m) { console.error('FAIL: parsePlanText 未找到'); process.exit(1); }
const pad2 = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const parsePlanText = eval(`(${m[0].replace(/^function parsePlanText/, 'function')})`);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};

// 1. 占位符示例格式（含「含利息」）
eq('中文日期+含利息',
  parsePlanText('2026年11月5日 3665.36 含利息516.08\n2026年12月5日 3679.92 含利息457.87'),
  [{ date: '2026-11-05', amount: 3665.36, interest: 516.08 },
   { date: '2026-12-05', amount: 3679.92, interest: 457.87 }]);

// 2. ISO 日期 + 逗号分隔 + 千分位
eq('ISO+千分位',
  parsePlanText('2026-11-05, 3,665.36, 516.08'),
  [{ date: '2026-11-05', amount: 3665.36, interest: 516.08 }]);

// 3. 行首期号不会被当成金额
eq('行首期号',
  parsePlanText('1 2026-11-05 3665.36 516.08'),
  [{ date: '2026-11-05', amount: 3665.36, interest: 516.08 }]);

// 4. 无年份（11月5日）用 yearHint 补全，且跨年进位
eq('无年份+跨年',
  parsePlanText('2026年12月5日 1000 利息50\n1月5日 1000 利息40', '2026-11-08'),
  [{ date: '2026-12-05', amount: 1000, interest: 50 },
   { date: '2027-01-05', amount: 1000, interest: 40 }]);

// 5. 行首 11/05 无年份
eq('行首 MM-DD',
  parsePlanText('11/05 3665.36 516.08', '2026-11-08'),
  [{ date: '2026-11-05', amount: 3665.36, interest: 516.08 }]);

// 6. 纯金额行不会被误判为日期（旧版/宽松版会出错）
eq('纯金额行跳过', parsePlanText('3665.36'), []);

// 7. 金额在日期之前的写法
eq('金额在前',
  parsePlanText('3665.36 2026年11月5日'),
  [{ date: '2026-11-05', amount: 3665.36, interest: 0 }]);

// 8. 第二个数字不是利息（≥ 应还金额，如「共12期」）时按 0 处理
eq('尾部期数误判为利息',
  parsePlanText('2026-11-05 3665.36 共12期'),
  [{ date: '2026-11-05', amount: 3665.36, interest: 0 }]);

// 9. 空行/无日期行被跳过
eq('跳过无效行',
  parsePlanText('\n还款计划\n2026-11-05 100.00'),
  [{ date: '2026-11-05', amount: 100, interest: 0 }]);

// 10. 日期非法（月份越界）跳过
eq('月份越界', parsePlanText('2026-13-05 100'), []);

// 11. 金额为 0 的行跳过
eq('金额为0', parsePlanText('2026-11-05 0 0'), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
