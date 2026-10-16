/**
 * 修改开发模式 electron.exe 的 PE 资源
 * 让 Windows 任务管理器显示"金刚助手"和 logo.ico 图标，而非默认的"Electron"
 * 每次 npm install 后通过 postinstall 钩子自动执行，防止 electron 重新下载覆盖修改
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const logoIco = path.join(root, 'logo.ico');
const rceditExe = path.join(root, 'node_modules', 'rcedit', 'bin', 'rcedit.exe');

// 非 Windows 平台跳过
if (process.platform !== 'win32') {
  console.log('[patch-electron] 非 Windows 平台，跳过');
  process.exit(0);
}
// electron.exe 不存在（可能尚未安装依赖）
if (!fs.existsSync(electronExe)) {
  console.log('[patch-electron] electron.exe 不存在，跳过');
  process.exit(0);
}
// rcedit 不存在（可能尚未安装依赖）
if (!fs.existsSync(rceditExe)) {
  console.warn('[patch-electron] rcedit.exe 不存在，跳过');
  process.exit(0);
}

const appName = '金刚助手';
const company = '明静科技';
const args = [
  `"${rceditExe}"`,
  `"${electronExe}"`,
  '--set-version-string', 'FileDescription', `"${appName}"`,
  '--set-version-string', 'ProductName', `"${appName}"`,
  '--set-version-string', 'CompanyName', `"${company}"`,
];
if (fs.existsSync(logoIco)) {
  args.push('--set-icon', `"${logoIco}"`);
} else {
  console.warn('[patch-electron] logo.ico 不存在，跳过图标设置');
}

console.log('[patch-electron] 正在修改 electron.exe 的 PE 资源...');
try {
  execSync(args.join(' '), { stdio: 'inherit' });
  console.log(`[patch-electron] 完成：FileDescription/ProductName="${appName}", CompanyName="${company}"`);
} catch (e) {
  // electron.exe 正在运行时会被文件锁定，导致 rcedit 写入失败
  console.error('[patch-electron] 修改失败（electron.exe 可能正在运行被锁定）');
  console.error('[patch-electron] 请先关闭正在运行的金刚助手，再重新执行 npm install');
  process.exit(1);
}
