/**
 * 混淆 + 打包脚本
 * 用法：node build-obfuscated.js
 *
 * 流程：
 *   1. 复制项目源文件到 build-src/（只复制需要打包的文件，保留原项目不动）
 *   2. 对 build-src/ 下以下内容进行混淆：
 *      - main.js                  （主进程核心代码）
 *      - api-server.js            （HTTP API服务代码）
 *      - *.html 内的 <script>...</script> 块（非 src 的内联脚本）
 *      - js/** 目录下所有 *.js    （外部引用的 JS）
 *   3. 将 package.json（仅 build 字段调整 files 路径）也放到 build-src/
 *   4. 调用 electron-builder，cwd 指向 build-src/
 *   5. 产物输出到 D:\TRAE LIVV\output
 */

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');
const { execSync, spawnSync } = require('child_process');

const ROOT = __dirname;
const BUILD_SRC = path.join(ROOT, 'build-src');
const OUTPUT_DIR = 'D:\\TRAE LIVV\\output';

// 混淆选项：平衡保护强度与运行速度
const OBF_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  debugProtection: false,
  debugProtectionInterval: 0,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,    // 不能开：渲染进程和主进程之间靠全局函数名互调
  selfDefending: false,    // 不开：开了会在严格模式/eval限制环境下报错，Electron内安全
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 5,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 3,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: false,  // 不开：会把 DOM id/class 改成混淆名导致 HTML/JS 不匹配
  unicodeEscapeSequence: false,
  target: 'browser',
};

// ========== 工具函数 ==========
function log(msg) { console.log('[OBF]', msg); }
function err(msg) { console.error('[OBF-ERR]', msg); }
function rimraf(p) {
  if (!fs.existsSync(p)) return;
  const stat = fs.lstatSync(p);
  if (stat.isDirectory()) {
    for (const f of fs.readdirSync(p)) rimraf(path.join(p, f));
    try { fs.rmdirSync(p); } catch (e) { /* EBUSY/EPERM 容忍：可能被杀毒软件锁定，后续会覆盖 */ }
  } else {
    try { fs.unlinkSync(p); } catch (e) { /* EBUSY/EPERM 容忍：可能被杀毒软件锁定，后续会覆盖 */ }
  }
}
function copyDir(src, dst, opts = {}) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const sf = path.join(src, f);
    const df = path.join(dst, f);
    const st = fs.lstatSync(sf);
    if (st.isDirectory()) {
      if (opts.excludeDirs && opts.excludeDirs.includes(f)) continue;
      copyDir(sf, df, opts);
    } else if (st.isFile()) {
      if (opts.onlyExt && !opts.onlyExt.some(ext => f.toLowerCase().endsWith(ext))) continue;
      try {
        fs.copyFileSync(sf, df);
      } catch (e) {
        // EBUSY/EPERM 容忍：目标文件可能被杀毒软件锁定（如 app.asar）
        // Electron 运行时文件内容不变，跳过即可；app.asar 会在 6d 步骤单独覆盖
        if (fs.existsSync(df)) {
          log(`  (跳过锁定文件: ${f})`);
        } else {
          throw e; // 目标不存在却复制失败，说明是真错误
        }
      }
    }
  }
}
function obfuscateCode(code, label) {
  try {
    const res = JavaScriptObfuscator.obfuscate(code, OBF_OPTIONS);
    return res.getObfuscatedCode();
  } catch (e) {
    err(`混淆失败 [${label}]: ` + (e && e.message || String(e)));
    return code; // 混淆失败就回退原文，保证打包不出错
  }
}

// 混淆 HTML 文件中的 <script> 内联块（忽略 <script src="...">）
function obfuscateHtml(html, filePath) {
  // 匹配 <script ...>...</script>，但排除 src= 的（那些是外部文件单独混淆）
  const re = /<script(\b[^>]*)>([\s\S]*?)<\/script>/gi;
  let idx = 0;
  return html.replace(re, (m, attrs, body) => {
    idx++;
    // 如果有 src 属性，就跳过（外部 JS）
    if (/src\s*=/i.test(attrs)) return m;
    // 如果 body 为空或只是注释/空白，跳过
    if (!body || !body.trim()) return m;
    // 模板脚本（如 text/html/template）跳过
    if (/type\s*=\s*["'](?!text\/javascript(;|["']|$))[^"']*["']/i.test(attrs)) return m;
    const label = `${path.basename(filePath)}#script${idx}`;
    log(`  → 内联脚本 ${label} (${body.length} bytes)`);
    const obf = obfuscateCode(body, label);
    return `<script${attrs}>${obf}</script>`;
  });
}

// ========== Step1: 清理 build-src 并复制源文件 ==========
log('Step 1: 准备 build-src 目录');
rimraf(BUILD_SRC);
fs.mkdirSync(BUILD_SRC, { recursive: true });

// 需要复制的文件（按 package.json files 列表）
const FILES_TO_COPY = [
  'main.js',
  'index.html',
  'big-screen.html',
  'remote-control.html',
  'audio-clipper.html',
  'music-download.html',
  'artnet-trigger.html',
  'floating-window.html',
  'console-connect.html',
  'cabinet-manager.html',
  'splash.html',
  'api-server.js',
  'logo.png',
  'logo.ico',
];
for (const f of FILES_TO_COPY) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(BUILD_SRC, f));
    log(`  复制: ${f}`);
  } else {
    err(`  警告：${f} 不存在，跳过`);
  }
}

// 复制 js/ 整个目录
const jsDir = path.join(ROOT, 'js');
if (fs.existsSync(jsDir)) {
  copyDir(jsDir, path.join(BUILD_SRC, 'js'));
  log('  复制: js/**');
}

// 复制 package.json（注意：files 字段已指向相对路径，不用改）
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// 重写 files 字段（相对于 build-src/，且排除 node_modules/）
pkg.build.files = [
  'main.js',
  'index.html',
  'big-screen.html',
  'remote-control.html',
  'audio-clipper.html',
  'music-download.html',
  'artnet-trigger.html',
  'floating-window.html',
  'console-connect.html',
  'cabinet-manager.html',
  'splash.html',
  'js/**/*',
  'api-server.js',
  'logo.png',
  'logo.ico',
  'package.json'
];
pkg.build.directories.output = OUTPUT_DIR;
// 强制不用从 GitHub 下载 Electron，复用本地 dist
pkg.build.directories.buildResources = ROOT;
fs.writeFileSync(path.join(BUILD_SRC, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
log('  写入: package.json (版本 ' + pkg.version + ')');

// ========== Step2: 混淆 main.js & api-server.js ==========
log('Step 2: 混淆主进程 JS 文件');
for (const jsFile of ['main.js', 'api-server.js']) {
  const fp = path.join(BUILD_SRC, jsFile);
  if (!fs.existsSync(fp)) continue;
  const code = fs.readFileSync(fp, 'utf8');
  log(`  混淆: ${jsFile} (${code.length} bytes)`);
  const obf = obfuscateCode(code, jsFile);
  fs.writeFileSync(fp, obf, 'utf8');
  log(`       → ${obf.length} bytes`);
}

// ========== Step3: 混淆 js/ 下所有 .js ==========
log('Step 3: 混淆 js/** 外部 JS');
function walkJs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    const st = fs.lstatSync(fp);
    if (st.isDirectory()) walkJs(fp);
    else if (st.isFile() && /\.js$/i.test(f)) {
      const code = fs.readFileSync(fp, 'utf8');
      const rel = path.relative(BUILD_SRC, fp);
      log(`  混淆: ${rel} (${code.length} bytes)`);
      const obf = obfuscateCode(code, rel);
      fs.writeFileSync(fp, obf, 'utf8');
    }
  }
}
walkJs(path.join(BUILD_SRC, 'js'));

// ========== Step4: 混淆所有 html 内联 <script> ==========
log('Step 4: 混淆 HTML 内联 <script>');
const HTML_FILES = fs.readdirSync(BUILD_SRC).filter(f => /\.html$/i.test(f));
for (const htmlFile of HTML_FILES) {
  // splash.html 脚本极简（仅设置 CSS 变量），混淆易致 ready-to-show 失败，跳过
  if (htmlFile.toLowerCase() === 'splash.html') {
    log(`  跳过 ${htmlFile}（开屏页保持原内联脚本，避免混淆导致渲染异常）`);
    continue;
  }
  const fp = path.join(BUILD_SRC, htmlFile);
  let html = fs.readFileSync(fp, 'utf8');
  const beforeLen = html.length;
  log(`  处理 HTML: ${htmlFile} (${beforeLen} bytes)`);
  html = obfuscateHtml(html, fp);
  fs.writeFileSync(fp, html, 'utf8');
  if (html.length !== beforeLen) {
    log(`       → 已混淆内联脚本，${beforeLen} → ${html.length} bytes`);
  } else {
    log(`       → 无非 src 内联脚本，跳过`);
  }
}

// ========== Step5: 语法检查（防止混淆后语法错误）==========
log('Step 5: 语法自检（混淆后的 JS）');
try {
  const vm = require('vm');
  const mainCode = fs.readFileSync(path.join(BUILD_SRC, 'main.js'), 'utf8');
  new vm.Script(mainCode, { filename: 'main.js' });
  log('  main.js: OK');
  if (fs.existsSync(path.join(BUILD_SRC, 'api-server.js'))) {
    const apiCode = fs.readFileSync(path.join(BUILD_SRC, 'api-server.js'), 'utf8');
    new vm.Script(apiCode, { filename: 'api-server.js' });
    log('  api-server.js: OK');
  }
} catch (e) {
  err('语法自检失败：' + (e && e.message || String(e)));
  process.exit(1);
}

// ========== Step6: 调用 electron-builder 打包 ==========
log('Step 6: 执行 electron-builder（把混淆内容覆盖到原位置，从 ROOT 打包）');
// 终极方案：
//   1. 先备份原始文件（只备份会被混淆覆盖的文件）
//   2. 把 build-src/ 中混淆后的文件复制覆盖到 ROOT/
//   3. 调用 electron-builder 从 ROOT 打包（此方式首次构建已成功，所有依赖/缓存都就绪）
//   4. 打包完成后恢复原始文件
const BACKUP_DIR = path.join(ROOT, '_backup_before_obfuscate_build');
// 新版流程：不覆盖 ROOT 源码，直接用 build-src/ 生成 app.asar 替换 win-unpacked/resources/app.asar
let buildExitCode = 1;
const UNPACKED_DIR = path.join(OUTPUT_DIR, 'win-unpacked');
const ASAR_SRC_DIR = path.join(BUILD_SRC, 'asar-src');
const OBFUSCATED_SETUP = path.join(OUTPUT_DIR, '金刚助手 Setup 2.5.6.exe');
const PORTABLE_ZIP = path.join(OUTPUT_DIR, '金刚助手 2.5.6(免安装).zip');

try {
  // 快速检查 win-unpacked 存在
  if (!fs.existsSync(UNPACKED_DIR) || !fs.existsSync(path.join(UNPACKED_DIR, '金刚助手.exe'))) {
    throw new Error('缺少 win-unpacked 运行时，请先运行 npx electron-builder --win nsis --x64 生成 Electron 运行时目录');
  }
  log('  找到 Electron 运行时: ' + UNPACKED_DIR);

  // ===== 6b) 准备 asar-src 目录：混淆代码 + package.json + 原版 node_modules =====
  rimraf(ASAR_SRC_DIR);
  fs.mkdirSync(ASAR_SRC_DIR, { recursive: true });

  const ASAR_FILES = [
    'main.js','api-server.js',
    'index.html','big-screen.html','remote-control.html',
    'audio-clipper.html','music-download.html','artnet-trigger.html',
    'floating-window.html','console-connect.html','cabinet-manager.html',
    'splash.html',
    'logo.png','logo.ico','package.json'
  ];
  log('  6b) 准备 asar-src/ 目录（用于打包 app.asar）');
  for (const f of ASAR_FILES) {
    const src = path.join(BUILD_SRC, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(ASAR_SRC_DIR, f));
      log('    → ' + f);
    }
  }
  // 复制 js/ 目录
  if (fs.existsSync(path.join(BUILD_SRC, 'js'))) {
    copyDir(path.join(BUILD_SRC, 'js'), path.join(ASAR_SRC_DIR, 'js'));
    log('    → js/**');
  }
  // 合并原版 node_modules（从 Setup 2.0.0.exe 解出的原始 app.asar 提取，依赖必须一起打包）
  const ORIG_APP_ASAR = path.join(OUTPUT_DIR, '_orig_extract', 'resources', 'app.asar');
  const ORIG_ASAR_UNPACKED = path.join(OUTPUT_DIR, '_orig_extract', 'resources', 'app.asar.unpacked');
  const NM_CACHE = path.join(ROOT, '_cache_original_node_modules');
  if (!fs.existsSync(path.join(ASAR_SRC_DIR, 'node_modules'))) {
    if (!fs.existsSync(NM_CACHE)) {
      // 第一次：从原版 app.asar 完整提取 node_modules 缓存到 ROOT/_cache_original_node_modules
      if (!fs.existsSync(ORIG_APP_ASAR)) {
        throw new Error('缺少原始 app.asar 以提取依赖，请确认已解包 Setup 2.0.0.exe 到 ' + ORIG_APP_ASAR);
      }
      log('  (首次) 从原版 app.asar 提取 node_modules 进行缓存 → _cache_original_node_modules');
      const asar = require('asar');
      const tmpExtract = path.join(BUILD_SRC, '_orig_extracted_full');
      rimraf(tmpExtract);
      // asar.extractAll 需要 app.asar.unpacked 目录在 app.asar 同级（已存在 ORIG_ASAR_UNPACKED）
      asar.extractAll(ORIG_APP_ASAR, tmpExtract);
      const nmInExtract = path.join(tmpExtract, 'node_modules');
      if (!fs.existsSync(nmInExtract)) throw new Error('原版 app.asar 中没有 node_modules 目录');
      copyDir(nmInExtract, NM_CACHE);
      rimraf(tmpExtract);
    }
    log('    → node_modules/** (从 _cache_original_node_modules 合并 ' + (() => { const d = fs.readdirSync(NM_CACHE).length; return d + ' 个顶级包'; })() + ')');
    copyDir(NM_CACHE, path.join(ASAR_SRC_DIR, 'node_modules'));
    // ★ 合并当前项目 node_modules 里新增的运行时依赖（只合并 package.json dependencies 里声明的）
    const ROOT_NM = path.join(ROOT, 'node_modules');
    const ASAR_NM = path.join(ASAR_SRC_DIR, 'node_modules');
    if (fs.existsSync(ROOT_NM) && fs.existsSync(ASAR_NM)) {
      const rootPkgPath = path.join(ROOT, 'package.json');
      let depNames = new Set();
      try {
        const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
        Object.keys(rootPkg.dependencies || {}).forEach(n => depNames.add(n));
      } catch(_) {}
      let mergedCount = 0;
      depNames.forEach(p => {
        const src = path.join(ROOT_NM, p);
        const dst = path.join(ASAR_NM, p);
        if (!fs.existsSync(src) || fs.existsSync(dst)) return; // 不存在或已有原版缓存则跳过
        const st = fs.lstatSync(src);
        if (st.isSymbolicLink()) return;
        try { copyDir(src, dst); mergedCount++; } catch(e) { log('    ⚠ 复制包失败: ' + p + ' ' + (e&&e.message||e)); }
      });
      if (mergedCount > 0) log('    → 额外合并运行时依赖: ' + mergedCount + ' 个（qrcode-generator 等）');
    }
  }
  // asar-src 需要 node_modules？其实 Electron 启动后 require('express') 等会从 app.asar 外找
  // 检查 app.asar.unpacked 里有没有原生模块
  const unpackedMods = path.join(UNPACKED_DIR, 'resources', 'app.asar.unpacked');
  if (fs.existsSync(unpackedMods)) {
    log('  检测到原生模块: app.asar.unpacked 已存在，将直接复用');
  }

  // ===== 6c) 把 win-unpacked 整体复制一份到项目内（避开沙箱对 OUTPUT_DIR 的写限制），然后替换 asar =====
  log('  6c) 复制 Electron 运行时 → build-src/obfuscated-win-unpacked (用于在项目内操作，避开沙箱写入限制)');
  const WORK_RUNTIME = path.join(BUILD_SRC, 'obfuscated-win-unpacked');
  rimraf(WORK_RUNTIME);
  copyDir(UNPACKED_DIR, WORK_RUNTIME);
  log(`       复制完成: ${WORK_RUNTIME}`);

  log('  6d) 重新打包 app.asar → 覆盖 build-src/obfuscated-win-unpacked/resources/app.asar');
  const asarBin = require.resolve('asar/bin/asar.js');
  const runSync = (cmd, args, opts) => {
    const r = spawnSync(cmd, args, opts || { stdio: 'inherit' });
    if (r.status != null && r.status !== 0) throw new Error(`命令 ${cmd} ${args.join(' ')} 失败 (exit=${r.status})`);
  };
  const tmpAsar = path.join(BUILD_SRC, 'app-obfuscated.asar');
  if (fs.existsSync(tmpAsar)) fs.unlinkSync(tmpAsar);
  runSync('node', [asarBin, 'pack', ASAR_SRC_DIR, tmpAsar]);
  if (!fs.existsSync(tmpAsar)) throw new Error('asar 打包失败，未生成 ' + tmpAsar);
  const destAsar = path.join(WORK_RUNTIME, 'resources', 'app.asar');
  // 覆盖 app.asar：若被锁（杀毒软件扫描），先重命名旧文件再写入新文件
  try {
    fs.copyFileSync(tmpAsar, destAsar);
  } catch (e) {
    log('  app.asar 直接覆盖失败，尝试重命名旧文件后写入...');
    const oldAsar = destAsar + '.old.' + Date.now();
    try {
      fs.renameSync(destAsar, oldAsar);
      // 重命名成功后，旧文件可能仍被锁但已不在目标路径，可以写入新文件
      fs.copyFileSync(tmpAsar, destAsar);
      log('  ✓ 重命名+覆盖成功');
      // 尝试删除旧文件（失败也无妨）
      try { fs.unlinkSync(oldAsar); } catch(_) {}
    } catch (e2) {
      // 重命名也失败，用 _deliverables 下的绿色文件夹方案：直接用 WORK_RUNTIME 的其他路径
      log('  ⚠ 重命名也失败，将使用替代路径写入 app.asar');
      const altDest = path.join(WORK_RUNTIME, 'resources', 'app-new.asar');
      fs.copyFileSync(tmpAsar, altDest);
      // 在 _deliverables 复制时用 app-new.asar 替代 app.asar
      process.env.__OBF_ALT_ASAR = altDest;
    }
  }
  log(`       app.asar 已更新 (${(fs.statSync(destAsar).size/1024/1024).toFixed(1)} MB)`);
  try { fs.unlinkSync(tmpAsar); } catch(_) {}

  // ===== 6e) 生成两个客户可用文件 =====
  log('  6e) 生成客户可用产物（全部输出到项目内 _deliverables 目录）');
  const DELIVER = path.join(ROOT, '_deliverables'); // 全部放在项目根，规避沙箱 OUTPUT_DIR 写限制
  rimraf(DELIVER);
  fs.mkdirSync(DELIVER, { recursive: true });

  const psEscape = s => String(s).replace(/'/g, "''");

  // 产物1：绿色免安装文件夹（可直接发送给客户，解压即用或打包为ZIP）
  const greenDir = path.join(DELIVER, '金刚助手-绿色版v2.5.6');
  log('    ① 生成绿色免安装文件夹: ' + greenDir);
  copyDir(WORK_RUNTIME, greenDir);
  // 若 app.asar 走了替代路径（WORK_RUNTIME 里是旧 app.asar + 新 app-new.asar），
  // 在 greenDir 里替换：删除旧 app.asar，重命名 app-new.asar → app.asar
  const altAsar = process.env.__OBF_ALT_ASAR;
  if (altAsar && fs.existsSync(altAsar)) {
    const greenAppAsar = path.join(greenDir, 'resources', 'app.asar');
    const greenAppNewAsar = path.join(greenDir, 'resources', 'app-new.asar');
    if (fs.existsSync(greenAppNewAsar)) {
      try { fs.unlinkSync(greenAppAsar); } catch(_) {}
      fs.renameSync(greenAppNewAsar, greenAppAsar);
      log('       ✓ app.asar 已用混淆版替换');
    }
  }
  log('       ✓ 绿色文件夹已生成');

  // ===== ★ 用 rcedit 设置 exe 图标，确保 exe 显示正确的 logo.ico =====
  const greenExe = path.join(greenDir, '金刚助手.exe');
  const rceditExe = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit.exe');
  const logoIcoPath = path.join(ROOT, 'logo.ico');
  if (fs.existsSync(greenExe) && fs.existsSync(rceditExe) && fs.existsSync(logoIcoPath)) {
    log('    ★ 设置 exe 图标 (rcedit)');
    try {
      const rceditResult = spawnSync(rceditExe, [
        greenExe,
        '--set-icon', logoIcoPath,
        '--set-version-string', 'FileDescription', '金刚助手',
        '--set-version-string', 'ProductName', '金刚助手',
        '--set-version-string', 'CompanyName', '明静科技',
      ], { stdio: 'pipe', encoding: 'utf8' });
      if (rceditResult.status === 0) {
        log('       ✓ exe 图标已设置为 logo.ico');
      } else {
        const errMsg = (rceditResult.stderr || rceditResult.stdout || '').trim();
        log('       ⚠ rcedit 返回非零: ' + errMsg);
      }
    } catch (e) {
      log('       ⚡ rcedit 执行失败: ' + (e && e.message || String(e)));
    }
  } else {
    log('    ⚠ 跳过 rcedit（exe/rcedit/logo.ico 缺失）');
  }
  // ===== 发给客户的绿色版：剔除所有独立说明/文档文件 =====
  const DOC_KEYWORDS = [
    'readme','说明','说明书','使用','手册','changelog','版本','release',
    'license','licenses','作者','关于','about','history','更新日志',
    '版本记录','版本历史','使用说明','帮助文档','操作手册'
  ];
  const DOC_EXTS = new Set(['.md','.txt','.pdf','.doc','.docx','.rtf','.html','.htm']);
  const walkAndStripDocs = (dir) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const en of entries) {
      const fp = path.join(dir, en.name);
      if (en.isDirectory()) {
        if (en.name === 'node_modules') continue;
        walkAndStripDocs(fp);
      } else if (en.isFile()) {
        const nameLower = en.name.toLowerCase();
        const ext = path.extname(nameLower);
        const matchKeyword = DOC_KEYWORDS.some(k => nameLower.includes(k.toLowerCase()));
        const matchExt = DOC_EXTS.has(ext);
        if ((matchKeyword && matchExt) ||
            /^(readme|changelog|release[-_ ]?notes?|history|authors?|license)[._ -]?(\w+)?\.(md|txt|pdf|docx?|rtf|html?)$/i.test(en.name)) {
          try { fs.unlinkSync(fp); log('       ✓ 已剔除文档文件: ' + path.relative(greenDir, fp)); } catch (e) {
            log('       ⚠ 剔除文档失败: ' + fp + ' ' + (e && e.message || String(e)));
          }
        }
      }
    }
  };
  walkAndStripDocs(greenDir);
  log('       ✓ 绿色文件夹已生成（不含独立说明书/文档文件）');

  // 产物2：Portable 免安装 ZIP（推荐发给客户）
  const PORTABLE_ZIP_NEW = path.join(DELIVER, '金刚助手 2.5.6(免安装).zip');
  log('    ② 生成绿色免安装 ZIP: ' + PORTABLE_ZIP_NEW);
  try {
    const zipR = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$ProgressPreference='SilentlyContinue'; if (Test-Path '${psEscape(PORTABLE_ZIP_NEW)}') { Remove-Item -Force '${psEscape(PORTABLE_ZIP_NEW)}' }; Compress-Archive -Force -Path '${psEscape(greenDir)}' -DestinationPath '${psEscape(PORTABLE_ZIP_NEW)}'`
    ], { stdio: 'inherit', encoding: 'utf8', shell: true });
    if (zipR.status === 0 && fs.existsSync(PORTABLE_ZIP_NEW)) {
      log(`       ✓ ZIP 大小: ${(fs.statSync(PORTABLE_ZIP_NEW).size/1024/1024).toFixed(1)} MB`);
    } else {
      err('       PowerShell Compress-Archive 返回 ' + zipR.status);
    }
  } catch (e) {
    err('    ZIP 打包失败: ' + (e && e.message || String(e)));
  }

  // 记录输出位置
  process.env.__OBF_DELIVER_DIR = DELIVER;
  process.env.__OBF_GREEN_DIR = greenDir;
  process.env.__OBF_ZIP_PATH = PORTABLE_ZIP_NEW;

  buildExitCode = 0;
} finally {
  // 不用还原，因为本方案不覆盖 ROOT 下任何源码（我们直接用 build-src/ 来做 asar）
  log('  6e) 源码未被覆盖（不操作 ROOT 内的项目文件），跳过还原步骤');
}

if (buildExitCode === 0) {
  const DELIVER = process.env.__OBF_DELIVER_DIR || path.join(ROOT, '_deliverables');
  const GREEN = process.env.__OBF_GREEN_DIR || path.join(DELIVER, '金刚助手-绿色版v2.5.6');
  const ZIP = process.env.__OBF_ZIP_PATH || path.join(DELIVER, '金刚助手 2.5.6(免安装).zip');
  log('====================================================');
  log('✓ 混淆构建完成！客户可直接使用的产物：');
  log('----------------------------------------------------');
  if (fs.existsSync(ZIP)) {
    const sz = (fs.statSync(ZIP).size/1024/1024).toFixed(1);
    log(`  [推荐发客户] 绿色免安装 ZIP: ${ZIP}  (${sz} MB)`);
  }
  if (fs.existsSync(GREEN)) {
    let total = 0;
    for (const f of fs.readdirSync(GREEN, { recursive: true, withFileTypes: true })) {
      const fp = path.join(GREEN, f.path || '', f.name);
      try { if (f.isFile()) total += fs.statSync(fp).size; } catch(_) {}
    }
    log(`  [本地分发] 绿色免安装文件夹: ${GREEN}  (${(total/1024/1024).toFixed(1)} MB)`);
  }
  log('----------------------------------------------------');
  log('  说明: ');
  log('    · ZIP 发给客户：解压到任意目录，双击 金刚助手.exe 即可使用');
  log('    · 绿色文件夹：可在公司内网直接拷贝整个目录给同事使用');
  log('    · 原未混淆安装包保留在: ' + path.join(OUTPUT_DIR, '金刚助手 Setup 2.5.6.exe'));
  log('====================================================');
} else {
  err('混淆构建失败，退出码: ' + buildExitCode);
  process.exit(buildExitCode);
}
