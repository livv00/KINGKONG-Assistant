// 导入 electron 模块
const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const ipcMain = electron.ipcMain;
const dialog = electron.dialog;
const globalShortcut = electron.globalShortcut;
const path = require('path');
const fs = require('fs');
const os = require('os');

// ========== 先设置应用名称（必须在 setPath('userData') 之前，否则 setName 可能重置 userData 路径）==========
app.setName('金刚助手');

// ========== 用户数据目录自动迁移（改名/历史版本不丢数据）==========
// 历史三个用户数据目录：
//   1) %APPDATA%/live-music-player  (最早 package.json name)
//   2) %APPDATA%/直播助手              (之前 app.setName('直播助手'))
//   3) %APPDATA%/金刚助手              (现在名字)
//
// 策略：
//   · 启动时按 旧 → 新 顺序查找有 localStorage/app-state.json 的目录
//   · 如果新目录还没有任何数据，就把旧目录文件整体复制过来
//   · 复制后留一份原目录作为备份（不删除，防止出问题可回滚）
//   · 迁移状态写 MIGRATED_MARKER，下次启动不再重复
//   · 使用 app.setPath('userData') 固定到"金刚助手"目录，不再依赖 appName，未来改显示名也不影响路径
//   · 额外保障：即使整体迁移已完成（marker 存在），仍检查 app-state.json 是否缺失，
//     若缺失则从所有旧目录中找最新的一份复制过来（防止 Local Storage 复制后被 Electron 重建丢数据）
(function migrateUserData() {
  const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const STABLE_DIR_NAME = '金刚助手';
  const NEW_DIR = path.join(APPDATA, STABLE_DIR_NAME);
  const OLD_DIRS = [
    path.join(APPDATA, '直播助手'),
    path.join(APPDATA, 'live-music-player'),
  ];
  const MIGRATED_MARKER = '.migrated-from-older-names';
  const STATE_RECOVERED_MARKER = '.app-state-recovered';

  // 固定 userData 到"金刚助手"，无论未来 app.setName 怎么改显示名，数据始终存一个目录
  try { app.setPath('userData', NEW_DIR); } catch (_) {}

  try {
    // 确保新目录存在
    if (!fs.existsSync(NEW_DIR)) {
      fs.mkdirSync(NEW_DIR, { recursive: true });
    }

    // ===== 第一阶段：整体目录迁移（仅首次运行）=====
    const markerPath = path.join(NEW_DIR, MIGRATED_MARKER);
    if (!fs.existsSync(markerPath)) {
      // 判断新目录是否"已有用户数据"：Local Storage 里有文件，或 app-state.json 有内容
      function hasUserData(dir) {
        try {
          const state = path.join(dir, 'app-state.json');
          if (fs.existsSync(state) && fs.statSync(state).size > 0) return true;
          const ls = path.join(dir, 'Local Storage');
          if (fs.existsSync(ls)) {
            const files = fs.readdirSync(ls);
            if (files.length > 0) return true;
          }
          const lsLeveldb = path.join(dir, 'Local Storage', 'leveldb');
          if (fs.existsSync(lsLeveldb)) {
            const f = fs.readdirSync(lsLeveldb);
            if (f.length > 0) return true;
          }
          // 还有 cabinet-config.json 等其他配置
          for (const cfg of ['cabinet-config.json', 'artnet-dmx-state.json', 'app-config.json', 'theme-cache.json']) {
            if (fs.existsSync(path.join(dir, cfg)) && fs.statSync(path.join(dir, cfg)).size > 0) return true;
          }
          return false;
        } catch (_) { return false; }
      }

      const newHasData = hasUserData(NEW_DIR);
      if (newHasData) {
        // 新目录已经有数据了，写 marker 防止以后再迁
        try { fs.writeFileSync(markerPath, 'done', 'utf-8'); } catch(_) {}
      } else {
        // 从旧目录找最新一个有数据的迁过来（优先迁"直播助手"，没有再迁 live-music-player）
        for (const oldDir of OLD_DIRS) {
          if (!fs.existsSync(oldDir)) continue;
          if (!hasUserData(oldDir)) continue;
          try {
            // 复制整个目录内容（含 Local Storage、各种 json）
            copyDir(oldDir, NEW_DIR, true);
            // 成功后写 marker
            try { fs.writeFileSync(markerPath, 'migrated from: ' + oldDir, 'utf-8'); } catch(_) {}
            console.log('[UserData 迁移] 旧目录数据复制成功：' + oldDir + ' → ' + NEW_DIR);
            break; // 只迁一次就够
          } catch(err) {
            console.error('[UserData 迁移] 复制失败：' + oldDir + ' → ' + NEW_DIR, err);
          }
        }
        // 旧目录也没有就不迁了，写 marker 标记已检查
        try { fs.writeFileSync(markerPath, 'no old data to migrate', 'utf-8'); } catch(_) {}
      }
    }

    // ===== 第二阶段：app-state.json 专项恢复（每次启动都检查）=====
    // Local Storage 是 LevelDB，Electron 可能重建数据库导致复制的数据丢失。
    // app-state.json 是独立文件，复制后不会丢。所以优先从旧目录恢复 app-state.json。
    const newStateFile = path.join(NEW_DIR, 'app-state.json');
    const recoveredMarker = path.join(NEW_DIR, STATE_RECOVERED_MARKER);
    const needRecover = !fs.existsSync(newStateFile) || fs.statSync(newStateFile).size === 0;
    if (needRecover && !fs.existsSync(recoveredMarker)) {
      // 遍历所有旧目录，找最新的 app-state.json
      let bestFile = null;
      let bestMtime = 0;
      for (const oldDir of OLD_DIRS) {
        const oldState = path.join(oldDir, 'app-state.json');
        if (fs.existsSync(oldState) && fs.statSync(oldState).size > 0) {
          const mtime = fs.statSync(oldState).mtimeMs;
          if (mtime > bestMtime) {
            bestMtime = mtime;
            bestFile = oldState;
          }
        }
      }
      if (bestFile) {
        try {
          fs.copyFileSync(bestFile, newStateFile);
          console.log('[app-state 恢复] 从旧目录复制 app-state.json：' + bestFile + ' → ' + newStateFile);
        } catch(err) {
          console.error('[app-state 恢复] 复制失败：', err);
        }
      }
      // 无论是否找到都写 marker，避免每次启动都重复检查
      try { fs.writeFileSync(recoveredMarker, 'checked at ' + new Date().toISOString(), 'utf-8'); } catch(_) {}
    }
  } catch(err) {
    console.error('[UserData 迁移] 顶层异常：', err);
  }

  // 递归复制目录
  function copyDir(src, dest, merge = true) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(s, d, merge);
      } else {
        // merge=true 时，如果目标文件已存在且有内容就不覆盖（保留新文件）
        if (merge && fs.existsSync(d)) {
          try {
            if (fs.statSync(d).size > 0) continue;
          } catch(_) {}
        }
        try { fs.copyFileSync(s, d); } catch(_) {}
      }
    }
  }
})();

// ========== 启用 Windows SMTC (System Media Transport Controls) ==========
// 让 navigator.mediaSession API 映射到 Windows 任务栏媒体控件
app.commandLine.appendSwitch('enable-features', 'MediaSessionService');

// ========== 设置 Windows 应用身份（防止 SMTC 显示"未知应用"）==========
// 必须在 app.whenReady 之前设置 AppUserModelID，这是 Windows 用来识别应用的唯一 ID
// 注意：app.setName 已在文件最开头调用（必须在 setPath('userData') 之前）
const APP_USER_MODEL_ID = 'com.jingang.assistant';
if (process.platform === 'win32') {
  try {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    // 开发模式下运行的是 electron.exe，Windows 无法从 exe 元数据获取应用名，
    // 需要在注册表中注册 AppUserModelID 的 DisplayName，SMTC 才能显示"金刚助手"
    const { execSync } = require('child_process');
    const regKey = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`;
    try {
      execSync(`reg add "${regKey}" /v DisplayName /t REG_SZ /d "金刚助手" /f`, { stdio: 'ignore' });
    } catch (_) {}
  } catch (_) {}
}
const http = require('http');
const url = require('url');
const querystring = require('querystring');
const dgram = require('dgram');

// 颜色加深/变浅工具函数（百分比，负数=加深）
function shadeColor(hex, percent) {
  let c = String(hex).replace(/^#/, '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  const num = parseInt(c, 16);
  let r = (num >> 16) & 0xFF;
  let g = (num >> 8) & 0xFF;
  let b = num & 0xFF;
  const amt = Math.round(2.55 * percent);
  r = Math.max(0, Math.min(255, r + amt));
  g = Math.max(0, Math.min(255, g + amt));
  b = Math.max(0, Math.min(255, b + amt));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

// 远程控制服务器状态
let remoteControlServer = null;
let remoteControlEnabled = true;

// ===== 远程控制 API：控台 / 电柜 缓存快照 =====
let cachedConsoleSnapshot = {
  updatedAt: 0,
  connected: false,
  ip: '',
  categories: [],        // [{ id, name, type, count, items: [{ id, name, status }] }]
  playingItems: [],       // [{ playId, catName, name, status, protected }]
  faders: [],             // [{ id, name, value }]
  sceneMutexEnabled: false,  // 场景互斥开关（手机端按钮状态同步依赖此字段）
  protectedPlayIds: [],     // 互斥保护的 playId 列表
};
let cachedCabinetRuntime = {
  updatedAt: 0,
  onlineMap: {},          // cabId -> true/false
  statusMap: {},          // cabId -> [0|1|-1, ...]
};

// ===== 远程控制 API：音乐播放实时状态缓存（主窗口通过 IPC 推送，避免读文件延迟） =====
let cachedMusicState = {
  updatedAt: 0,
  isPlaying: false,
  currentGroup: 0,
  currentPlayingIndex: -1,
  volume: 1,
  repeatMode: 'list',
  theme: 'dark',
  language: 'zh-CN', // 界面语言，手机远程控制页面通过 /api/status 或 /api/theme-config 获取以同步显示
};
// 分组+歌曲列表缓存（主窗口 IPC 推送，避免读磁盘 app-state.json 的旧数据）
let cachedGroups = {
  updatedAt: 0,
  groups: [], // [{ id, name, musicList: [{ title }] }]
};


// 主窗口实例
let mainWindow = null;

// ===== 全局快捷键 =====
let globalShortcutEnabled = false;
// 已注册的主界面快捷键（已升级为对象形式，支持返回「与主界面第几组第几首」详细信息）
// 元素：{ sc: electron格式字符串, module: '主界面-音乐', groupIndex: number, musicIndex: number }
let registeredShortcuts = [];

// ===== 悬浮窗口 =====
let floatingWindow = null;

// ===== ARTNET / sACN 接收服务器 =====
let artnetWindow = null;
let consoleWindow = null;
let cabinetWindow = null;
// 子窗口注册表（主窗口关闭时联动关闭）
const childWindows = new Set();
// 开屏广告窗口
let splashWindow = null;
// 主界面当前主题 + 主题色（用于打开电柜窗口/悬浮窗时同步默认值，以及随时广播给子窗口）
let currentThemeName = 'dark';
let currentThemeColor = '#ff6b6b';
const artnetState = {
  enabled: false,
  bindIp: '0.0.0.0',
  universe: 0,         // Universe (0-255)：Art-Net 用 combined(net*256+sub*16+uni)，sACN 直接用
  startAddress: 1,     // DMX 起始地址码 1-502（保证 11 通道 ≤512）
  socket6454: null,    // Art-Net UDP 6454
  socket5568: null,    // sACN UDP 5568
  lastChannels: {},    // universe -> [512 bytes], 用于边缘触发检测
  packetCount: 0,
  lastPacketTime: 0,
};

// ===== 应用配置文件（开屏广告开关等）=====
function getAppConfigPath() {
  try { return path.join(app.getPath('userData'), 'app-config.json'); }
  catch(_) { return path.join(__dirname, 'app-config.json'); }
}
function loadAppConfig() {
  try {
    const file = getAppConfigPath();
    if (!fs.existsSync(file)) return { showSplash: true };
    const raw = fs.readFileSync(file, 'utf-8');
    const obj = JSON.parse(raw || '{}');
    return { showSplash: obj.showSplash !== false };
  } catch(_) { return { showSplash: true }; }
}
function saveAppConfig(config) {
  try {
    const file = getAppConfigPath();
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf-8') || '{}'); } catch(_) {}
    Object.assign(existing, config);
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), 'utf-8');
  } catch(_) {}
}

// 获取本机所有可用 IPv4 地址（供绑定选择）
function getLocalNetworkIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  ips.push({ name: '所有地址 (0.0.0.0)', address: '0.0.0.0' });
  for (const ifaceName in interfaces) {
    const addrs = interfaces[ifaceName];
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) {
        ips.push({ name: `${ifaceName} (${a.address})`, address: a.address });
      }
    }
  }
  return ips;
}

// 解析 Art-Net ArtDmx 包
function parseArtNetDmxPacket(buf) {
  // ArtDmx 最小 18 字节
  if (buf.length < 18) return null;
  const magic = buf.toString('ascii', 0, 8);
  if (magic !== 'Art-Net\0') return null;
  const opcode = buf.readUInt16LE(8);
  if (opcode !== 0x5000) return null; // OpDmx
  const protoVer = buf.readUInt16BE(10);
  if (protoVer < 14) return null;
  const sequence = buf[12];
  const physical = buf[13];
  const subUni = buf[14];        // low 4 bit universe + high 4 bit subnet
  const net = buf[15] & 0x7F;    // net (0-127)
  const length = buf.readUInt16BE(16);
  const channels = Buffer.alloc(512);
  const copyLen = Math.min(length, 512, buf.length - 18);
  buf.copy(channels, 0, 18, 18 + copyLen);
  const universe = (subUni & 0x0F);
  const subNet = (subUni >> 4) & 0x0F;
  return {
    protocol: 'artnet',
    net, subNet, universe,
    combinedUniverse: net * 16 * 16 + subNet * 16 + universe,
    channels,
    length: copyLen,
  };
}

// 解析 sACN E1.31 包
function parseSacnPacket(buf) {
  if (buf.length < 126) return null;
  // Root Layer PDU: preamble size 0x0010, postamble 0x0000, ACN identifier
  if (buf.readUInt16BE(0) !== 0x0010) return null;
  const acnId = buf.toString('ascii', 4, 16);
  if (acnId !== 'ASC-E1.17\0\0\0') return null;
  const rootVector = buf.readUInt32BE(18);
  if (rootVector !== 0x00000004) return null; // Root Vector E1.31 Data
  // Framing Layer
  const framingFlagsLen = buf.readUInt16BE(38);
  const framingVector = buf.readUInt32BE(40);
  if (framingVector !== 0x00000002) return null;
  const universe = buf.readUInt16BE(113);
  // DMP Layer
  const dmpFlagsLen = buf.readUInt16BE(115);
  const dmpVector = buf[117];
  if (dmpVector !== 0x02) return null;
  const addrType = buf[118];
  const firstPropAddr = buf.readUInt16BE(119);
  const addrInc = buf.readUInt16BE(121);
  const propCount = buf.readUInt16BE(123);
  const startCode = buf[125];
  if (startCode !== 0x00) return null; // 非 DMX START CODE 忽略
  const channels = Buffer.alloc(512);
  const dmxDataStart = 126;
  const count = Math.min(propCount - 1, 512, buf.length - dmxDataStart);
  if (count > 0) {
    buf.copy(channels, 0, dmxDataStart, dmxDataStart + count);
  }
  return {
    protocol: 'sacn',
    universe,
    combinedUniverse: universe,
    channels,
    length: count,
  };
}

// 将收到的通道数据转发给主渲染进程 + ARTNET窗口
function dispatchDmxData(parsed) {
  if (!parsed) return;
  artnetState.packetCount++;
  artnetState.lastPacketTime = Date.now();

  // ① Universe 匹配检测（严格按设置，0-255）
  // Art-Net: combined = net*256 + subNet*16 + universe，当 net=0 时正好 0-255
  // sACN: universe 直接比较
  let match = false;
  if (parsed.protocol === 'artnet') {
    match = (parsed.combinedUniverse === artnetState.universe);
  } else {
    match = (parsed.universe === artnetState.universe);
  }
  if (!match) return; // 非设置域的数据包全部丢弃，不记录、不显示

  // ② 起始地址码按设置切片 7 通道
  const ch = parsed.channels; // Buffer 512
  const start = Math.max(1, Math.min(502, artnetState.startAddress)) - 1;
  const needed = 7;
  const end = Math.min(512, start + needed);
  const slice = new Array(needed).fill(0);
  for (let i = start, j = 0; i < end; i++, j++) {
    slice[j] = ch[i];
  }

  // 保存匹配域监控快照
  artnetState.lastSlice = slice;
  artnetState.lastSliceUniverse = parsed.universe;
  artnetState.lastSliceProtocol = parsed.protocol;

  const key = parsed.combinedUniverse;
  const prev = artnetState.lastChannels[key] || new Array(512).fill(0);
  const delta = slice.map((v, i) => ({ i, v, prev: prev[start + i] || 0 }))
                    .filter(o => o.v !== o.prev);
  // 保存快照
  const snap = Buffer.from(ch);
  artnetState.lastChannels[key] = snap;

  const payload = {
    protocol: parsed.protocol,
    universe: parsed.universe,
    combinedUniverse: parsed.combinedUniverse,
    startAddress: artnetState.startAddress,
    slice,          // 起始地址开始的11通道当前值
    raw512: Array.from(ch), // 完整512通道（供窗口显示）
    delta: delta.map(d => ({ index: d.i + 1, value: d.v, prev: d.prev })),
    packetCount: artnetState.packetCount,
    lastPacketTime: artnetState.lastPacketTime,
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('artnet-dmx', payload);
  }
  // ✅ ARTNET 监控显示只展示通过了 Universe/Net/SubNet 过滤 + 起始地址切好的数据
  if (artnetWindow && !artnetWindow.isDestroyed()) {
    artnetWindow.webContents.send('artnet-dmx-monitor', {
      protocol: payload.protocol,
      universe: payload.universe,
      combinedUniverse: payload.combinedUniverse,
      startAddress: payload.startAddress,
      slice: payload.slice,
      packetCount: payload.packetCount,
      lastPacketTime: payload.lastPacketTime,
    });
  }
}

function startArtNetServer() {
  stopArtNetServer();
  try {
    // Art-Net 端口
    const s1 = dgram.createSocket('udp4');
    s1.on('message', (msg, rinfo) => {
      const parsed = parseArtNetDmxPacket(msg);
      if (parsed) dispatchDmxData(parsed);
    });
    s1.on('error', (err) => {
      log('[ARTNET] Art-Net socket error:', err.message);
      try { s1.close(); } catch (_) {}
    });
    s1.bind(6454, artnetState.bindIp, () => {
      log(`[ARTNET] Art-Net listening on ${artnetState.bindIp}:6454`);
    });

    // sACN 端口（多播也接受单播）
    const s2 = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s2.on('message', (msg, rinfo) => {
      const parsed = parseSacnPacket(msg);
      if (parsed) dispatchDmxData(parsed);
      // 同时尝试按 Art-Net 解析（兼容性）
      const p2 = parseArtNetDmxPacket(msg);
      if (p2) dispatchDmxData(p2);
    });
    s2.on('error', (err) => {
      log('[ARTNET] sACN socket error:', err.message);
      try { s2.close(); } catch (_) {}
    });
    s2.bind(5568, artnetState.bindIp, () => {
      log(`[ARTNET] sACN listening on ${artnetState.bindIp}:5568`);
      try {
        // 加入 sACN 多播组 239.255.x.x
        const u = artnetState.universe;
        const hi = (u >> 8) & 0xFF;
        const lo = u & 0xFF;
        const mcast = `239.255.${hi}.${lo}`;
        s2.addMembership(mcast, artnetState.bindIp === '0.0.0.0' ? undefined : artnetState.bindIp);
        log(`[ARTNET] sACN joined multicast ${mcast}`);
      } catch (_) {}
    });

    artnetState.socket6454 = s1;
    artnetState.socket5568 = s2;
    artnetState.enabled = true;
    return { success: true };
  } catch (err) {
    log('[ARTNET] start failed:', err.message);
    return { success: false, error: err.message };
  }
}

function stopArtNetServer() {
  artnetState.enabled = false;
  if (artnetState.socket6454) {
    try { artnetState.socket6454.close(); } catch (_) {}
    artnetState.socket6454 = null;
  }
  if (artnetState.socket5568) {
    try { artnetState.socket5568.close(); } catch (_) {}
    artnetState.socket5568 = null;
  }
  artnetState.lastChannels = {};
  log('[ARTNET] server stopped');
}


// 路径管理工具
const pathUtils = {
  // 获取应用根目录
  getAppRoot: () => {
    return __dirname;
  },
  
  // 确保目录存在
  ensureDir: (dirPath) => {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return dirPath;
  },
  
  // 安全地连接路径
  join: (...parts) => {
    return path.join(...parts);
  },
  
  // 获取应用数据目录
  getAppDataDir: () => {
    const appDataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'LiveMusicPlayer');
    return pathUtils.ensureDir(appDataDir);
  },
  
  // 获取日志目录
  getLogDir: () => {
    const logDir = path.join(pathUtils.getAppDataDir(), 'logs');
    return pathUtils.ensureDir(logDir);
  },
  
  // 获取临时目录
  getTempDir: () => {
    return os.tmpdir();
  },
  
  // 验证文件路径是否存在
  exists: (filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch (error) {
      console.log('路径验证错误:', error.message);
      return false;
    }
  },
  
  // 规范化路径
  normalize: (filePath) => {
    return path.normalize(filePath);
  }
};

// 简单的文件日志函数
function logToFile(...messages) {
  try {
    const logFilePath = path.join(__dirname, 'app.log');
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${messages.map(msg => typeof msg === 'object' ? JSON.stringify(msg) : msg).join(' ')}\n`;
    fs.appendFileSync(logFilePath, logMessage);
    console.log(...messages);
  } catch (error) {
    console.error('日志写入失败:', error.message);
  }
}

// 日志管理系统
const logManager = {
  // 日志级别
  levels: {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    FATAL: 4
  },
  
  // 当前日志级别
  currentLevel: 1, // 默认INFO
  
  // 日志文件路径
  logFilePath: pathUtils.join(pathUtils.getLogDir(), 'app.log'),
  
  // 日志文件流
  logFile: null,
  
  // 初始化日志系统
  init: function() {
    try {
      // 确保日志目录存在
      pathUtils.ensureDir(pathUtils.getLogDir());
      
      // 创建日志文件流
      this.logFile = fs.createWriteStream(this.logFilePath, { flags: 'a' });
      
      // 写入启动日志
      this.info('日志系统初始化完成', { logFilePath: this.logFilePath });
      
      // 监听进程退出，关闭日志文件
      process.on('exit', () => {
        this.info('应用退出');
        this.close();
      });
      
      // 监听未捕获的异常
      process.on('uncaughtException', (err) => {
        logManager.error('未捕获的异常', { error: err.message, stack: err.stack });
      });
      
    } catch (err) {
      console.error('日志系统初始化失败:', err.message);
    }
  },
  
  // 关闭日志文件
  close: function() {
    if (this.logFile) {
      try {
        this.logFile.end();
      } catch (error) {
        console.error('关闭日志文件失败:', error.message);
      }
    }
  },
  
  // 生成日志消息
  formatMessage: function(level, ...args) {
    const timestamp = new Date().toISOString();
    const levelName = Object.keys(this.levels).find(key => this.levels[key] === level);
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    return `[${timestamp}] [${levelName}] ${message}\n`;
  },
  
  // 写入日志
  write: function(level, ...args) {
    if (level < this.currentLevel) return;
    
    const logMessage = this.formatMessage(level, ...args);
    
    // 输出到控制台
    console.log(...args);
    
    // 写入文件
    if (this.logFile) {
      try {
        this.logFile.write(logMessage);
      } catch (err) {
        console.error('日志写入失败:', err.message);
      }
    }
  },
  
  // 调试级别日志
  debug: function(...args) {
    this.write(this.levels.DEBUG, ...args);
  },
  
  // 信息级别日志
  info: function(...args) {
    this.write(this.levels.INFO, ...args);
  },
  
  // 警告级别日志
  warn: function(...args) {
    this.write(this.levels.WARN, ...args);
  },
  
  // 错误级别日志
  error: function(...args) {
    this.write(this.levels.ERROR, ...args);
  },
  
  // 致命级别日志
  fatal: function(...args) {
    this.write(this.levels.FATAL, ...args);
  },
  
  // 设置日志级别
  setLevel: function(level) {
    if (this.levels[level] !== undefined) {
      this.currentLevel = this.levels[level];
      this.info(`日志级别设置为: ${level}`);
    }
  },
  
  // 获取日志文件路径
  getLogFilePath: function() {
    return this.logFilePath;
  }
};

// 初始化日志系统
console.log('开始初始化日志系统...');
logManager.init();
console.log('日志系统初始化完成');

// 导出日志管理器
const log = logManager.info.bind(logManager);
const info = logManager.info.bind(logManager);
const debug = logManager.debug.bind(logManager);
const warn = logManager.warn.bind(logManager);
const error = logManager.error.bind(logManager);
const fatal = logManager.fatal.bind(logManager);

// 测试日志系统
console.log('测试日志系统...');
log('应用启动');
log('日志文件路径:', logManager.getLogFilePath());
console.log('日志系统测试完成');

// 移除@electron/remote依赖，因为Electron 25.0.0已不再支持

// 尝试加载midi模块
// console.log('开始加载MIDI模块...');
let midi = null;

function initializeMidi() {
  try {
    // 尝试使用标准方式加载midi模块
    midi = require('midi');
    
    // 检测MIDI设备
    detectMidiDevices();
  } catch (err) {
    log('MIDI模块加载失败:', err.message);
    log('MIDI功能将不可用');
  }
}

// 检测MIDI设备
function detectMidiDevices() {
  const devices = {
    inputs: [],
    outputs: []
  };
  
  if (!midi) {
    return devices;
  }
  
  try {
    // 检测MIDI输入设备
    const input = new midi.Input();
    const inputCount = input.getPortCount();
    
    for (let i = 0; i < inputCount; i++) {
      try {
        const inputName = input.getPortName(i);
        devices.inputs.push({
          index: i,
          name: inputName
        });
      } catch (portError) {
        // 静默处理错误
      }
    }
    
    // 检测MIDI输出设备
    const output = new midi.Output();
    const outputCount = output.getPortCount();
    
    for (let i = 0; i < outputCount; i++) {
      try {
        const outputName = output.getPortName(i);
        devices.outputs.push({
          index: i,
          name: outputName
        });
      } catch (portError) {
        // 静默处理错误
      }
    }
  } catch (error) {
    // 静默处理错误
  }
  
  return devices;
}

// 初始化MIDI模块
initializeMidi();

// MTC状态
let mtcState = null;
// MTC接收状态
let mtcReceiveState = null;

// ===== 全局快捷键辅助函数（顶层定义，createWindow 内部和 ipcMain 顶层 handler 都能访问） =====
function shortcutToElectronFormat(sc) {
  if (!sc) return null;
  let parts = sc.split('+');
  const key = parts.pop().toUpperCase();
  let result = '';
  if (parts.includes('Ctrl')) result += 'CommandOrControl+';
  if (parts.includes('Alt')) result += 'Alt+';
  if (parts.includes('Shift')) result += 'Shift+';
  const keyMap = { 'SPACE': 'Space', 'ESC': 'Escape' };
  result += keyMap[key] || key;
  return result;
}
function unregisterAllGlobalShortcuts() {
  registeredShortcuts.forEach(item => {
    try { globalShortcut.unregister(item.sc); } catch (_) {}
  });
  registeredShortcuts = [];
}
function findRegisteredShortcut(electronSc) {
  for (const it of registeredShortcuts) {
    if (it.sc === electronSc) return it;
  }
  return null;
}

function createWindow() {
    // T2: 恢复主窗口上次位置和大小
    const savedState = loadWindowState('main');
    const winBounds = (savedState && savedState.bounds) ? savedState.bounds : { width: 1600, height: 800 };
    // 创建浏览器窗口
    mainWindow = new BrowserWindow({
      width: winBounds.width || 1600,
      height: winBounds.height || 800,
      x: winBounds.x,
      y: winBounds.y,
      title: '金刚助手',
      icon: path.join(__dirname, 'logo.ico'),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        enableRemoteModule: true,
        // 启用Web MIDI API
        webgl: true,
        webSecurity: false,
        // 允许运行不安全的内容（包括Web MIDI API）
        allowRunningInsecureContent: true
      },
      // 隐藏菜单栏
      autoHideMenuBar: true
    });
    // T2: 如果上次是最大化，恢复最大化
    if (savedState && savedState.isMaximized) {
      mainWindow.maximize();
    }

  // 加载应用的 index.html
  mainWindow.loadFile('index.html');

  // 开发者工具已关闭（生产模式）

  // 当渲染进程完全加载完成后，再启动远程控制服务器
  mainWindow.webContents.on('did-finish-load', () => {
    // 默认启动远程控制服务器
    startRemoteControlServer();
    // 需求6：主窗口启动后，根据记忆状态决定是否自动打开「连接控台」窗口
    try {
      const saved = loadConsoleWinState();
      if (saved && saved.open) {
        // 延迟一点点，确保主窗口完全渲染再开控台窗口
        setTimeout(() => {
          // 直接调用，不传 themeName（走默认主题，窗口内部再同步自己的主题）
          try {
            // 复用 ipc 发消息给自己：直接走事件即可
            ipcMain.emit('open-console-window', { sender: mainWindow && mainWindow.webContents || null, returnValue: null }, null);
          } catch(_) {}
        }, 350);
      }
    } catch(_) {}
  });
  
  // 测试远程控制服务器
  setTimeout(() => {
    if (remoteControlServer) {
      // 远程控制服务器正在运行
    } else {
      // 尝试手动启动远程控制服务器
      startRemoteControlServer();
    }
  }, 3000);

  // 移除remote模块引用

  // 禁用开发工具
  // 移除自动打开开发工具的代码
  // 临时开启F12键打开开发工具（用于调试MTC暂停问题）
  // mainWindow.webContents.on('before-input-event', (event, input) => {
  //   if (input.key === 'F12') {
  //     event.preventDefault();
  //   }
  // });
  // 需求6：主窗口关闭时，如果连接控台窗口此时仍处于打开状态（未 destroyed），记为 open=true
  //       这样用户主窗口关闭、下次再打开时控台窗口可以自动按状态恢复
  // T2: 主窗口 resize/move 实时保存位置和大小
  attachWindowStateSaver('main', mainWindow);
  mainWindow.on('close', () => {
    // T2: 保存主窗口位置和大小
    saveWindowState('main', mainWindow);
    // 保存连接控台窗口的打开状态
    const consoleStillOpen = !!(consoleWindow && !consoleWindow.isDestroyed());
    saveConsoleWinState(consoleStillOpen);
    // 需求2：关闭主窗口时联动关闭所有子窗口
    for (const child of childWindows) {
      try {
        if (child && !child.isDestroyed()) {
          // 先保存子窗口状态
          const childBounds = child.getBounds();
          const childMax = child.isMaximized();
          // 通过标题或其它方式识别窗口名称进行保存
          child.close();
          // 500ms 兜底 destroy
          const wid = child.id;
          setTimeout(() => {
            try {
              const w = BrowserWindow.fromId(wid);
              if (w && !w.isDestroyed()) w.destroy();
            } catch (_) {}
          }, 500);
        }
      } catch (_) {}
    }
    childWindows.clear();
    // 关闭大屏窗口（不在 childWindows 集合中，需单独关闭）
    // ⚠ 不能直接 destroy —— 大屏窗口 alwaysOnTop:true 覆盖整个副屏，
    // 直接销毁会导致 Windows 不重绘被遮挡区域 → 副屏黑屏。
    // 必须先取消置顶 + 移出屏幕，让 Windows 重绘副屏桌面，再 destroy。
    // ⭐ 先通知渲染进程"正在关闭"，防止 big-screen-closed 回调中自动重开窗口
    try { mainWindow.webContents.send('main-window-closing'); } catch(_) {}
    try {
      if (bigScreenWindow && !bigScreenWindow.isDestroyed()) {
        try {
          bigScreenWindow.setAlwaysOnTop(false);
          bigScreenWindow.setBounds({ x: -10000, y: -10000, width: 1, height: 1 });
        } catch (_) {}
        bigScreenWindow.destroy();
        bigScreenWindow = null;
      }
    } catch (_) {}
    // 关闭多轨编辑器进程
    try {
      if (multiTrackEditorProcess && !multiTrackEditorProcess.killed) {
        multiTrackEditorProcess.kill();
        multiTrackEditorProcess = null;
      }
    } catch (_) {}

    // ⚠ 关闭所有其他窗口（不在 childWindows 集合中的独立窗口）
    // 悬浮窗
    try {
      if (floatingWindow && !floatingWindow.isDestroyed()) {
        floatingWindow.destroy();
        floatingWindow = null;
      }
    } catch (_) {}
    // ARTNET 窗口
    try {
      if (artnetWindow && !artnetWindow.isDestroyed()) {
        artnetWindow.destroy();
        artnetWindow = null;
      }
    } catch (_) {}
    // 连接控台窗口
    try {
      if (consoleWindow && !consoleWindow.isDestroyed()) {
        consoleWindow.destroy();
        consoleWindow = null;
      }
    } catch (_) {}
    // 电柜管理窗口
    try {
      if (cabinetWindow && !cabinetWindow.isDestroyed()) {
        cabinetWindow.destroy();
        cabinetWindow = null;
      }
    } catch (_) {}
    // 开屏窗口（若尚未关闭）
    try {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.destroy();
        splashWindow = null;
      }
    } catch (_) {}

    // ⚠ 关闭所有后台资源（HTTP/UDP/MIDI 等），防止事件循环被持有导致进程不退出
    // 远程控制 HTTP 服务器
    try {
      if (remoteControlServer) {
        remoteControlServer.close();
        remoteControlServer = null;
      }
    } catch (_) {}
    // 电柜 UDP Socket
    try {
      if (unifiedRecvSocket && typeof unifiedRecvSocket.close === 'function') {
        unifiedRecvSocket.removeAllListeners('message');
        unifiedRecvSocket.removeAllListeners('error');
        unifiedRecvSocket.close(() => {});
        unifiedRecvSocket = null;
      }
    } catch (_) {}
    // 电柜 pending 定时器
    try {
      if (cabinetPendingTimer) {
        clearInterval(cabinetPendingTimer);
        cabinetPendingTimer = null;
      }
    } catch (_) {}
    // 注销全局快捷键
    try {
      unregisterAllGlobalShortcuts();
    } catch (_) {}

    // ⚠ 强制退出整个应用进程
    // 不调用 app.quit() 的话，残留的 GPU 进程/渲染进程会继续占用副屏导致黑屏
    app.quit();
    // 兜底：500ms 后如果进程还没退出，直接 exit(0) 强制杀掉
    setTimeout(() => { try { app.exit(0); } catch (_) {} }, 500);
  });

  // ===== 悬浮窗口 =====
  ipcMain.on('open-floating-window', () => {
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.show();
      floatingWindow.focus();
      // 已存在的窗口也同步一次状态
      floatingWindow.webContents.send('floating-global-shortcut-state', { enabled: globalShortcutEnabled });
      return;
    }
    // T2: 恢复悬浮窗上次位置（大小固定不变）
    const _fwState = loadWindowState('floating');
    floatingWindow = new BrowserWindow({
      width: 320,
      height: 150,
      x: (_fwState && _fwState.bounds && _fwState.bounds.x !== undefined) ? _fwState.bounds.x : undefined,
      y: (_fwState && _fwState.bounds && _fwState.bounds.y !== undefined) ? _fwState.bounds.y : undefined,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      transparent: true,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    floatingWindow.loadFile('floating-window.html');
    // 记录悬浮窗已打开
    try { mainWindow.webContents.executeJavaScript(`localStorage.setItem('floatingWindowOpen','true')`); } catch(_){}
    floatingWindow.on('close', () => {
      // T2: 保存悬浮窗位置
      saveWindowState('floating', floatingWindow);
    });
    floatingWindow.on('closed', () => {
      floatingWindow = null;
      // 记录悬浮窗已关闭
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.executeJavaScript(`localStorage.setItem('floatingWindowOpen','false')`); } catch(_){}
    });
    // 悬浮窗加载完成后推送当前状态 + 主题
    floatingWindow.webContents.on('did-finish-load', () => {
      floatingWindow.webContents.send('floating-global-shortcut-state', { enabled: globalShortcutEnabled });
      // 推送当前主题
      floatingWindow.webContents.executeJavaScript(`try{applyFwTheme(localStorage.getItem('musicControllerTheme')||'dark')}catch(_){}`);
      // 推送当前语言
      floatingWindow.webContents.send('language-data', cachedMusicState.language || 'zh-CN');
    });
    // 悬浮窗拖动通过 CSS -webkit-app-region: drag 实现
  });

  ipcMain.on('close-floating-window', () => {
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.close();
      floatingWindow = null;
    }
  });

  // 悬浮窗 → 主窗口：播放控制
  ipcMain.on('floating-play-pause', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('floating-action', 'play-pause');
    }
  });
  ipcMain.on('floating-stop', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('floating-action', 'stop');
    }
  });
  ipcMain.on('floating-prev', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('floating-action', 'prev');
    }
  });
  ipcMain.on('floating-next', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('floating-action', 'next');
    }
  });

  // 主窗口 → 悬浮窗：播放状态同步
  ipcMain.on('floating-state-update', (event, data) => {
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.webContents.send('floating-state', data);
    }
  });

  // 主窗口 → 悬浮窗：主题同步
  ipcMain.on('floating-theme-sync', (event, themeName) => {
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.webContents.send('floating-theme', themeName);
    }
  });

  // 主窗口主题变更 → 同步到连接控台窗口
  ipcMain.on('console-theme-sync', (event, themeName) => {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      consoleWindow.webContents.send('theme-data', themeName);
    }
  });

  // ===== I18N：主窗口语言变更 → 更新缓存 + 广播给所有子窗口 =====
  function broadcastLanguageToAllChildren(langCode) {
    const code = langCode || 'zh-CN';
    const broadcasts = [
      { w: floatingWindow,    label: 'floating',    event: 'language-data' },
      { w: musicDownloadWindow,label: 'download',   event: 'language-data' },
      { w: audioClipperWindow, label: 'clipper',    event: 'language-data' },
      { w: artnetWindow,       label: 'artnet',     event: 'language-data' },
      { w: consoleWindow,      label: 'console',    event: 'language-data' },
      { w: cabinetWindow,      label: 'cabinet',    event: 'language-data' },
      { w: bigScreenWindow,    label: 'bigscreen',  event: 'language-data' },
    ];
    broadcasts.forEach(({ w, event }) => {
      try {
        if (w && !w.isDestroyed()) { w.webContents.send(event, code); }
      } catch (_) {}
    });
    // 同步 splash（开屏一般已关闭，做兜底）
    try {
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send('language-data', code);
    } catch (_) {}
  }
  ipcMain.on('i18n-language-changed', (event, langCode) => {
    // 仅更新主进程缓存，供手机端 /api/status 轮询检测并重译
    // 完全重启生效方案：不再调 broadcastLanguageToAllChildren 广播给子窗口
    // 原因：子窗口运行时不再实时翻译(避免全量遍历 DOM 卡顿)，靠重启软件按 localStorage 恢复
    try {
      cachedMusicState.language = langCode || 'zh-CN';
    } catch (_) {}
    // broadcastLanguageToAllChildren(langCode || 'zh-CN'); // 故意注释：保留代码以便后续恢复实时翻译方案
  });

  // ===== I18N：完全重启生效方案 - 用户切换语言后提示"重启生效"，点是则重启整个应用 =====
  // 用 app.relaunch() 重启新进程 + app.exit(0) 立即退出当前进程
  // 退出时会触发 before-quit，走与"关闭主窗口"相同的清理流程（关闭所有子窗口、HTTP、UDP、定时器、全局快捷键）
  // 因为已经 app.exit(0) 兜底，即使 before-quit 阻塞也不会残留进程
  ipcMain.on('app-relaunch', () => {
    try { app.relaunch(); } catch (_) {}
    try { app.exit(0); } catch (_) {}
  });

  // 控台窗口 → 主窗口：连接状态同步
  ipcMain.on('console-status-sync', (event, state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('console-status', state);
    }
  });

  // ===== 远程控制 API：控台快照推送（控台窗口定期/状态变化时上报） =====
  ipcMain.on('console-snapshot-push', (event, snap) => {
    try {
      if (snap && typeof snap === 'object') {
        cachedConsoleSnapshot = {
          updatedAt: Date.now(),
          connected: !!snap.connected,
          ip: snap.ip || '',
          categories: Array.isArray(snap.categories) ? snap.categories : [],
          playingItems: Array.isArray(snap.playingItems) ? snap.playingItems : [],
          faders: Array.isArray(snap.faders) ? snap.faders : [],
          sceneMutexEnabled: !!snap.sceneMutexEnabled,
          protectedPlayIds: Array.isArray(snap.protectedPlayIds) ? snap.protectedPlayIds : [],
        };
      }
    } catch (_) {}
  });

  // ===== 远程控制 API：控台远程指令（HTTP→控台窗口） =====
  ipcMain.on('console-remote-cmd', (event, cmd) => {
    try {
      if (!cmd || !cmd.action) return;
      if (consoleWindow && !consoleWindow.isDestroyed()) {
        consoleWindow.webContents.send('console-remote-cmd', cmd);
      }
    } catch (_) {}
  });

  // ===== 远程控制 API：音乐播放状态实时推送（主窗口→主进程缓存） =====
  ipcMain.on('music-state-push', (event, st) => {
    try {
      if (st && typeof st === 'object') {
        cachedMusicState = {
          updatedAt: Date.now(),
          isPlaying: !!st.isPlaying,
          currentGroup: st.currentGroup !== undefined ? st.currentGroup : cachedMusicState.currentGroup,
          currentPlayingIndex: st.currentPlayingIndex !== undefined ? st.currentPlayingIndex : cachedMusicState.currentPlayingIndex,
          volume: st.volume !== undefined ? st.volume : cachedMusicState.volume,
          repeatMode: st.repeatMode || cachedMusicState.repeatMode,
          theme: st.theme || cachedMusicState.theme,
          language: st.language || cachedMusicState.language,
        };
      }
    } catch (_) {}
  });
  // 主窗口推送分组+歌曲列表（groups 变更或 save 时触发）
  ipcMain.on('music-groups-push', (event, payload) => {
    try {
      if (payload && Array.isArray(payload.groups)) {
        const simplifiedGroups = payload.groups.map(group => ({
          id: group.id,
          name: group.name,
          musicList: Array.isArray(group.musicList)
            ? group.musicList.map(m => ({ title: m && m.title ? m.title : (typeof m === 'string' ? m : '未命名') }))
            : []
        }));
        cachedGroups = {
          updatedAt: Date.now(),
          groups: simplifiedGroups
        };
      }
    } catch (_) {}
  });

  // ===== 全局快捷键 =====
  // （shortcutToElectronFormat / unregisterAllGlobalShortcuts / findRegisteredShortcut
  //   已移至文件顶层，因为 ipcMain.on('console-shortcut-register') 等顶层 IPC handler 也需要调用它们）

  function registerGlobalShortcuts(shortcutsData) {
    // shortcutsData: { "groupIndex": { "musicIndex": "Ctrl+A", ... }, ... }
    unregisterAllGlobalShortcuts();
    if (!shortcutsData) return;

    for (let groupIdx in shortcutsData) {
      const group = shortcutsData[groupIdx];
      for (let musicIdx in group) {
        const sc = group[musicIdx];
        const electronSc = shortcutToElectronFormat(sc);
        if (!electronSc) continue;
        try {
          const ok = globalShortcut.register(electronSc, () => {
            log(`[全局快捷键] 触发: ${sc} → 分组${groupIdx} 歌曲${musicIdx}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('global-shortcut-triggered', {
                group: parseInt(groupIdx),
                music: parseInt(musicIdx)
              });
            }
          });
          if (ok) {
            registeredShortcuts.push({
              sc: electronSc,
              module: '主界面-音乐',
              groupIndex: parseInt(groupIdx, 10),
              musicIndex: parseInt(musicIdx, 10),
              displayName: `第 ${(parseInt(groupIdx, 10) + 1)} 分组 第 ${(parseInt(musicIdx, 10) + 1)} 首音乐`
            });
          } else {
            log(`[全局快捷键] 注册失败（可能被占用）: ${electronSc}`);
          }
        } catch (err) {
          log(`[全局快捷键] 注册异常: ${electronSc} - ${err.message}`);
        }
      }
    }
  }

  // 同步全局快捷键状态到主窗口 + 悬浮窗
  function broadcastGlobalShortcutState(enabled) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('global-shortcut-status', { enabled: enabled });
    }
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      floatingWindow.webContents.send('floating-global-shortcut-state', { enabled: enabled });
    }
  }

  ipcMain.on('global-shortcut-toggle', (event, enabled) => {
    globalShortcutEnabled = enabled;
    if (enabled) {
      // 向渲染进程请求当前快捷键数据
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('global-shortcut-request-data');
      }
    } else {
      unregisterAllGlobalShortcuts();
      log('[全局快捷键] 已关闭，注销所有快捷键');
    }
    broadcastGlobalShortcutState(globalShortcutEnabled);
  });

  // 悬浮窗：请求当前全局快捷键状态
  ipcMain.on('floating-global-shortcut-request', (event) => {
    event.reply('floating-global-shortcut-state', { enabled: globalShortcutEnabled });
  });

  // 悬浮窗：设置全局快捷键开关 → 复用与主窗口同样的切换流程
  ipcMain.on('floating-global-shortcut-set', (event, enabled) => {
    globalShortcutEnabled = enabled;
    if (enabled) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('global-shortcut-request-data');
      }
    } else {
      unregisterAllGlobalShortcuts();
      log('[全局快捷键] 悬浮窗关闭，注销所有快捷键');
    }
    // 广播状态给两个窗口（主窗口需要同步复选框 + 存 localStorage）
    broadcastGlobalShortcutState(globalShortcutEnabled);
    // 额外通知主窗口需要把新开关值存入 localStorage
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('global-shortcut-persist', { enabled: globalShortcutEnabled });
    }
  });

  // 渲染进程返回快捷键数据
  ipcMain.on('global-shortcut-data', (event, data) => {
    if (globalShortcutEnabled) {
      registerGlobalShortcuts(data);
      log(`[全局快捷键] 已注册 ${registeredShortcuts.length} 个快捷键`);
    }
  });

  // 渲染进程快捷键变更时，如果全局快捷键已开启，重新注册
  ipcMain.on('global-shortcut-update', (event, data) => {
    if (globalShortcutEnabled) {
      registerGlobalShortcuts(data);
      log(`[全局快捷键] 快捷键变更，重新注册 ${registeredShortcuts.length} 个`);
    }
  });

  ipcMain.on('global-shortcut-status', (event) => {
    event.reply('global-shortcut-status', { enabled: globalShortcutEnabled });
  });

  // 监听渲染进程的MIDI设备检测请求
  ipcMain.on('refresh-midi-devices', (event) => {
    log('收到MIDI设备检测请求');
    const devices = detectMidiDevices();
    log('检测到的MIDI设备:', devices);
    event.reply('midi-devices', devices);
  });
// ================== MTC 停止归零序列：可调配置 + FullMTC SysEx ==================
// 全局停止归零配置（对齐小红花抓包行为：不发 SysEx、不发 0xFC、只发 1 帧 QF 零 + panic burst）
let globalMtcStopCfg = {
  zeroRepeat: 1,            // 归零 quarter-frame 帧数（小红花只发 1 帧 QF 零，不做连发）
  sendFF: false,            // 是否在序列最开头先发 System Reset(0xFF)（小红花不发）
  sendFullMTC: false,      // 是否发送 Full MTC SysEx（小红花完全不发 SysEx，置 false）
  firstFullThenZero: true,  // true=先发 FullMTC 再发 QF 连发；false=先 QF 再 Full（sendFullMTC=false 时无效）
  sendFullMTCAtEnd: false,  // 结束前是否再补一条 FullMTC 00（小红花不发，置 false）
  sendPanicBurst: true,     // 是否发送 CC panic burst（B0-BF 7B 00 + 79 00 全 16 通道，小红花必发）
  panicBurstCount: 4,       // panic burst 重复次数（小红花每秒 1 次，连发 4 次约 3 秒）
  panicBurstInterval: 1000 // panic burst 间隔（毫秒，小红花约 1000ms）
};

ipcMain.on('mtc-stop-cfg-push', (event, cfg) => {
  if (!cfg || typeof cfg !== 'object') return;
  try {
    if (typeof cfg.zeroRepeat === 'number' && cfg.zeroRepeat >= 1 && cfg.zeroRepeat <= 1000) {
      globalMtcStopCfg.zeroRepeat = Math.floor(cfg.zeroRepeat);
    }
    if (typeof cfg.sendFF === 'boolean') globalMtcStopCfg.sendFF = cfg.sendFF;
    if (typeof cfg.sendFullMTC === 'boolean') globalMtcStopCfg.sendFullMTC = cfg.sendFullMTC;
    if (typeof cfg.firstFullThenZero === 'boolean') globalMtcStopCfg.firstFullThenZero = cfg.firstFullThenZero;
    if (typeof cfg.sendFullMTCAtEnd === 'boolean') globalMtcStopCfg.sendFullMTCAtEnd = cfg.sendFullMTCAtEnd;
    if (typeof cfg.sendPanicBurst === 'boolean') globalMtcStopCfg.sendPanicBurst = cfg.sendPanicBurst;
    if (typeof cfg.panicBurstCount === 'number' && cfg.panicBurstCount >= 1 && cfg.panicBurstCount <= 20) globalMtcStopCfg.panicBurstCount = Math.floor(cfg.panicBurstCount);
    if (typeof cfg.panicBurstInterval === 'number' && cfg.panicBurstInterval >= 100 && cfg.panicBurstInterval <= 10000) globalMtcStopCfg.panicBurstInterval = Math.floor(cfg.panicBurstInterval);
    log(`MTC停止归零配置更新: zeroRepeat=${globalMtcStopCfg.zeroRepeat} sendFF=${globalMtcStopCfg.sendFF} sendFullMTC=${globalMtcStopCfg.sendFullMTC} firstFullThenZero=${globalMtcStopCfg.firstFullThenZero} sendFullMTCAtEnd=${globalMtcStopCfg.sendFullMTCAtEnd} sendPanicBurst=${globalMtcStopCfg.sendPanicBurst} panicBurstCount=${globalMtcStopCfg.panicBurstCount} panicBurstInterval=${globalMtcStopCfg.panicBurstInterval}`);
  } catch (_) {}
});

// 构造 Full MTC (Universal SysEx, 非实时全帧时间码)
// 字节: F0 7F 7F 01 01 rrHH MM SS FF F7   其中 rrHH 的高 2 位=速率(00=24/01=25/10=30ndf/11=29.97df)，低 5 位=小时(0~23)
function buildFullMTC(hours, minutes, seconds, frames, rateType) {
  const rr = (rateType & 0x03);
  const hByte = ((rr << 5) | (hours & 0x1F)) & 0xFF;
  return [0xF0, 0x7F, 0x7F, 0x01, 0x01, hByte, minutes & 0x7F, seconds & 0x7F, frames & 0x7F, 0xF7];
}
function fpsToRateType(frameRate) {
  if (frameRate <= 24.0001) return 0;
  if (frameRate <= 25.0001) return 1;
  if (frameRate <= 29.9701) return 3;
  return 2;
}

// 发送 CC panic burst（小红花抓包验证）：B0-BF 7B 00 + B0-BF 79 00 全 16 通道
// 作用：All Notes Off + Reset Controllers，强制合成器停止发声
// 每次调用发 32 条 CC 消息（16 通道 × 2 类型），按 panicBurstCount 重复、panicBurstInterval 间隔
function sendPanicBurst(output, cfg) {
  if (!output || !cfg || !cfg.sendPanicBurst) return;
  const count = Math.max(1, Math.min(20, Math.floor(cfg.panicBurstCount || 4)));
  const interval = Math.max(100, Math.min(10000, Math.floor(cfg.panicBurstInterval || 1000)));

  // 立即发第一波
  const sendOneBurst = () => {
    for (let ch = 0; ch < 16; ch++) {
      const status = 0xB0 | ch; // B0-BF
      try { output.sendMessage([status, 0x7B, 0x00]); } catch (_) {} // CC: All Notes Off
      try { output.sendMessage([status, 0x79, 0x00]); } catch (_) {} // CC: Reset Cntrl
    }
  };
  sendOneBurst();

  // 剩余 (count-1) 波用 setInterval 异步发，不阻塞 stop 序列
  if (count > 1) {
    let sent = 1;
    const timer = setInterval(() => {
      try {
        sendOneBurst();
        sent++;
        if (sent >= count) { clearInterval(timer); }
      } catch (_) { clearInterval(timer); }
    }, interval);
    // 端口可能在 timer 未完成时被关闭，sendMessage 会抛错被 catch 吞掉，timer 自然终止
  }
}

  // 监听渲染进程的MTC启动请求
  ipcMain.on('start-mtc', (event, args) => {
    const { outputIndex, frameRate } = args;
    try {
      if (!midi) {
        throw new Error('MIDI模块未加载');
      }

      // 如果已有旧的MTC在运行，先安全关闭端口
      if (mtcState) {
        clearInterval(mtcState.mtcInterval);
        try {
          const out = mtcState.output || mtcState.midiOutput;
          if (out && typeof out.closePort === 'function') out.closePort();
        } catch (_) {}
        mtcState = null;
      }

      const midiOutput = new midi.Output();
      try {
        midiOutput.openPort(outputIndex);
        const deviceName = midiOutput.getPortName(outputIndex);

        // 初始化MTC时间
        let hours = 0;
        let minutes = 0;
        let seconds = 0;
        let frames = 0;

        // 使用渲染进程发送的初始时间
        if (args.initialTime) {
          hours = args.initialTime.hours || 0;
          minutes = args.initialTime.minutes || 0;
          seconds = args.initialTime.seconds || 0;
          frames = args.initialTime.frames || 0;
        }

        // 根据帧率计算发送间隔（毫秒，取整避免浮点精度导致30fps抖动）
        const interval = Math.round(1000 / frameRate);

        // 保存MTC状态（在 tick 开始前创建，这样 tick 内闭包能直接读写最后快照字段）
        //   isStopping: 停止/暂停时立刻置 true，tick 回调入口检测到后直接 return，不再产生任何 F1 xx
        //   tickRunning: 当前 tick 回调是否正在执行（用于 stop 等待这一轮完全退出后再发 Full Frame）
        mtcState = {
          midiOutput,
          output: midiOutput,   // 别名，方便其它代码使用
          mtcInterval: null,
          frameRate: frameRate,
          hours: hours,
          minutes: minutes,
          seconds: seconds,
          frames: frames,
          deviceName: deviceName,
          isStopping: false,
          tickRunning: false
        };

        // 发送MTC时间码
        const mtcInterval = setInterval(() => {
          // ★ 入口屏障：如果正在停止（isStopping=true），或定时器已被取消，直接 return
          //   即使 setInterval 已调度但 clearInterval 还没执行，也不会再发任何 F1 xx
          if (mtcState.isStopping || !mtcState.mtcInterval) return;

          mtcState.tickRunning = true;
          try {
            // 递增时间
            frames++;
            if (frames >= frameRate) {
              frames = 0;
              seconds++;
              if (seconds >= 60) {
                seconds = 0;
                minutes++;
                if (minutes >= 60) {
                  minutes = 0;
                  hours++;
                  if (hours >= 24) {
                    hours = 0;
                  }
                }
              }
            }
            // 同步最新"最后快照"到 mtcState，pause/stop 时立即有准确时间可用
            mtcState.hours = hours;
            mtcState.minutes = minutes;
            mtcState.seconds = seconds;
            mtcState.frames = frames;

            // 发送MTC时间码
            if (midiOutput) {
              sendMTCQuarterFrame(midiOutput, hours, minutes, seconds, frames, frameRate);
            }
          } finally {
            mtcState.tickRunning = false;
          }
        }, interval);

        mtcState.mtcInterval = mtcInterval;

        event.reply('mtc-started', { success: true, deviceName: deviceName });
      } catch (openError) {
        log('MTC设备打开失败:', openError);
        event.reply('mtc-started', { success: false, error: openError.message });
      }
    } catch (error) {
      log('MTC启动失败:', error);
      event.reply('mtc-started', { success: false, error: error.message });
    }
  });

  // 监听渲染进程的MTC暂停请求：
  // 严格顺序（用户要求）：停QF定时器(isStopping+clearInterval) → waitTickExit(确认不再有QF) → 1条Full Frame(当前位置) → Panic Burst
  // 关键：Full Frame 发送之后，绝对不再产生任何 QF（F1 xx）
  ipcMain.on('pause-mtc', async (event) => {
    log('收到MTC暂停请求（严格顺序：isStopping屏障+clearInterval→waitTickExit→FullFrame×1→PanicBurst）');
    try {
      if (mtcState) {
        // =====================================================
        // ★ 第一步：立运行屏障 + 取消定时器调度
        // =====================================================
        // 1) isStopping=true：后续任何 tick 回调（哪怕已被调度）一进入
        //    就会在入口处 return，不再产生任何 F1 xx
        mtcState.isStopping = true;
        // 2) clearInterval：取消 setInterval 未来的调度
        if (mtcState.mtcInterval) clearInterval(mtcState.mtcInterval);
        mtcState.mtcInterval = null;

        // =====================================================
        // ★ 第二步：process.nextTick 自旋等待当前正在运行的 tick 完全退出
        //    （tickRunning=false），并挂 50ms 保底永不死锁
        //    isStopping=true 已经阻止后续任何 tick 发 F1，
        //    正在运行的最后一组 F1 一定会在 waitTickExit 解析之前发完
        //    → Full Frame 之后绝对不会有任何 QF 漏出
        // =====================================================
        await new Promise(resolve => {
          let settled = false;
          let attempts = 0;
          const MAX_ATTEMPTS = 500;
          const done = () => { if (!settled) { settled = true; resolve(); } };
          const check = () => {
            if (settled) return;
            attempts++;
            if (!mtcState || !mtcState.tickRunning || attempts >= MAX_ATTEMPTS) { done(); return; }
            process.nextTick(check);
          };
          process.nextTick(check);
          setTimeout(done, 50);
        });

        const out = mtcState.output || mtcState.midiOutput;

        // =====================================================
        // ★ 第三步：先发送 All Notes Off + Reset Controllers（CC Panic Burst）
        // =====================================================
        try { sendPanicBurst(out, globalMtcStopCfg); } catch (_) {}

        // =====================================================
        // ★ 第四步：最后发送 Quarter Frame 复位序列 00:00:00:00
        // ★ F1 00 10 20 30 40 50 60 76（30fps），之后不再有任何 MIDI 消息
        // =====================================================
        if (out) {
          sendMTCQuarterFrame(out, 0, 0, 0, 0, mtcState.frameRate);
        }

        // mtcState 保留不置 null，便于"继续播放"时 resume 从原时间走
        log(`MTC已暂停（isStopping屏障→clearInterval→waitTickExit→PanicBurst→QF复位(00:00:00:00)×8 —— QF复位是最后一条消息）`);
      }
      event.reply('mtc-stopped', { success: true, mode: 'paused' });
    } catch (error) {
      log('MTC暂停失败:', error);
      event.reply('mtc-stopped', { success: false, error: error.message });
    }
  });

  // 监听渲染进程的MTC停止请求（新增可选 mode 参数）
  //   payload.mode == null / 'legacy' → 旧兼容：直接关闭 interval + 释放端口
  //   payload.mode == 'reset'        → 用户规范停止：
  //        ① isStopping屏障 + clearInterval ② waitTickExit 确认 QF 停干净
  //        ③ 恰好 1 条 Full Frame(当前位置)  ④ 最后 Panic Burst
  //        ★ 严格保证：Full Frame 之后绝对不再产生任何 QF（F1 xx）
  ipcMain.on('stop-mtc', async (event, payload) => {
    const mode = (payload && payload.mode) ? String(payload.mode) : 'legacy';
    log(`收到MTC停止请求 mode=${mode}`);
    let out = null;
    try {
      if (mtcState) {
        // =====================================================
        // ★ 第一步：立即立运行屏障 + 取消 QF 定时器调度
        // =====================================================
        // 1) isStopping=true：tick 回调入口立刻 return，
        //    哪怕已经在事件循环队列中的下一轮 tick 也直接被拦截，不再发 F1
        mtcState.isStopping = true;
        // 2) clearInterval：取消未来调度
        if (mtcState.mtcInterval) clearInterval(mtcState.mtcInterval);
        mtcState.mtcInterval = null;

        const isReset = (mode === 'reset');
        out = mtcState.output || mtcState.midiOutput;

        // =====================================================
        // ★ 第二步：process.nextTick 自旋 + 50ms setTimeout 保底
        //    等待正在运行的 tick 完全退出（tickRunning=false）
        //    isStopping=true 已保证后续任何 tick 不发 F1，
        //    正在运行的最后一组 F1 一定在 waitTickExit resolve 之前发完
        //    → Full Frame 之后绝对不会有任何 QF 漏出
        // =====================================================
        await new Promise(resolve => {
          let settled = false;
          let attempts = 0;
          const MAX_ATTEMPTS = 500;
          const done = () => { if (!settled) { settled = true; resolve(); } };
          const check = () => {
            if (settled) return;
            attempts++;
            if (!mtcState || !mtcState.tickRunning || attempts >= MAX_ATTEMPTS) { done(); return; }
            process.nextTick(check);
          };
          process.nextTick(check);
          setTimeout(done, 50);
        });

        // 用 try-finally 确保：closePort 和 mtcState=null 必执行（即使 await 之后的代码抛错）
        try {
          if (isReset && out) {
            const cfg = Object.assign({}, globalMtcStopCfg);

            // =====================================================
            // ★ 第三步：先发送 All Notes Off + Reset Controllers（CC Panic Burst）
            // =====================================================
            try { sendPanicBurst(out, cfg); } catch (_) {}

            // =====================================================
            // ★ 第四步：最后发送 Quarter Frame 复位序列 00:00:00:00
            // ★ F1 00 10 20 30 40 50 60 76（30fps），之后不再有任何 MIDI 消息
            // =====================================================
            sendMTCQuarterFrame(out, 0, 0, 0, 0, mtcState.frameRate);

            log(`MTC reset 序列完成（严格顺序+并发安全）：isStopping→clearInterval→waitTickExit→PanicBurst(${cfg.sendPanicBurst?'ON':'OFF'} ${cfg.panicBurstCount}x${cfg.panicBurstInterval}ms)→QF复位×8(00:00:00:00) —— QF复位是最后一条消息`);
          }
        } finally {
          // 无论归零序列是否成功，都必须关闭端口 + 清空 mtcState
          try {
            if (out && typeof out.closePort === 'function') {
              out.closePort();
            }
          } catch (closeErr) {
            log('关闭MTC输出端口失败:', closeErr);
          }
          mtcState = null;
          log('MTC已停止（finally块执行，mtcState已清空）');
        }
      } else {
        log('MTC停止：mtcState已为null，无需操作');
      }
      event.reply('mtc-stopped', { success: true, mode });
    } catch (error) {
      log('MTC停止失败:', error);
      // 兜底：即使上面整个 try 失败，也强制清理
      if (mtcState) {
        try { clearInterval(mtcState.mtcInterval); } catch(_) {}
        try { const out = mtcState.output || mtcState.midiOutput; if (out && typeof out.closePort === 'function') out.closePort(); } catch(_) {}
        mtcState = null;
      }
      event.reply('mtc-stopped', { success: false, error: error.message });
    }
  });

  // 监听渲染进程的MTC状态查询
  ipcMain.on('get-mtc-status', (event) => {
    event.reply('mtc-status', { isRunning: !!mtcState });
  });
  
  // 监听渲染进程的MTC接收启动请求
  ipcMain.on('start-mtc-receive', (event, payload) => {
    log('收到MTC接收启动请求:', payload);
    try {
      const result = startMTCReceive(payload || {});
      event.reply('mtc-receive-started', result);
    } catch (error) {
      log('MTC接收启动失败:', error);
      event.reply('mtc-receive-started', { success: false, error: error.message });
    }
  });
  
  // 监听渲染进程的MTC接收停止请求
  ipcMain.on('stop-mtc-receive', (event) => {
    log('收到MTC接收停止请求');
    try {
      stopMTCReceive();
      event.reply('mtc-receive-stopped', { success: true });
    } catch (error) {
      log('MTC接收停止失败:', error);
      event.reply('mtc-receive-stopped', { success: false, error: error.message });
    }
  });
  
  // 监听渲染进程的音频设备枚举请求
  ipcMain.on('enumerate-audio-devices', async (event) => {
    log('收到音频设备枚举请求');
    try {
      const { systemPreferences } = require('electron');
      // 获取麦克风权限
      const micStatus = systemPreferences.getMediaAccessStatus('microphone');
      const cameraStatus = systemPreferences.getMediaAccessStatus('camera');
      event.reply('audio-devices-permission', { microphone: micStatus, camera: cameraStatus });
    } catch (error) {
      log('音频设备权限检查失败:', error);
      event.reply('audio-devices-permission', { microphone: 'not-determined', camera: 'not-determined' });
    }
  });
  
  // 监听渲染进程的远程控制服务器控制请求
  ipcMain.on('remote-control-toggle', (event, enabled) => {
    log('收到远程控制服务器控制请求:', enabled);
    try {
      if (enabled) {
        startRemoteControlServer();
        event.reply('remote-control-status', { success: true, enabled: true });
      } else {
        stopRemoteControlServer();
        event.reply('remote-control-status', { success: true, enabled: false });
      }
    } catch (error) {
      log('远程控制服务器控制失败:', error);
      event.reply('remote-control-status', { success: false, error: error.message });
    }
  });
  
  // 监听渲染进程的远程控制服务器状态请求
  ipcMain.on('remote-control-status', (event) => {
    event.reply('remote-control-status', { success: true, enabled: remoteControlEnabled });
  });
  
  // 监听渲染进程的屏幕信息请求
  ipcMain.on('get-displays', (event) => {
    try {
      const { screen } = require('electron');
      const displays = screen.getAllDisplays();
      event.reply('displays-data', { success: true, displays: displays });
    } catch (error) {
      log('获取显示器信息失败:', error);
      event.reply('displays-data', { success: false, error: error.message });
    }
  });
  
  // 监听渲染进程的文件选择请求
  ipcMain.on('open-file-dialog', (event, options) => {
    try {
      const { dialog } = require('electron');
      dialog.showOpenDialog(mainWindow, options).then((result) => {
        event.reply('file-dialog-result', result);
      }).catch((error) => {
        log('打开文件对话框失败:', error);
        event.reply('file-dialog-result', { canceled: true, error: error.message });
      });
    } catch (error) {
      log('打开文件对话框失败:', error);
      event.reply('file-dialog-result', { canceled: true, error: error.message });
    }
  });
  
  // 监听渲染进程的文件保存请求
  ipcMain.on('save-file-dialog', (event, options) => {
    try {
      const { dialog } = require('electron');
      dialog.showSaveDialog(mainWindow, options).then((result) => {
        event.reply('file-dialog-result', result);
      }).catch((error) => {
        log('保存文件对话框失败:', error);
        event.reply('file-dialog-result', { canceled: true, error: error.message });
      });
    } catch (error) {
      log('保存文件对话框失败:', error);
      event.reply('file-dialog-result', { canceled: true, error: error.message });
    }
  });
  
  // 监听渲染进程的开机自启动设置请求
  ipcMain.on('auto-start-toggle', (event, enabled) => {
    log('收到开机自启动设置请求:', enabled);
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: app.getPath('exe'),
        args: []
      });
      event.reply('auto-start-status', { success: true, enabled: enabled });
    } catch (error) {
      log('设置开机自启动失败:', error);
      event.reply('auto-start-status', { success: false, error: error.message });
    }
  });
  
  // 监听渲染进程的开机自启动状态请求
  ipcMain.on('auto-start-status', (event) => {
    try {
      const settings = app.getLoginItemSettings();
      event.reply('auto-start-status', { success: true, enabled: settings.openAtLogin });
    } catch (error) {
      log('获取开机自启动状态失败:', error);
      event.reply('auto-start-status', { success: false, error: error.message });
    }
  });
  
  // 大屏窗口实例
  let bigScreenWindow = null;
  
  // 监听渲染进程的打开大屏窗口请求
  ipcMain.on('open-big-screen', (event, { displayIndex }) => {
    try {
      const { screen } = require('electron');
      const displays = screen.getAllDisplays();

      let display = displays[0]; // 默认使用第一个显示器
      if (displayIndex >= 0 && displayIndex < displays.length) {
        display = displays[displayIndex];
      } else if (displays.length > 1) {
        // 如果有多个显示器，默认使用第二个（外屏）
        display = displays[1];
      }

      const displayBounds = {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.size.width,
        height: display.size.height
      };

      // ===== 单屏时：只用 1/4 画面（宽高各一半），允许用户操作桌面 =====
      // 当系统只有 1 个显示器，大屏窗口不能占满整个屏幕置顶，否则桌面文件根本点不到
      const isSingleScreen = displays.length === 1;
      let winBounds;
      let frame, alwaysOnTop, skipTaskbar;
      if (isSingleScreen) {
        const w = Math.floor(displayBounds.width / 2);
        const h = Math.floor(displayBounds.height / 2);
        // 放在右下角，左边上边留空间放桌面图标；底部再留 60px 给任务栏
        winBounds = {
          x: displayBounds.x + displayBounds.width - w - 24,
          y: displayBounds.y + displayBounds.height - h - 68,
          width: w,
          height: h
        };
        frame = true;               // 系统标题栏：有关闭、最小化按钮，方便拖走
        alwaysOnTop = false;        // 允许窗口被压到后面，用户点桌面文件
        skipTaskbar = false;        // 留在任务栏，用户随时切回/最小化
      } else {
        // 多屏：原"伪全屏"模式（无边框 + 全屏幕 + 置顶 + 隐藏任务栏），用于外屏独立输出
        winBounds = {
          x: displayBounds.x,
          y: displayBounds.y,
          width: displayBounds.width,
          height: displayBounds.height
        };
        frame = false;
        alwaysOnTop = true;
        skipTaskbar = true;
      }

      bigScreenWindow = new BrowserWindow({
        width: winBounds.width,
        icon: path.join(__dirname, 'logo.ico'),
        height: winBounds.height,
        frame: frame,
        // ⚠ 不用 fullscreen: true —— 全屏窗口在 Win+D 后 minimize 被 preventDefault 会导致渲染合成器挂起 → 白屏
        alwaysOnTop: alwaysOnTop,
        x: winBounds.x,
        y: winBounds.y,
        skipTaskbar: skipTaskbar,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false
        }
      });
      // 显式 setBounds 确保尺寸/坐标完全生效（避免 DPI 缩放导致的尺寸偏差）
      bigScreenWindow.setBounds(winBounds);
      // 多屏模式显式置顶；单屏模式保持非置顶，防止挡住桌面
      if (!isSingleScreen) {
        bigScreenWindow.setAlwaysOnTop(true);
      }

      // 加载大屏内容
      bigScreenWindow.loadFile('big-screen.html');
      bigScreenWindow.webContents.on('did-finish-load', () => {
        try { bigScreenWindow.webContents.send('language-data', cachedMusicState.language || 'zh-CN'); } catch(_) {}
      });

      // 返回桌面(Win+D)时阻止大屏窗口被最小化
      // 注意：仅"多屏+全屏置顶模式"才需要防止被最小化；单屏模式下用户就是想点桌面，不要挡路
      // 用 show + focus + setBounds 替代 restore，避免渲染上下文挂起导致白屏
      bigScreenWindow.on('minimize', (e) => {
        if (isSingleScreen) {
          // 单屏小窗：让用户按 Win+D 正常最小化，不拦截
          return;
        }
        e.preventDefault();
        try {
          bigScreenWindow.show();
          bigScreenWindow.focus();
          bigScreenWindow.setBounds(displayBounds);
          // 通知渲染进程强制恢复渲染（视频/Canvas 等可能因窗口状态变化而挂起）
          if (!bigScreenWindow.isDestroyed()) {
            bigScreenWindow.webContents.send('force-restore-render');
          }
        } catch (_) {}
      });

      // 窗口关闭时的处理
      bigScreenWindow.on('closed', () => {
        bigScreenWindow = null;
        // 通知渲染进程大屏窗口已关闭
        event.reply('big-screen-closed');
      });
    } catch (error) {
      log('打开大屏窗口失败:', error);
    }
  });
  
  // 监听渲染进程的关闭大屏窗口请求
  ipcMain.on('close-big-screen', (event) => {
    try {
      if (bigScreenWindow && !bigScreenWindow.isDestroyed()) {
        // 先取消置顶 + 移出屏幕，让 Windows 重绘副屏桌面，避免黑屏
        try {
          bigScreenWindow.setAlwaysOnTop(false);
          bigScreenWindow.setBounds({ x: -10000, y: -10000, width: 1, height: 1 });
        } catch (_) {}
        bigScreenWindow.destroy();
        bigScreenWindow = null;
      }
    } catch (error) {
      log('关闭大屏窗口失败:', error);
    }
  });
  
  // 监听渲染进程的播放大屏视频请求（旧消息：单视频 → 转发为旧 playVideo 事件，由大屏内部兼容为单 clip program）
  ipcMain.on('play-big-screen-video', (event, { videoPath, loop }) => {
    try {
      if (bigScreenWindow) {
        bigScreenWindow.webContents.send('playVideo', {
          videoPath: videoPath,
          loop: loop
        });
      }
    } catch (error) {
      log('播放大屏视频失败:', error);
    }
  });

  // 监听渲染进程的轨道式大屏播放请求（新消息：多片段 program）
  ipcMain.on('play-big-screen-program', (event, payload) => {
    try {
      if (bigScreenWindow) {
        bigScreenWindow.webContents.send('play-big-screen-program', payload || {});
      }
    } catch (error) {
      log('播放大屏轨道式节目失败:', error);
    }
  });

  // 监听渲染进程的停止大屏视频请求
  ipcMain.on('stop-big-screen-video', (event) => {
    try {
      if (bigScreenWindow) {
        bigScreenWindow.webContents.send('stopVideo');
      }
    } catch (error) {
      log('停止大屏视频失败:', error);
    }
  });

  // 监听渲染进程的停止轨道式大屏节目请求
  ipcMain.on('stop-big-screen-program', (event) => {
    try {
      if (bigScreenWindow) {
        bigScreenWindow.webContents.send('stop-big-screen-program');
      }
    } catch (error) {
      log('停止大屏轨道式节目失败:', error);
    }
  });

  // BS-10：监听渲染进程对轨道式大屏节目的轻量 seek 调整（不重新加载片段）
  ipcMain.on('seek-big-screen-program', (event, payload) => {
    try {
      if (bigScreenWindow) {
        bigScreenWindow.webContents.send('seek-big-screen-program', payload || {});
      }
    } catch (error) {
      log('大屏轨道式节目 seek 失败:', error);
    }
  });
  
  // 监听渲染进程的播放大屏滚动图片请求
  ipcMain.on('play-big-screen-scroll-images', (event, scrollImagesSettings) => {
    try {
      if (bigScreenWindow) {
        bigScreenWindow.webContents.send('playScrollImages', scrollImagesSettings);
      }
    } catch (error) {
      log('播放大屏滚动图片失败:', error);
    }
  });
  
  // 监听渲染进程的停止大屏滚动图片请求
  ipcMain.on('stop-big-screen-scroll-images', (event) => {
    try {
      if (bigScreenWindow) {
        bigScreenWindow.webContents.send('stopScrollImages');
      }
    } catch (error) {
      log('停止大屏滚动图片失败:', error);
    }
  });

  // ===== 音乐下载窗口 =====
  let musicDownloadWindow = null;

  ipcMain.on('open-music-download', (event, themeData) => {
    if (musicDownloadWindow) {
      musicDownloadWindow.focus();
      return;
    }
    const _mdState = loadWindowState('music-download');
    const _mdBounds = (_mdState && _mdState.bounds) ? _mdState.bounds : null;
    musicDownloadWindow = new BrowserWindow({
      width: (_mdBounds && _mdBounds.width) || 900,
      icon: path.join(__dirname, 'logo.ico'),
      height: (_mdBounds && _mdBounds.height) || 650,
      x: (_mdBounds && _mdBounds.x !== undefined) ? _mdBounds.x : undefined,
      y: (_mdBounds && _mdBounds.y !== undefined) ? _mdBounds.y : undefined,
      minWidth: 700,
      minHeight: 500,
      frame: false,
      resizable: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false
      }
    });
    if (_mdState && _mdState.isMaximized) musicDownloadWindow.maximize();
    attachWindowStateSaver('music-download', musicDownloadWindow);
    registerChildWindow(musicDownloadWindow);
    musicDownloadWindow.loadFile('music-download.html');
    musicDownloadWindow.on('closed', () => {
      musicDownloadWindow = null;
    });
    // 传入主题数据
    musicDownloadWindow.webContents.on('did-finish-load', () => {
      if (themeData) {
        musicDownloadWindow.webContents.send('theme-data', themeData);
      }
      // 传入当前语言
      try { musicDownloadWindow.webContents.send('language-data', cachedMusicState.language || 'zh-CN'); } catch(_) {}
    });
  });

  // 关闭下载窗口
  ipcMain.on('close-music-download', (event) => {
    if (musicDownloadWindow) {
      musicDownloadWindow.close();
    }
  });

  // 最小化下载窗口
  ipcMain.on('minimize-music-download', (event) => {
    if (musicDownloadWindow) {
      musicDownloadWindow.minimize();
    }
  });

  // 选择下载目录
  ipcMain.on('select-download-dir', (event) => {
    const { dialog } = require('electron');
    dialog.showOpenDialog(musicDownloadWindow, {
      properties: ['openDirectory']
    }).then(result => {
      if (!result.canceled && result.filePaths.length > 0) {
        event.reply('download-dir-selected', result.filePaths[0]);
      }
    }).catch(err => {
      log('选择目录失败:', err);
    });
  });

  // 下载文件到本地
  ipcMain.on('download-music-file', (event, { url, savePath, songInfo }) => {
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https') ? https : http;

    const file = fs.createWriteStream(savePath);
    const request = client.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // 跟随重定向
        const redirectUrl = response.headers.location;
        const redirectClient = redirectUrl.startsWith('https') ? https : http;
        redirectClient.get(redirectUrl, (res2) => {
          const totalBytes = parseInt(res2.headers['content-length'] || 0);
          let receivedBytes = 0;
          res2.on('data', (chunk) => {
            receivedBytes += chunk.length;
            if (totalBytes > 0) {
              const progress = Math.round((receivedBytes / totalBytes) * 100);
              event.reply('download-progress', { songId: songInfo.id, progress, receivedBytes, totalBytes });
            }
          });
          res2.pipe(file);
          file.on('finish', () => {
            file.close(() => {
              event.reply('download-complete', { songId: songInfo.id, savePath, songInfo });
            });
          });
        }).on('error', (err) => {
          fs.unlink(savePath, () => {});
          event.reply('download-error', { songId: songInfo.id, error: err.message });
        });
        return;
      }
      const totalBytes = parseInt(response.headers['content-length'] || 0);
      let receivedBytes = 0;
      response.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (totalBytes > 0) {
          const progress = Math.round((receivedBytes / totalBytes) * 100);
          event.reply('download-progress', { songId: songInfo.id, progress, receivedBytes, totalBytes });
        }
      });
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          event.reply('download-complete', { songId: songInfo.id, savePath, songInfo });
        });
      });
    });
    request.on('error', (err) => {
      fs.unlink(savePath, () => {});
      event.reply('download-error', { songId: songInfo.id, error: err.message });
    });
  });

  // 获取主窗口的分组列表
  ipcMain.on('get-groups-for-download', (event) => {
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript('JSON.stringify(groups.map((g, i) => ({index: i, name: g.name})))')
        .then(result => {
          event.reply('groups-data', JSON.parse(result));
        })
        .catch(() => {
          event.reply('groups-data', []);
        });
    } else {
      event.reply('groups-data', []);
    }
  });

  // 添加下载的歌曲到分组
  ipcMain.on('add-to-group', (event, { groupIndex, filePath, songName, singer }) => {
    if (mainWindow) {
      // 用 JSON.stringify 安全传递参数，避免歌名/歌手名含特殊字符导致语法错误
      const params = JSON.stringify({ groupIndex, filePath, songName, singer });
      mainWindow.webContents.executeJavaScript(`
        (function() {
          var p = ${params};
          var gi = p.groupIndex;
          if (!groups[gi]) return false;
          var list = groups[gi].musicList;
          var startIndex = list.length;
          var sequence = (startIndex + 1).toString().padStart(2, '0');
          var baseName = p.songName ? (p.singer ? p.singer + ' - ' + p.songName : p.songName) : p.filePath.split(/[/\\\\]/).pop();
          var fileUrl = 'file:///' + p.filePath.replace(/\\\\/g, '/');
          var newMusic = {
            title: sequence + '. ' + baseName,
            duration: '00:00',
            type: 'audio',
            url: fileUrl,
            filePath: fileUrl,
            sequence: sequence
          };
          list.push(newMusic);
          // 仅当添加到当前显示的分组时才更新 UI
          if (currentGroup === gi) {
            var musicGrid = document.querySelector('.music-grid');
            if (musicGrid) {
              musicGrid.classList.remove('empty');
              var fragment = document.createDocumentFragment();
              createMusicCard(newMusic, startIndex, fragment);
              musicGrid.appendChild(fragment);
            }
          }
          saveAppState();
          return true;
        })()
      `).then(success => {
        event.reply('add-to-group-result', { success: !!success });
      }).catch((err) => {
        log('add-to-group 执行失败:', err.message);
        event.reply('add-to-group-result', { success: false });
      });
    } else {
      event.reply('add-to-group-result', { success: false });
    }
  });

  // ===== 音乐剪辑窗口 =====
  let audioClipperWindow = null;
  ipcMain.on('open-audio-clipper', (event, theme) => {
    if (audioClipperWindow && !audioClipperWindow.isDestroyed()) {
      audioClipperWindow.focus();
      return;
    }
    const _acState = loadWindowState('audio-clipper');
    const _acBounds = (_acState && _acState.bounds) ? _acState.bounds : null;
    audioClipperWindow = new BrowserWindow({
      width: (_acBounds && _acBounds.width) || 1220,
      icon: path.join(__dirname, 'logo.ico'),
      height: (_acBounds && _acBounds.height) || 960,
      x: (_acBounds && _acBounds.x !== undefined) ? _acBounds.x : undefined,
      y: (_acBounds && _acBounds.y !== undefined) ? _acBounds.y : undefined,
      minWidth: 750,
      minHeight: 500,
      frame: false,
      resizable: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false
      }
    });
    if (_acState && _acState.isMaximized) audioClipperWindow.maximize();
    attachWindowStateSaver('audio-clipper', audioClipperWindow);
    registerChildWindow(audioClipperWindow);
    audioClipperWindow.loadFile(path.join(__dirname, 'audio-clipper.html'), { query: { theme: theme || 'dark' } });
    audioClipperWindow.setMenuBarVisibility(false);
    audioClipperWindow.webContents.on('did-finish-load', () => {
      try { audioClipperWindow.webContents.send('language-data', cachedMusicState.language || 'zh-CN'); } catch(_) {}
    });
    audioClipperWindow.on('closed', () => { audioClipperWindow = null; });
  });

  // 剪辑窗口控制
  ipcMain.on('clipper-window-control', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === 'close') win.close();
  });

  // 剪辑窗口 - 选择音频文件
  ipcMain.handle('clipper-open-file', async () => {
    const result = await dialog.showOpenDialog(audioClipperWindow, {
      title: '选择音频文件',
      filters: [
        { name: '音频文件', extensions: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  // 剪辑窗口 - 导出文件
  ipcMain.handle('clipper-export-file', async (event, defaultName) => {
    const result = await dialog.showSaveDialog(audioClipperWindow, {
      title: '导出音频',
      defaultPath: defaultName || 'clip',
      filters: [
        { name: 'WAV', extensions: ['wav'] },
        { name: 'MP3', extensions: ['mp3'] }
      ]
    });
    if (result.canceled) return null;
    return result.filePath;
  });

  // 剪辑窗口 - 读取文件为 ArrayBuffer
  ipcMain.handle('clipper-read-file', async (event, filePath) => {
    try {
      const fs = require('fs');
      const buffer = fs.readFileSync(filePath);
      return { success: true, data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 剪辑窗口 - 写入文件
  ipcMain.handle('clipper-write-file', async (event, filePath, data) => {
    try {
      const fs = require('fs');
      const buffer = Buffer.from(data);
      fs.writeFileSync(filePath, buffer);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 剪辑窗口 - 浏览目录
  ipcMain.handle('clipper-browse-dir', async () => {
    const result = await dialog.showOpenDialog(audioClipperWindow, {
      title: '选择保存目录',
      properties: ['openDirectory']
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  // 剪辑窗口 - 音频格式转换（使用 ffmpeg）
  ipcMain.handle('clipper-convert-audio', async (event, { inputPath, outputPath, format, quality }) => {
    try {
      const { execFile } = require('child_process');
      const args = ['-y', '-i', inputPath];

      if (format === 'mp3') {
        args.push('-codec:a', 'libmp3lame', '-b:a', quality.replace('k', '') + 'k');
      } else if (format === 'ogg') {
        args.push('-codec:a', 'libvorbis', '-q:a', quality === '320k' ? '9' : quality === '256k' ? '7' : quality === '192k' ? '5' : quality === '128k' ? '3' : '1');
      } else if (format === 'm4a') {
        args.push('-codec:a', 'aac', '-b:a', quality.replace('k', '') + 'k');
      } else if (format === 'flac') {
        args.push('-codec:a', 'flac', '-compression_level', quality);
      }

      args.push(outputPath);

      return new Promise((resolve) => {
        // 尝试多个 ffmpeg 路径
        const ffmpegPaths = ['ffmpeg', 'ffmpeg.exe', path.join(__dirname, 'ffmpeg', 'ffmpeg.exe')];
        let tried = 0;
        const tryFfmpeg = (idx) => {
          if (idx >= ffmpegPaths.length) {
            resolve({ success: false, error: 'ffmpeg 未找到，仅支持WAV格式导出' });
            return;
          }
          execFile(ffmpegPaths[idx], args, { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
              tried++;
              if (tried < ffmpegPaths.length) tryFfmpeg(tried);
              else resolve({ success: false, error: 'ffmpeg 转换失败: ' + err.message });
            } else {
              resolve({ success: true });
            }
          });
        };
        tryFfmpeg(0);
      });
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 剪辑窗口 - 添加到本地音乐库
  ipcMain.on('clipper-add-to-library', (event, { filePath, name }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('add-clip-to-library', { filePath, name });
    }
  });

  // ===== 多轨编辑器 =====
  let multiTrackEditorProcess = null;

  ipcMain.on('open-multi-track-editor', () => {
    if (multiTrackEditorProcess && !multiTrackEditorProcess.killed) {
      log('多轨编辑器已在运行');
      return;
    }

    const { spawn } = require('child_process');
    const scriptPath = path.join(__dirname, 'audio_editor.py');

    log(`启动多轨编辑器: python "${scriptPath}"`);

    try {
      multiTrackEditorProcess = spawn('python', [scriptPath], {
        cwd: __dirname,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
      });

      multiTrackEditorProcess.stdout.on('data', (data) => {
        log(`[多轨编辑器] ${data.toString().trim()}`);
      });

      multiTrackEditorProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        // 忽略 PyQt6 的 TTY 警告
        if (!msg.includes('TTY') && !msg.includes('tty')) {
          log(`[多轨编辑器 错误] ${msg}`);
        }
      });

      multiTrackEditorProcess.on('error', (err) => {
        log(`启动多轨编辑器失败: ${err.message}`);
        // 通知渲染进程
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('multi-track-editor-error', err.message);
        }
        multiTrackEditorProcess = null;
      });

      multiTrackEditorProcess.on('close', (code) => {
        log(`多轨编辑器已退出，退出码: ${code}`);
        multiTrackEditorProcess = null;
      });
    } catch (err) {
      log(`启动多轨编辑器异常: ${err.message}`);
    }
  });

  // 关闭多轨编辑器
  ipcMain.on('close-multi-track-editor', () => {
    if (multiTrackEditorProcess && !multiTrackEditorProcess.killed) {
      multiTrackEditorProcess.kill();
      multiTrackEditorProcess = null;
      log('多轨编辑器已关闭');
    }
  });

  // ===== ARTNET 触发窗口 =====
  ipcMain.on('open-artnet-window', (event, themeName) => {
    if (artnetWindow && !artnetWindow.isDestroyed()) {
      artnetWindow.focus();
      return;
    }
    const _anState = loadWindowState('artnet');
    const _anBounds = (_anState && _anState.bounds) ? _anState.bounds : null;
    artnetWindow = new BrowserWindow({
      width: (_anBounds && _anBounds.width) || 1180,
      height: (_anBounds && _anBounds.height) || 860,
      x: (_anBounds && _anBounds.x !== undefined) ? _anBounds.x : undefined,
      y: (_anBounds && _anBounds.y !== undefined) ? _anBounds.y : undefined,
      minWidth: 900,
      minHeight: 680,
      frame: false,
      resizable: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false,
      },
    });
    if (_anState && _anState.isMaximized) artnetWindow.maximize();
    attachWindowStateSaver('artnet', artnetWindow);
    registerChildWindow(artnetWindow);
    artnetWindow.loadFile(path.join(__dirname, 'artnet-trigger.html'));
    artnetWindow.setMenuBarVisibility(false);
    artnetWindow.webContents.on('did-finish-load', () => {
      if (typeof themeName === 'string' && themeName) {
        artnetWindow.webContents.send('theme-data', themeName);
      }
      try { artnetWindow.webContents.send('language-data', cachedMusicState.language || 'zh-CN'); } catch(_) {}
    });
    artnetWindow.on('closed', () => { artnetWindow = null; });
  });

  ipcMain.on('artnet-window-control', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === 'close') win.close();
  });

  ipcMain.on('artnet-get-ips', (event) => {
    event.returnValue = getLocalNetworkIPs();
  });

  ipcMain.on('artnet-get-status', (event) => {
    event.returnValue = {
      enabled: artnetState.enabled,
      bindIp: artnetState.bindIp,
      universe: artnetState.universe,
      startAddress: artnetState.startAddress,
      packetCount: artnetState.packetCount,
      lastPacketTime: artnetState.lastPacketTime,
      lastSlice: artnetState.lastSlice || null,
      lastSliceUniverse: artnetState.lastSliceUniverse,
      lastSliceProtocol: artnetState.lastSliceProtocol,
    };
  });

  ipcMain.on('artnet-apply-config', (event, cfg) => {
    if (typeof cfg.bindIp === 'string') artnetState.bindIp = cfg.bindIp;
    if (typeof cfg.universe === 'number') artnetState.universe = Math.max(0, Math.min(255, cfg.universe));
    if (typeof cfg.startAddress === 'number') {
      artnetState.startAddress = Math.max(1, Math.min(502, cfg.startAddress));
    }
    log('[ARTNET] config applied:', JSON.stringify(cfg));
    event.returnValue = { success: true };
  });

  ipcMain.on('artnet-start', (event) => {
    const r = startArtNetServer();
    event.returnValue = r;
  });

  ipcMain.on('artnet-stop', (event) => {
    stopArtNetServer();
    event.returnValue = { success: true };
  });

  // 转发 ARTNET 控制命令给主窗口（由 ARTNET 窗口手动测试按钮触发）
  ipcMain.on('artnet-emit-test', (event, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('artnet-dmx', payload);
    }
    event.returnValue = { success: true };
  });
}

// ===== 连接控台窗口：状态持久化（需求6）=====
function getConsoleStateFilePath() {
  try { return path.join(app.getPath('userData'), 'console-window-state.json'); }
  catch(_) { return path.join(__dirname, 'console-window-state.json'); }
}
function saveConsoleWinState(open) {
  try {
    // 同时保存窗口位置/大小
    let bounds = null;
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      bounds = consoleWindow.getBounds();
    }
    const file = getConsoleStateFilePath();
    fs.writeFileSync(file, JSON.stringify({ open: !!open, bounds, updatedAt: Date.now() }), 'utf-8');
  } catch(_) {}
}
function loadConsoleWinState() {
  try {
    const file = getConsoleStateFilePath();
    if (!fs.existsSync(file)) return { open: false };
    const raw = fs.readFileSync(file, 'utf-8');
    const obj = JSON.parse(raw || '{}');
    return { open: !!obj.open, bounds: obj.bounds || null };
  } catch(_) { return { open: false }; }
}
ipcMain.on('console-window-state-get', (event) => {
  event.returnValue = loadConsoleWinState();
});
ipcMain.on('console-window-state-set', (event, open) => {
  saveConsoleWinState(!!open);
  event.returnValue = true;
});

// ===== T2: 通用窗口位置/大小记忆（主窗口、电柜窗口、悬浮窗）=====
function getWindowStateFilePath(name) {
  try { return path.join(app.getPath('userData'), 'window-state-' + name + '.json'); }
  catch(_) { return path.join(__dirname, 'window-state-' + name + '.json'); }
}
function saveWindowState(name, win) {
  try {
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const isMaximized = win.isMaximized();
    fs.writeFileSync(getWindowStateFilePath(name), JSON.stringify({ bounds, isMaximized, updatedAt: Date.now() }), 'utf-8');
  } catch(_) {}
}
function loadWindowState(name) {
  try {
    const file = getWindowStateFilePath(name);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    const obj = JSON.parse(raw || '{}');
    return { bounds: obj.bounds || null, isMaximized: !!obj.isMaximized };
  } catch(_) { return null; }
}
// 统一为窗口绑定 resize/move/maximize 事件实时保存状态（200ms 防抖）
function attachWindowStateSaver(name, win) {
  if (!win) return;
  let debounceTimer = null;
  const save = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try { saveWindowState(name, win); } catch(_) {}
    }, 200);
  };
  win.on('resize', save);
  win.on('move', save);
  win.on('maximize', save);
  win.on('unmaximize', save);
}
// 将窗口注册到子窗口表（主窗口关闭时联动关闭）
function registerChildWindow(win) {
  if (!win) return win;
  childWindows.add(win);
  win.on('closed', () => { childWindows.delete(win); });
  return win;
}

// ===== 连接控台窗口 =====
ipcMain.on('open-console-window', (event, themeName) => {
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    consoleWindow.focus();
    saveConsoleWinState(true); // 聚焦同样视为打开
    return;
  }
  // T2: 恢复控台窗口上次位置和大小
  // 优先从 window-state-console.json 读取（resize/move 实时保存的），
  // 回退到 console-window-state.json（旧数据）
  const _cslWinState = loadWindowState('console');
  const _cslState = loadConsoleWinState();
  const _cslBounds = (_cslWinState && _cslWinState.bounds) ? _cslWinState.bounds
                   : (_cslState && _cslState.bounds) ? _cslState.bounds : null;
  consoleWindow = new BrowserWindow({
      width: (_cslBounds && _cslBounds.width) || 860,
      icon: path.join(__dirname, 'logo.ico'),
      height: (_cslBounds && _cslBounds.height) || 640,
      x: (_cslBounds && _cslBounds.x !== undefined) ? _cslBounds.x : undefined,
      y: (_cslBounds && _cslBounds.y !== undefined) ? _cslBounds.y : undefined,
      minWidth: 520,
      minHeight: 480,
      frame: false,
      resizable: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false,
      },
    });
    // 恢复最大化状态
    if (_cslWinState && _cslWinState.isMaximized) {
      try { consoleWindow.maximize(); } catch(_) {}
    }
    attachWindowStateSaver('console', consoleWindow);
    registerChildWindow(consoleWindow);
    saveConsoleWinState(true); // 打开成功 → 记忆"打开"状态（需求6）
  consoleWindow.loadFile(path.join(__dirname, 'console-connect.html'));
  consoleWindow.setMenuBarVisibility(false);
  // 捕获渲染进程 console 输出（排错用）
  consoleWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const lvl = ['LOG','WARN','ERROR'][level] || ('L'+level);
    console.log('[ConsoleWindow]', lvl, message, '('+sourceId+':'+line+')');
  });
  // 捕获渲染进程崩溃
  consoleWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[ConsoleWindow] render-process-gone:', details && details.reason, details);
  });
  consoleWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[ConsoleWindow] did-fail-load:', errorCode, errorDescription);
  });
  consoleWindow.webContents.on('did-finish-load', () => {
    if (typeof themeName === 'string' && themeName) {
      consoleWindow.webContents.send('theme-data', themeName);
    }
    try { consoleWindow.webContents.send('language-data', cachedMusicState.language || 'zh-CN'); } catch(_) {}
    // 恢复暂存的控台功能数据（控台窗口未打开时主窗口加载项目时缓存的）
    if (pendingConsoleFeatures) {
      try {
        consoleWindow.webContents.send('console-restore-features', pendingConsoleFeatures);
      } catch(_) {}
      pendingConsoleFeatures = null;
    }
    // 排错：检查渲染进程函数是否都挂到了 window
    consoleWindow.webContents.executeJavaScript(
      "JSON.stringify({ doConnect: typeof doConnect, doDisconnect: typeof doDisconnect, doQueryPlaylists: typeof doQueryPlaylists, doForceReloginAndQuery: typeof doForceReloginAndQuery, openShortcutModal: typeof openShortcutModal, sendCtrl: typeof sendCtrl, setConnState: typeof setConnState, renderPlaylists: typeof renderPlaylists, ipcRenderer: typeof ipcRenderer, net: typeof net, Buffer: typeof Buffer })"
    ).then(result => {
      console.log('[ConsoleWindow] function check after did-finish-load:', result);
    }).catch(err => {
      console.error('[ConsoleWindow] function check failed:', err && err.message);
    });
  });
  // 关闭/隐藏 → 记忆"关闭"状态（需求6：无论手动关还是主窗口关，都记状态）
  consoleWindow.on('close', () => { saveWindowState('console', consoleWindow); saveConsoleWinState(false); });
  consoleWindow.on('closed', () => {
    saveConsoleWinState(false);
    consoleWindow = null;
    unregisterAllConsoleShortcuts();
  });
});

// 控台窗口控制（最小化/最大化/关闭）
ipcMain.on('console-window-control', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (action === 'minimize') { try { win.minimize(); } catch(_) {} }
  else if (action === 'maximize') {
    try {
      if (win.isMaximized()) win.unmaximize(); else win.maximize();
    } catch(_) {}
  }
  else if (action === 'close') {
    // 关闭失败兜底：渲染进程如果在同步IPC/连接中卡死，win.close() 可能不会立即返回；
    // 先正常 close，500ms 还没销毁就强制 destroy，确保用户关得掉
    try {
      const wid = win.id;
      win.close();
      setTimeout(() => {
        try {
          const w = BrowserWindow.fromId(wid);
          if (w && !w.isDestroyed()) w.destroy();
        } catch(_) {}
      }, 500);
    } catch(_) {
      try { win.destroy(); } catch(_) {}
    }
  }
});

// ========== 电柜管理窗口（cabinet-manager.html，与主界面完全隔离） ==========
let cabinetWindowStateDisabled = false; // ARTNET协议时禁用窗口记忆
let cabinetWindowStateSaverAttached = false; // 窗口状态监听器是否已挂载

function detachCabinetWindowStateSaver() {
  if (!cabinetWindow || cabinetWindow.isDestroyed()) return;
  try {
    // 移除resize/move/maximize/unmaximize上的所有监听器（只移除我们自己挂的不太好区分，这里直接全量处理）
    cabinetWindow.removeAllListeners('resize');
    cabinetWindow.removeAllListeners('move');
    cabinetWindow.removeAllListeners('maximize');
    cabinetWindow.removeAllListeners('unmaximize');
    // close事件上可能还挂了saveWindowState，单独处理
  } catch (_) {}
  cabinetWindowStateSaverAttached = false;
}

ipcMain.on('open-cabinet-window', (event, themeData) => {
  if (cabinetWindow && !cabinetWindow.isDestroyed()) {
    cabinetWindow.focus();
    return;
  }
  cabinetWindowStateDisabled = false; // 每次打开先重置，等渲染进程告知是否需要禁用
  // T2: 恢复电柜窗口上次位置和大小（若后续被ARTNET禁用则会在渲染进程加载后重置为默认居中）
  const _cabState = loadWindowState('cabinet');
  const _cabBounds = (_cabState && _cabState.bounds) ? _cabState.bounds : null;
  cabinetWindow = new BrowserWindow({
    width: (_cabBounds && _cabBounds.width) || 960,
    height: (_cabBounds && _cabBounds.height) || 640,
    x: (_cabBounds && _cabBounds.x !== undefined) ? _cabBounds.x : undefined,
    y: (_cabBounds && _cabBounds.y !== undefined) ? _cabBounds.y : undefined,
    minWidth: 720,
    minHeight: 480,
    resizable: true,
    center: (!_cabBounds),
    title: '电柜管理',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'logo.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      webSecurity: false,
    },
  });
  attachWindowStateSaver('cabinet', cabinetWindow);
  cabinetWindowStateSaverAttached = true;
  registerChildWindow(cabinetWindow);
  cabinetWindow.setMenuBarVisibility(false);
  cabinetWindow.loadFile(path.join(__dirname, 'cabinet-manager.html'));
  // 窗口加载完成 → 立即同步当前主题（主界面的主题）
  cabinetWindow.webContents.on('did-finish-load', () => {
    try {
      // 广播 cabinetThemeSync：带 theme + themeColor（若外部没传则从内存/默认来）
      const td = (themeData && typeof themeData === 'object') ? themeData
        : { theme: currentThemeName || 'dark', themeColor: currentThemeColor || '#ff6b6b' };
      cabinetWindow.webContents.send('cabinet-theme-sync', td);
    } catch (_) {}
    try { cabinetWindow.webContents.send('language-data', cachedMusicState.language || 'zh-CN'); } catch(_) {}
    // 同时让渲染进程知道 socket 是否已就绪（没就绪也不影响发送逻辑，会走错误提示）
    try {
      ensureCabinetSockets();
    } catch (_) {}
  });
  // T2: 电柜窗口关闭时保存位置和大小（仅在未被ARTNET禁用时）
  cabinetWindow.on('close', () => {
    if (!cabinetWindowStateDisabled) {
      saveWindowState('cabinet', cabinetWindow);
    }
  });
  cabinetWindow.on('closed', () => {
    cabinetWindow = null;
    cabinetWindowStateSaverAttached = false;
  });
});

// 渲染进程告知：是否禁用窗口状态记忆（ARTNET协议电柜时传 true）
ipcMain.on('cabinet:set-window-state-disabled', (event, disabled) => {
  cabinetWindowStateDisabled = !!disabled;
  if (!cabinetWindow || cabinetWindow.isDestroyed()) return;
  if (cabinetWindowStateDisabled) {
    // 立即卸载状态保存监听器
    if (cabinetWindowStateSaverAttached) {
      detachCabinetWindowStateSaver();
    }
    // 删除已保存的状态文件，下次打开用默认尺寸居中
    try {
      const f = getWindowStateFilePath('cabinet');
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) {}
    // 重置窗口到默认尺寸 + 居中
    try {
      const { workAreaSize } = require('electron').screen.getPrimaryDisplay();
      const W = 960, H = 640;
      const x = Math.max(0, Math.floor((workAreaSize.width - W) / 2));
      const y = Math.max(0, Math.floor((workAreaSize.height - H) / 2));
      if (cabinetWindow.isMaximized()) cabinetWindow.unmaximize();
      cabinetWindow.setBounds({ x, y, width: W, height: H });
    } catch (_) {}
  } else {
    // 重新挂载（一般不会走到，ARTNET禁用后不会再恢复）
    if (!cabinetWindowStateSaverAttached) {
      attachWindowStateSaver('cabinet', cabinetWindow);
      cabinetWindowStateSaverAttached = true;
    }
  }
});

// 电柜窗口控制（最小化/最大化/关闭）—— 与控台保持一致的 500ms 兜底 destroy
ipcMain.on('cabinet-window-control', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (action === 'minimize') { try { win.minimize(); } catch(_) {} }
  else if (action === 'maximize') {
    try {
      if (win.isMaximized()) win.unmaximize(); else win.maximize();
    } catch(_) {}
  }
  else if (action === 'close') {
    try {
      const wid = win.id;
      win.close();
      setTimeout(() => {
        try {
          const w = BrowserWindow.fromId(wid);
          if (w && !w.isDestroyed()) w.destroy();
        } catch(_) {}
      }, 500);
    } catch(_) {
      try { win.destroy(); } catch(_) {}
    }
  }
});

// 主界面切换主题 → 同步给电柜窗口（如存在）
ipcMain.on('main-to-cabinet-theme-sync', (event, payload) => {
  if (cabinetWindow && !cabinetWindow.isDestroyed()) {
    try { cabinetWindow.webContents.send('cabinet-theme-sync', payload || {}); } catch(_) {}
  }
});

// 主界面 applyTheme 时广播：更新主进程缓存 + 同步给所有子窗口（电柜/悬浮/控台）
ipcMain.on('main-theme-update', (event, payload) => {
  try {
    if (payload && typeof payload === 'object') {
      if (typeof payload.theme === 'string' && payload.theme) currentThemeName = payload.theme;
      if (typeof payload.themeColor === 'string' && payload.themeColor) currentThemeColor = payload.themeColor;
    }
    // 广播给电柜窗口
    if (cabinetWindow && !cabinetWindow.isDestroyed()) {
      try { cabinetWindow.webContents.send('cabinet-theme-sync', { theme: currentThemeName, themeColor: currentThemeColor }); } catch(_) {}
    }
    // 控台窗口沿用原 theme-data 通道
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      try { consoleWindow.webContents.send('theme-data', currentThemeName); } catch(_) {}
    }
  } catch (_) {}
});

// ========== 控台内容全局快捷键 ==========
let consoleRegisteredShortcuts = []; // 已注册的控台快捷键（electron格式字符串）
// 记录每个快捷键绑定的内容信息 { listId, playId, action:'play'|'stop'|'toggle' }
let consoleShortcutBindings = {}; // key: 原始快捷键字符串如 "Ctrl+A"
let consoleShortcutEnabled = false; // 控台快捷键总开关

// 控台快捷键开关：开→通知控台重新注册，关→注销全部
ipcMain.on('console-shortcut-toggle', (event, enabled) => {
  consoleShortcutEnabled = !!enabled;
  if (!consoleShortcutEnabled) {
    unregisterAllConsoleShortcuts();
    console.log('[ConsoleShortcut] 已关闭，注销全部控台快捷键');
  } else {
    console.log('[ConsoleShortcut] 已开启，通知控台重新注册');
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      consoleWindow.webContents.send('console-shortcut-reregister');
    }
  }
});

// AI触发配置：从控台窗口转发给主窗口
ipcMain.on('ai-trigger-config', (event, config) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ai-trigger-config', config);
  }
});

ipcMain.on('console-shortcut-get-state', (event) => {
  event.returnValue = consoleShortcutEnabled;
});

function unregisterAllConsoleShortcuts() {
  consoleRegisteredShortcuts.forEach(sc => {
    try { globalShortcut.unregister(sc); } catch (_) {}
  });
  consoleRegisteredShortcuts = [];
  consoleShortcutBindings = {};
}

// 注册控台快捷键
// shortcutsData: [{ playId, playName, listId, listName, shortcut, action }]
// 返回：
//   conflicts:           全部冲突（主界面冲突+控制台内部重复+注册失败）
//   mainConflicts:       与主界面快捷键冲突的部分（优先保留主界面，禁止注册）
//   duplicateConflicts:  控制台内部重复的快捷键
//   systemConflicts:     系统/其他程序占用失败
//   failed:              格式等无法处理的失败
ipcMain.on('console-shortcut-register', (event, shortcutsData) => {
  unregisterAllConsoleShortcuts();
  const conflicts = [];
  const mainConflicts = []; // 需求2保留（不再使用，但向后兼容旧判断）
  const mainWarnings = []; // 需求2：与主界面重复但仍允许保存的快捷键字符串数组
  const mainWarningsDetail = []; // 对应详情 [{ sc, with: {module,displayName,groupIndex,musicIndex} }, ...]
  const duplicateConflicts = [];
  const systemConflicts = [];
  const failed = [];
  const push = (arr, sc) => { if (sc && !arr.includes(sc)) arr.push(sc); if (sc && !conflicts.includes(sc)) conflicts.push(sc); };
  const pushObj = (arr, obj) => {
    if (!obj || !obj.sc) return;
    for (let i = 0; i < arr.length; i++) { if (arr[i].sc === obj.sc) return; }
    arr.push(obj);
  };

  if (!Array.isArray(shortcutsData)) {
    event.returnValue = { conflicts, mainConflicts, mainWarnings, mainWarningsDetail, duplicateConflicts, systemConflicts, failed };
    return;
  }

  // Fix2: 全局快捷键开关关闭时，不注册任何全局快捷键（仅保存配置），避免影响其他软件
  if (!consoleShortcutEnabled) {
    event.returnValue = { conflicts, mainConflicts, mainWarnings, mainWarningsDetail, duplicateConflicts, systemConflicts, failed };
    return;
  }

  // 第一步：检查控台内部冲突（重复快捷键）
  const seenInner = new Map(); // shortcut -> playId
  shortcutsData.forEach(item => {
    const sc = (item.shortcut || '').trim();
    if (!sc) return;
    if (seenInner.has(sc)) {
      push(duplicateConflicts, sc); // 重复
    } else {
      seenInner.set(sc, item.playId);
    }
  });
  // 第二步：注册
  shortcutsData.forEach(item => {
    const sc = (item.shortcut || '').trim();
    if (!sc) return;
    if (duplicateConflicts.includes(sc)) return; // 内部重复先跳过
    const electronSc = shortcutToElectronFormat(sc);
    if (!electronSc) { if (!failed.includes(sc)) failed.push(sc); return; }

    // Fix1: 与主界面快捷键同名 → 只记 warning，不尝试 register（否则 register 必然失败，会被误判为"系统占用"）
    const mainReg = findRegisteredShortcut(electronSc);
    if (mainReg) {
      push(mainWarnings, sc);
      pushObj(mainWarningsDetail, { sc: sc, with: {
        module: mainReg.module, displayName: mainReg.displayName,
        groupIndex: mainReg.groupIndex, musicIndex: mainReg.musicIndex
      }});
      // 配置保留（控台侧照样存 localStorage），但不调用 globalShortcut.register
      // 主界面已注册了该快捷键，控台侧不会生效，用户通过 warning 提示知晓
      return; // ← Fix1: 直接跳过，不再往下尝试 register
    }

    // 已被其他控制台项注册（本批已注册成功过的）
    if (consoleRegisteredShortcuts.includes(electronSc)) {
      push(duplicateConflicts, sc);
      return;
    }
    try {
      const ok = globalShortcut.register(electronSc, () => {
        const bind = consoleShortcutBindings[sc];
        if (!bind) return;
        if (consoleWindow && !consoleWindow.isDestroyed()) {
          consoleWindow.webContents.send('console-shortcut-triggered', bind);
        }
      });
      if (ok) {
        consoleRegisteredShortcuts.push(electronSc);
        consoleShortcutBindings[sc] = {
          listId: item.listId, playId: item.playId,
          playName: item.playName, listName: item.listName,
          action: item.action || 'toggle'
        };
      } else {
        push(systemConflicts, sc); // 真正的系统占用
      }
    } catch(err) {
      if (!failed.includes(sc)) failed.push(sc);
    }
  });
  event.returnValue = { conflicts, mainConflicts, mainWarnings, mainWarningsDetail, duplicateConflicts, systemConflicts, failed };
});

// 快捷键冲突检测：区分来源：主界面(registeredShortcuts) / 控台(consoleRegisteredShortcuts) / 系统
// 需求2：与主界面重复仍然允许保存（available=true），但返回 warning + duplicatedWith，提示用户「主界面优先触发」
// 返回 { available, reason, source, warning: boolean, duplicatedWith?: { module, groupIndex, musicIndex, displayName } }
function checkShortcutConflictAsync(shortcutString) {
  const sc = (shortcutString || '').trim();
  if (!sc) return Promise.resolve({ available: true });
  const electronSc = shortcutToElectronFormat(sc);
  if (!electronSc) return Promise.resolve({ available: false, reason: 'invalid', source: null });
  // 主界面匹配：允许同名（available=true），但给 warning + duplicatedWith 详细描述（实际仍然是主界面先抢注册，控台触发不到）
  const mainReg = findRegisteredShortcut(electronSc);
  if (mainReg) {
    return Promise.resolve({
      available: true, // 需求2：仍然允许在控台保存
      warning: true,
      reason: 'duplicated-main',
      source: 'main',
      duplicatedWith: {
        module: mainReg.module,
        groupIndex: mainReg.groupIndex,
        musicIndex: mainReg.musicIndex,
        displayName: mainReg.displayName
      }
    });
  }
  // 控台内部已注册：禁止
  if (consoleRegisteredShortcuts.includes(electronSc)) {
    return Promise.resolve({ available: false, reason: 'occupied', source: 'console', warning: false });
  }
  // 系统占用：禁止
  return new Promise((resolve) => {
    setImmediate(() => {
      let occupied = false;
      try {
        const ok = globalShortcut.register(electronSc, () => {});
        if (!ok) occupied = true;
        else globalShortcut.unregister(electronSc);
      } catch(_) { occupied = true; }
      resolve({ available: !occupied, reason: occupied ? 'system' : null, source: occupied ? 'system' : null, warning: false });
    });
  });
}
// 兼容旧同步调用（老版本渲染进程 sendSync 仍可用）
ipcMain.on('console-shortcut-check', (event, shortcutString) => {
  const sc = (shortcutString || '').trim();
  if (!sc) { event.returnValue = { available: true, source: null }; return; }
  const electronSc = shortcutToElectronFormat(sc);
  if (!electronSc) { event.returnValue = { available: false, reason: 'invalid', source: null }; return; }
  const mainReg = findRegisteredShortcut(electronSc);
  if (mainReg) {
    event.returnValue = {
      available: true,
      warning: true,
      reason: 'duplicated-main',
      source: 'main',
      duplicatedWith: {
        module: mainReg.module,
        groupIndex: mainReg.groupIndex,
        musicIndex: mainReg.musicIndex,
        displayName: mainReg.displayName
      }
    };
    return;
  }
  if (consoleRegisteredShortcuts.includes(electronSc)) { event.returnValue = { available: false, reason: 'occupied', source: 'console' }; return; }
  let occupied = false;
  try {
    const ok = globalShortcut.register(electronSc, () => {});
    if (!ok) occupied = true;
    else globalShortcut.unregister(electronSc);
  } catch(_) { occupied = true; }
  event.returnValue = { available: !occupied, reason: occupied ? 'system' : null, source: occupied ? 'system' : null };
});
// 异步版本：渲染进程使用 ipcRenderer.invoke，完全不阻塞
if (ipcMain.handle) {
  ipcMain.handle('console-shortcut-check-async', (event, shortcutString) => {
    return checkShortcutConflictAsync(shortcutString);
  });

  // 需求3：控台窗口请求主界面音乐列表 → 路由到主窗口 → 主窗口回包后 resolve
  let pendingMusicListResolver = null;
  let pendingMusicListTimer = null;
  ipcMain.handle('console-request-music-list', (event) => {
    return new Promise((resolve) => {
      const finish = (list) => {
        if (pendingMusicListTimer) { clearTimeout(pendingMusicListTimer); pendingMusicListTimer = null; }
        pendingMusicListResolver = null;
        resolve(list || []);
      };
      try {
        if (!mainWindow || mainWindow.isDestroyed()) return finish([]);
        pendingMusicListResolver = finish;
        pendingMusicListTimer = setTimeout(() => finish([]), 1500);
        try { mainWindow.webContents.send('console-ask-music-list'); } catch(_) { finish([]); }
      } catch(_) { finish([]); }
    });
  });
  // 主窗口回包：音乐列表
  ipcMain.on('console-return-music-list', (event, list) => {
    try {
      if (pendingMusicListResolver) {
        pendingMusicListResolver(Array.isArray(list) ? list : []);
      }
    } catch(_) {}
  });
}

// 需求3：控台侧触发绑定音乐 → 转发给主界面去播放
ipcMain.on('console-play-music', (event, payload) => {
  try {
    if (!payload) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // payload: { groupIndex, musicIndex, origin: 'console' }
    const out = Object.assign({}, payload, { origin: 'console' });
    try { mainWindow.webContents.send('trigger-music-play', out); } catch(_) {}
  } catch(_) {}
});

// 需求3：主界面侧触发播放音乐 → 转发给控台窗口去播放对应绑定按钮
ipcMain.on('main-play-music-bind-sync', (event, payload) => {
  try {
    if (!payload) return;
    const out = Object.assign({}, payload, { origin: 'main' });
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      try { consoleWindow.webContents.send('sync-play-from-main', out); } catch(_) {}
    }
  } catch(_) {}
});

// 发送MTC四分之一帧
function sendMTCQuarterFrame(output, hours, minutes, seconds, frames, frameRate) {
  // 检查output是否为null
  if (!output) {
    console.error('MIDI输出设备为null');
    return;
  }
  
  try {
    // 计算MTC时间码
    const mtcHours = hours & 0x1F;
    const mtcMinutes = minutes & 0x3F;
    const mtcSeconds = seconds & 0x3F;
    const mtcFrames = frames & 0x1F;
    
    // 经 MIDIOX 抓包小红花验证（24/25/30fps 三测全过）：
    //   piece#1 low nibble：bit0=frame高位，bit1-3 始终为 0（小红花不在 piece1 编码 rate）
    //   piece#7 low nibble：bit1-2 = rate 编码（24=00, 25=01, 29.97=10, 30=11，左移1位到 bit1-2）
    //     24fps   实测 piece7 = 0x70（149/149 次，无 bits）
    //     25fps   实测 piece7 = 0x72（190/190 次，bit1）
    //     29.97fps 推断 piece7 = 0x74（bit2，按 rate=10 编码）
    //     30fps   实测 piece7 = 0x76（bit1+bit2）
    const rateType = (frameRate === 24) ? 0
                   : (frameRate === 25) ? 1
                   : (frameRate === 29.97) ? 2
                   : (frameRate === 30) ? 3 : 0;
    const piece7RateBits = (rateType << 1) & 0x06; // rate 左移1位到 bit1-2

    // 准备所有MTC消息（与小红花抓包一致）
    const messages = [
      // 第一帧：帧的低4位
      [0xF1, 0x00 | (mtcFrames & 0x0F)],
      // 第二帧：帧的高位（bit0），无 rate bits
      [0xF1, 0x10 | ((mtcFrames >> 4) & 0x01)],
      // 第三帧：秒的低4位
      [0xF1, 0x20 | (mtcSeconds & 0x0F)],
      // 第四帧：秒的高2位
      [0xF1, 0x30 | ((mtcSeconds >> 4) & 0x03)],
      // 第五帧：分的低4位
      [0xF1, 0x40 | (mtcMinutes & 0x0F)],
      // 第六帧：分的高2位
      [0xF1, 0x50 | ((mtcMinutes >> 4) & 0x03)],
      // 第七帧：时的低4位
      [0xF1, 0x60 | (mtcHours & 0x0F)],
      // 第八帧：时的高位 + rate 编码（bit1-2）
      [0xF1, 0x70 | ((mtcHours >> 4) & 0x01) | piece7RateBits]
    ];
    
    // 直接连续发送所有消息，不使用setTimeout
    // 这更接近P1和其他专业MIDI设备的发送方式
    messages.forEach((message, index) => {
      try {
        output.sendMessage(message);
      } catch (sendError) {
        console.error('发送MIDI消息失败:', sendError);
      }
    });
  } catch (error) {
    console.error('发送MTC消息失败:', error);
  }
}

// MTC时间码解析器
class MTCReceiver {
  constructor() {
    this.mtcData = new Array(8).fill(0);
    this.lastFrame = -1;
    this.offset = 0; // 时间偏移（秒）
    this.frameRate = 30; // 默认帧率
    this.lastTime = null; // 上一次解析的时间
  }
  
  // 设置时间偏移
  setOffset(seconds) {
    this.offset = seconds;
  }
  
  // 设置帧率
  setFrameRate(rate) {
    this.frameRate = rate;
  }
  
  // 处理MTC四分之一帧消息
  processMessage(data) {
    try {
      // 确保data是一个数组或类数组对象
      let messageArray;
      if (Array.isArray(data)) {
        messageArray = data;
      } else if (data && typeof data === 'object' && 'length' in data) {
        // 处理Uint8Array或其他类数组对象
        messageArray = Array.from(data);
      } else {
        return null;
      }
      
      if (messageArray.length < 2) {
        return null;
      }
      
      // 检查是否为标准MTC消息（类型0xF1）
      if (messageArray[0] === 0xF1) {
        const quarterFrame = messageArray[1];
        const type = (quarterFrame >> 4) & 0x07;
        const value = quarterFrame & 0x0F;
        
        // 存储数据
        this.mtcData[type] = value;
        
        // 当收到第八个四分之一帧时，计算完整时间
        if (type === 7) {
          const time = this.calculateTime();
          // 只在时间变化时发送更新，避免重复发送
          if (!this.lastTime || 
              time.hours !== this.lastTime.hours || 
              time.minutes !== this.lastTime.minutes || 
              time.seconds !== this.lastTime.seconds || 
              time.frames !== this.lastTime.frames) {
            this.lastTime = time;
            return time;
          }
        }
      } else if (messageArray.length === 3) {
        // 处理小红花音效发送的特殊MIDI消息
        // 从96:00:00:00开始的时间码
        let hours = 96;
        let minutes = 0;
        let seconds = 0;
        let frames = 0;
        
        // 简单的时间递增逻辑，每收到一个消息增加一帧
        if (this.lastTime) {
          frames = this.lastTime.frames + 1;
          if (frames >= this.frameRate) {
            frames = 0;
            seconds = this.lastTime.seconds + 1;
            if (seconds >= 60) {
              seconds = 0;
              minutes = this.lastTime.minutes + 1;
              if (minutes >= 60) {
                minutes = 0;
                hours = this.lastTime.hours + 1;
              }
            }
          } else {
            seconds = this.lastTime.seconds;
            minutes = this.lastTime.minutes;
            hours = this.lastTime.hours;
          }
        }
        
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        
        const mockTime = {
          hours: hours,
          minutes: minutes,
          seconds: seconds,
          frames: frames,
          totalSeconds: totalSeconds
        };
        return mockTime;
      }
    } catch (error) {
      // 静默处理错误
    }
    
    return null;
  }
  
  // 计算完整的MTC时间
  calculateTime() {
    // 正确处理帧数据，掩码掉帧率信息
    const frames = ((this.mtcData[1] & 0x03) << 4) | this.mtcData[0];
    const seconds = (this.mtcData[3] << 4) | this.mtcData[2];
    const minutes = (this.mtcData[5] << 4) | this.mtcData[4];
    // 正确处理小时数据，掩码掉SMPTE类型信息
    const hours = ((this.mtcData[7] & 0x01) << 4) | this.mtcData[6];

    // 从 piece#1 low nibble bit3-bit2 反查实际帧率（标准 SMPTE rate bits）
    const rateRR = (this.mtcData[1] >> 2) & 0x03;
    // 24=00, 25=01, 30ndf=10, 29.97df=11
    let frameRate = 30;
    let frameRateName = '30Hz';
    switch (rateRR) {
      case 0: frameRate = 24;    frameRateName = '24Hz';    break;
      case 1: frameRate = 25;    frameRateName = '25Hz';    break;
      case 2: frameRate = 30;    frameRateName = '30Hz';    break;
      case 3: frameRate = 29.97; frameRateName = '29.97dfHz'; break;
    }

    // 应用时间偏移
    let totalSeconds = hours * 3600 + minutes * 60 + seconds + this.offset;
    if (totalSeconds < 0) totalSeconds = 0;

    // 转换回时:分:秒:帧格式
    const offsetHours = Math.floor(totalSeconds / 3600);
    const offsetMinutes = Math.floor((totalSeconds % 3600) / 60);
    const offsetSeconds = Math.floor(totalSeconds % 60);

    const result = {
      hours: offsetHours,
      minutes: offsetMinutes,
      seconds: offsetSeconds,
      frames: frames,
      totalSeconds: totalSeconds,
      frameRate: frameRate,
      frameRateName: frameRateName
    };

    return result;
  }
}

// 启动MTC接收
function startMTCReceive({ inputIndex, inputName, offset }) {
  if (!midi) {
    throw new Error('MIDI模块未加载');
  }

  const midiInput = new midi.Input();
  const mtcReceiver = new MTCReceiver();

  if (offset) {
    mtcReceiver.setOffset(offset);
  }

  // 设置帧率为30Hz，与小红花音效发送的帧率一致
  mtcReceiver.setFrameRate(30);

  try {
      // 首先检测所有可用的MIDI输入设备
      const inputCount = midiInput.getPortCount();
      log(`[MTC-Receive] 枚举输入设备 ${inputCount} 个，请求名称=${JSON.stringify(inputName)}，请求索引=${inputIndex}`);

      // 优先按名称精确匹配端口（避免两次枚举顺序不一致时开错了设备）
      let actualPortIndex = typeof inputIndex === 'number' && !isNaN(inputIndex) ? inputIndex : -1;
      let matchedByName = false;

      if (inputName) {
        for (let i = 0; i < inputCount; i++) {
          try {
            const portName = midiInput.getPortName(i);
            log(`[MTC-Receive] 端口 ${i}: ${JSON.stringify(portName)}`);
            if (portName && String(portName).trim() === String(inputName).trim()) {
              actualPortIndex = i;
              matchedByName = true;
              break;
            }
          } catch(_) {}
        }
      }

      if (actualPortIndex < 0 || actualPortIndex >= inputCount) {
        throw new Error(`无法定位MIDI输入设备: 名称=${JSON.stringify(inputName)}，索引=${inputIndex}，可用端口数=${inputCount}`);
      }
      log(`[MTC-Receive] 最终打开端口 ${actualPortIndex}${matchedByName ? '(按名匹配)' : '(按索引兜底)'}: ${JSON.stringify(midiInput.getPortName(actualPortIndex))}`);

      // 800ms 无 MTC 聚合 → 通知渲染端信号丢失（句柄挂到 state 上，stop 时清理）
      let signalLostTimer = null;

      try {
        midiInput.openPort(actualPortIndex);
        
        // 确保midiInput对象存在且有on方法
        if (midiInput && typeof midiInput.on === 'function') {
          // 禁用消息过滤，确保所有MIDI消息都能被接收
          try {
            if (typeof midiInput.ignoreTypes === 'function') {
              midiInput.ignoreTypes(false, false, false); // 禁用所有消息过滤
            }
          } catch (error) {
            // 静默处理错误
          }

          midiInput.on('message', function(deltaTime, message) {
            try {
              // ============== 1. MIDI Realtime 单字节：FA/FB/FC/FF ==============
              // 小红花 "停止/继续/从头开始/系统复位" 的真实语义靠这个识别，不是靠 800ms 超时。
              if (message && message.length === 1) {
                const b = message[0];
                let ctrlType = null;
                switch (b) {
                  case 0xFA: ctrlType = 'START';    break; // 从头播放
                  case 0xFB: ctrlType = 'CONTINUE'; break; // 继续播放
                  case 0xFC: ctrlType = 'STOP';     break; // 真正停止（播放头归零，MTC停止发送）
                  case 0xFF: ctrlType = 'RESET';    break; // 系统复位（紧急停止）
                }
                if (ctrlType) {
                  // STOP/RESET：立即清零看门狗，别再等 800ms
                  if (ctrlType === 'STOP' || ctrlType === 'RESET') {
                    if (signalLostTimer) { clearTimeout(signalLostTimer); signalLostTimer = null; }
                  }
                  // START/CONTINUE：立即 kick 一次看门狗，避免首帧慢时误报"信号丢失"
                  if (ctrlType === 'START' || ctrlType === 'CONTINUE') {
                    if (signalLostTimer) clearTimeout(signalLostTimer);
                    signalLostTimer = setTimeout(() => {
                      try {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                          mainWindow.webContents.send('mtc-signal-lost');
                        }
                      } catch (_) {}
                    }, 800);
                  }
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('mtc-control', { type: ctrlType });
                  }
                  return; // Realtime 不进入后续 MTC 解析流程
                }
                // F8 Clock / FE ActiveSensing 忽略（实时流量会爆，静默即可）
                // 其他单字节 Realtime 无动作
              }

              // ============== 2. 正常 MTC quarter-frame (F1 xx) ==============
              const time = mtcReceiver.processMessage(message);
              if (time) {
                if (signalLostTimer) clearTimeout(signalLostTimer);
                signalLostTimer = setTimeout(() => {
                  try {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                      mainWindow.webContents.send('mtc-signal-lost');
                    }
                  } catch (_) {}
                }, 800);
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('mtc-time', time);
                  mainWindow.webContents.send('trigger-music-by-time', time);
                }
              }
            } catch (error) {
              // 静默处理错误
            }
          });


        } else {
          throw new Error('MIDI输入设备无效');
        }
    } catch (openError) {
      throw openError;
    }

    // 监听设备断开连接事件
    midiInput.on('disconnect', () => {
      // 静默处理
    });

    // 监听错误事件
    midiInput.on('error', (error) => {
      // 静默处理
    });



    mtcReceiveState = {
      midiInput,
      mtcReceiver,
      get signalLostTimer() { return signalLostTimer; },
      clearSignalLostTimer() { if (signalLostTimer) { clearTimeout(signalLostTimer); signalLostTimer = null; } }
    };

    log('MTC接收启动成功');
    return { success: true };
  } catch (error) {
    log('MTC接收启动失败:', error.message);
    log('MTC接收启动错误堆栈:', error.stack);
    // 尝试关闭设备
    try {
      if (midiInput) {
        midiInput.closePort();
        log('Node-MIDI - 已关闭MIDI输入设备');
      }
    } catch (closeError) {
      log('关闭MIDI设备失败:', closeError.message);
    }
    return { success: false, error: error.message };
  }
}

// 停止MTC接收
function stopMTCReceive() {
  if (mtcReceiveState) {
    try {
      if (typeof mtcReceiveState.clearSignalLostTimer === 'function') {
        mtcReceiveState.clearSignalLostTimer();
      } else if (mtcReceiveState.signalLostTimer) {
        clearTimeout(mtcReceiveState.signalLostTimer);
      }
    } catch (e) {}
    try {
      if (mtcReceiveState.midiInput) {
        mtcReceiveState.midiInput.closePort();
      }
    } catch (error) {
      log('关闭MTC接收设备失败:', error);
    }
    mtcReceiveState = null;
    log('MTC接收已停止');
  }
}

// 获取所有网络接口的IP地址
function getNetworkIPs() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const ips = [];
  
  for (const interfaceName in interfaces) {
    const interface = interfaces[interfaceName];
    for (const addr of interface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  
  // 添加localhost
  ips.unshift('localhost');
  return ips;
}

// 启动远程控制服务器
function startRemoteControlServer() {
  if (remoteControlServer) {
    return;
  }

  // 启动前置检查：全局 mainWindow 是否已经创建
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  // 创建HTTP服务器
  log('创建HTTP服务器...');
  remoteControlServer = http.createServer((req, res) => {
    // 解析请求URL
    const parsedUrl = url.parse(req.url);
    const pathname = parsedUrl.pathname;
    
    // 设置CORS头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // 处理OPTIONS请求
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    
    // 统一收集 POST body 并让流始终流向 end（确保 GET 请求也能立即触发 'end'）
    let postBody = '';
    req.on('data', chunk => { postBody += chunk.toString(); });
    // 对非 POST/PUT 立即 resume，确保 end 事件及时触发
    if (req.method !== 'POST' && req.method !== 'PUT') {
      try { req.resume(); } catch(_) {}
    }

    req.on('end', () => {
    // 处理API请求
    try {
      if (pathname === '/api/control') {
        if (req.method === 'POST') {
            try {
              const data = JSON.parse(postBody);

              // 向渲染进程发送控制命令
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('remote-control-command', data);
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: '命令已执行' }));
            } catch (error) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: '请求格式错误' }));
            }
        } else {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '方法不允许' }));
        }
      } else if (pathname === '/api/status') {
        // 返回应用状态（优先使用实时缓存，兜底读文件）
        try {
          // 优先返回主窗口实时推送的缓存状态（避免文件写入延迟导致状态不同步）
          if (cachedMusicState.updatedAt > 0) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              success: true,
              status: 'running',
              remoteControlEnabled: remoteControlEnabled,
              currentGroup: cachedMusicState.currentGroup,
              currentPlayingIndex: cachedMusicState.currentPlayingIndex,
              isPlaying: cachedMusicState.isPlaying,
              volume: cachedMusicState.volume,
              repeatMode: cachedMusicState.repeatMode,
              theme: cachedMusicState.theme,
              language: cachedMusicState.language || 'zh-CN',
            }));
            return;
          }
          // 兜底：从本地文件读取应用状态
          const fs = require('fs');
          const path = require('path');
          const os = require('os');
          const appDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'live-music-player');
          const statePath = path.join(appDataPath, 'app-state.json');

          if (fs.existsSync(statePath)) {
            // 读取文件时添加编码参数，确保正确读取
            const appState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            // 返回应用状态
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              success: true,
              status: 'running',
              remoteControlEnabled: remoteControlEnabled,
              currentGroup: appState.currentGroup || 0,
              currentPlayingIndex: appState.currentPlayingIndex || -1,
              isPlaying: appState.isPlaying || false,
              volume: appState.volume !== undefined ? appState.volume : 1,
              repeatMode: appState.repeatMode || 'list',
              theme: appState.theme || 'dark',
              language: appState.language || 'zh-CN',
            }));
            return;
          }

          // 如果本地文件不存在，返回默认状态
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            success: true,
            status: 'running',
            remoteControlEnabled: remoteControlEnabled,
            currentGroup: 0,
            currentPlayingIndex: -1,
            isPlaying: false,
            volume: 1,
            repeatMode: 'list',
            theme: 'dark',
            language: 'zh-CN',
          }));
        } catch (error) {
          console.log('读取本地应用状态错误:', error);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            success: true,
            status: 'running',
            remoteControlEnabled: remoteControlEnabled,
            currentGroup: 0,
            currentPlayingIndex: -1,
            isPlaying: false,
            volume: 1,
            repeatMode: 'list',
            theme: 'dark',
            language: 'zh-CN',
          }));
        }
      } else if (pathname === '/api/groups') {
        // 返回分组列表 + 每分组音乐（优先用主窗口推送的内存缓存，回退磁盘）
        try {
          let groups = null;
          // 优先用内存缓存（缓存非空且在 24h 内有效）
          if (cachedGroups && cachedGroups.groups && cachedGroups.groups.length > 0
              && cachedGroups.updatedAt > Date.now() - 24 * 3600 * 1000) {
            groups = cachedGroups.groups;
          } else {
            // 回退磁盘
            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            const appDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'live-music-player');
            const statePath = path.join(appDataPath, 'app-state.json');
            if (fs.existsSync(statePath)) {
              const appState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
              if (appState.groups) {
                groups = appState.groups.map(group => ({
                  id: group.id,
                  name: group.name,
                  musicList: Array.isArray(group.musicList)
                    ? group.musicList.map(m => ({ title: m && m.title ? m.title : '未命名' }))
                    : []
                }));
              }
            }
          }
          if (!groups || groups.length === 0) {
            groups = [{ id: 0, name: '默认分组', musicList: [] }];
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, groups }));
        } catch (error) {
          console.log('[/api/groups] err:', error && error.message);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, groups: [{ id: 0, name: '默认分组', musicList: [] }] }));
        }
      } else if (pathname === '/api/music') {
        // 返回指定分组的音乐列表（优先用 cachedGroups 内存缓存）
        try {
          const query = querystring.parse(parsedUrl.query);
          const groupIndex = parseInt(query.group) || 0;
          let group = null;
          if (cachedGroups && cachedGroups.groups && cachedGroups.groups.length > 0) {
            // 先按数组索引匹配（remote-control.html 传的是 index）
            if (cachedGroups.groups[groupIndex]) group = cachedGroups.groups[groupIndex];
            // 再按 id 匹配（万一 index 和 id 不一致）
            if (!group) group = cachedGroups.groups.find(g => g && g.id === groupIndex);
          }
          if (!group) {
            // 回退磁盘
            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            const appDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'live-music-player');
            const statePath = path.join(appDataPath, 'app-state.json');
            if (fs.existsSync(statePath)) {
              const appState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
              if (appState.groups && Array.isArray(appState.groups)) {
                if (appState.groups[groupIndex]) group = {
                  id: appState.groups[groupIndex].id,
                  name: appState.groups[groupIndex].name,
                  musicList: Array.isArray(appState.groups[groupIndex].musicList)
                    ? appState.groups[groupIndex].musicList.map(m => ({ title: m && m.title ? m.title : '未命名' }))
                    : []
                };
                if (!group) {
                  const found = appState.groups.find(g => g && g.id === groupIndex);
                  if (found) group = {
                    id: found.id, name: found.name,
                    musicList: Array.isArray(found.musicList)
                      ? found.musicList.map(m => ({ title: m && m.title ? m.title : '未命名' }))
                      : []
                  };
                }
              }
            }
          }
          const musicList = group && Array.isArray(group.musicList) ? group.musicList : [];
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, music: musicList }));
        } catch (error) {
          console.log('[/api/music] err:', error && error.message);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, music: [] }));
        }
      } else if (pathname === '/api/theme-config') {
        // ===== 返回 4 套主题完整色值 + 当前界面语言（手机端据此同步 UI 配色与多语言） =====
        const themes = {
          dark:  { theme:'dark',  themeColor:'#ff6b6b', bodyBg:'#1a1a1a', containerBg:'#2a2a2a', inputBg:'#3a3a3a', textColor:'#ffffff', textMuted:'#bbbbbb', borderColor:'#4a4a4a', success:'#25d366', danger:'#e74c3c', warn:'#f1c40f', info:'#3498db' },
          light: { theme:'light', themeColor:'#ff6b6b', bodyBg:'#f4f4f7', containerBg:'#ffffff', inputBg:'#eaeaee', textColor:'#222222', textMuted:'#666666', borderColor:'#dddddd', success:'#25d366', danger:'#e74c3c', warn:'#f1c40f', info:'#3498db' },
          cute:  { theme:'cute',  themeColor:'#ff6699', bodyBg:'#ffe4ec', containerBg:'#fff0f5', inputBg:'#ffd3e3', textColor:'#74284e', textMuted:'#a3567a', borderColor:'#ffb3cd', success:'#25d366', danger:'#e74c3c', warn:'#f1c40f', info:'#3498db' },
          cool:  { theme:'cool',  themeColor:'#ff6b35', bodyBg:'#0f1e2e', containerBg:'#182a3f', inputBg:'#223857', textColor:'#e6f0ff', textMuted:'#8fa8c9', borderColor:'#2d4568', success:'#25d366', danger:'#e74c3c', warn:'#f1c40f', info:'#3498db' },
        };
        try {
          const fs = require('fs');
          const path = require('path');
          const os = require('os');
          const appDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'live-music-player');
          const statePath = path.join(appDataPath, 'app-state.json');
          let currentTheme = 'dark';
          let currentLanguage = 'zh-CN';
          if (fs.existsSync(statePath)) {
            try {
              const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
              if (st && st.theme) currentTheme = st.theme;
              if (st && st.language) currentLanguage = st.language;
            } catch (_) {}
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success:true, current: currentTheme, themes: themes, language: currentLanguage }));
        } catch (_) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success:true, current:'dark', themes: themes, language: 'zh-CN' }));
        }
      } else if (pathname === '/api/cabinets') {
        // ===== 电柜列表 + 运行状态（配置从 cabinetCachedConfig 读，在线/路状态从 cachedCabinetRuntime 读） =====
        try {
          const cfg = cabinetCachedConfig || loadCabinetConfigFromFile() || { schemaVersion:1, cabinets:[] };
          const list = (cfg && Array.isArray(cfg.cabinets) ? cfg.cabinets : []).map(cab => {
            const key = String(cab.id);
            const online = cachedCabinetRuntime.onlineMap[key];
            const statuses = cachedCabinetRuntime.statusMap[key] || null;
            return {
              id: cab.id,
              name: cab.name || '未命名电柜',
              ip: cab.ip || '',
              switchCount: parseInt(cab.switchCount,10) || 12,
              protocolVersion: cab.protocolVersion || '2023',
              cabinetNo: parseInt(cab.cabinetNo,10) || 1,
              buttons: Array.isArray(cab.buttons) ? cab.buttons.map(b => ({ roadNo:b.roadNo, name:b.name||'', color:b.color||'#ff6b6b' })) : null,
              online: online === true ? true : (online === false ? false : null), // true 在线, false 离线, null 未检测
              statuses: statuses, // [0|1|-1, ...] -1=未知
            };
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success:true, cabinets: list, updatedAt: cachedCabinetRuntime.updatedAt }));
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success:false, message: err && err.message || '读取失败', cabinets: [] }));
        }
      } else if (pathname === '/api/cabinet/send' && req.method === 'POST') {
        // ===== 发送电柜指令（复用核心逻辑，与 IPC cabinet:send 完全一致） =====
        try {
          const postData = JSON.parse(postBody || '{}');
          const result = sendCabinetCommand(postData);
          if (result.ok) {
            // 设置乐观保护锁（防止设备 ACK 反向包覆盖手机端乐观状态）
            const expectVal = (result.action === 'on') ? 1 : 0;
            if (result.road !== 'all') {
              setRemoteOptimistic(postData.cabinetId, result.road, expectVal);
            } else {
              // road='all'：对每一路都设锁（与电柜管理窗口逻辑一致）
              const cab = findCabinetById(postData.cabinetId);
              const cnt = parseInt(cab && cab.switchCount, 10) || 12;
              for (let r = 1; r <= cnt; r++) setRemoteOptimistic(postData.cabinetId, r, expectVal);
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success:true, sent: result.sent, cabinetName: result.cabinetName, road: result.road, action: result.action }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success:false, message: result.error || '发送失败' }));
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success:false, message: err && err.message || '发送异常' }));
        }
      } else if (pathname === '/api/cabinet/all' && req.method === 'POST') {
        // ===== 电柜逐路 顺开/逆开/顺关/逆关（手机端专用，主进程内部逐路调用避免12次HTTP往返） =====
        try {
          const postData = JSON.parse(postBody || '{}');
          const { cabinetId, mode } = postData;
          if (!cabinetId) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success:false, message:'缺少 cabinetId' }));
            return;
          }
          if (!['seqOn','revOn','seqOff','revOff'].includes(mode)) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success:false, message:'mode 必须是 seqOn/revOn/seqOff/revOff' }));
            return;
          }
          // 查找电柜配置（复用 findCabinetById，与 sendCabinetCommand 一致）
          const cab = findCabinetById(cabinetId);
          if (!cab) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success:false, message:'电柜不存在' }));
            return;
          }
          const cnt = parseInt(cab.switchCount, 10) || 12;
          const onOff = (mode === 'seqOn' || mode === 'revOn') ? 'on' : 'off';
          const isRev = (mode === 'revOn' || mode === 'revOff');
          const roads = [];
          if (isRev) { for (let r = cnt; r >= 1; r--) roads.push(r); }
          else { for (let r = 1; r <= cnt; r++) roads.push(r); }

          // 异步逐路发送，不阻塞 HTTP 响应
          (async () => {
            // 从主窗口 localStorage 读取电柜管理的每路间隔设置，与主界面保持一致
            let intervalMs = 500; // 默认 500ms（与电柜管理窗口默认值一致）
            try {
              if (mainWindow && !mainWindow.isDestroyed()) {
                const sec = await mainWindow.webContents.executeJavaScript(
                  `parseFloat(localStorage.getItem('${'cabRoadStepIntervalSec'}')) || 0.5`
                );
                // 钳制到 [0.3, 2] 秒，与 cabinet-manager.html 的 getRoadStepIntervalMs() 一致
                const clamped = Math.min(2, Math.max(0.3, sec));
                intervalMs = Math.round(clamped * 1000);
              }
            } catch (_) {}
            let ok = 0, fail = 0;
            for (let i = 0; i < roads.length; i++) {
              const road = roads[i];
              try {
                const r = sendCabinetCommand({ cabinetId: cab.id, road: road, action: onOff });
                if (r.ok) {
                  ok++;
                  // 每路发送成功后立即设置乐观锁（保护期1.5秒）
                  setRemoteOptimistic(cab.id, road, (onOff === 'on') ? 1 : 0);
                } else fail++;
              } catch (_) { fail++; }
              // 每路间隔与电柜管理窗口一致（由主界面间隔输入框控制）
              if (i !== roads.length - 1) {
                await new Promise(resolve => setTimeout(resolve, intervalMs));
              }
            }
            log(`[电柜逐路] ${cab.name || cabinetId} ${mode}: 成功 ${ok} / 失败 ${fail}`);
          })();

          // 立即返回，不等逐路发完（手机端按钮反应快）
          const modeLabel = { seqOn:'顺序全开', revOn:'逆序全开', seqOff:'顺序全关', revOff:'逆序全关' }[mode];
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success:true, message: (cab.name || '电柜') + ' ' + modeLabel + ' 指令已下发', mode: mode, roads: roads.length }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success:false, message: err && err.message || '发送异常' }));
        }
      } else if (pathname === '/api/console/status') {
        // ===== 控台状态快照 =====
        try {
          const snap = cachedConsoleSnapshot || {};
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            success: true,
            connected: !!snap.connected,
            ip: snap.ip || '',
            updatedAt: snap.updatedAt || 0,
            categories: snap.categories || [],
            playingItems: snap.playingItems || [],
            faders: snap.faders || [],
            sceneMutexEnabled: !!snap.sceneMutexEnabled,
            protectedPlayIds: snap.protectedPlayIds || [],
            windowOpen: !!(consoleWindow && !consoleWindow.isDestroyed()),
          }));
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success:false, message: err && err.message || '读取失败', categories:[], playingItems:[], faders:[] }));
        }
      } else if (pathname === '/api/console/send' && req.method === 'POST') {
        // ===== 控台指令转发（通过 IPC 发送到控台窗口） =====
        try {
          const cmd = JSON.parse(postBody || '{}');
          if (!cmd || !cmd.action) { res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({success:false, message:'缺少 action 参数'})); return; }
          if (!consoleWindow || consoleWindow.isDestroyed()) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success:false, message:'控台窗口未打开，请先在金刚助手中打开「连接控台」窗口' }));
            return;
          }
          consoleWindow.webContents.send('console-remote-cmd', cmd);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success:true, message:'指令已下发', action: cmd.action }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success:false, message: err && err.message || '发送异常' }));
        }
      } else if (pathname === '/api/console/mutex' && req.method === 'POST') {
        // ===== 切换场景互斥开关 =====
        try {
          if (!consoleWindow || consoleWindow.isDestroyed()) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success:false, message:'控台窗口未打开' }));
            return;
          }
          consoleWindow.webContents.send('console-remote-cmd', { action: 'toggleMutex' });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success:true, message:'场景互斥已切换' }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success:false, message: err && err.message || '切换异常' }));
        }
      } else if (pathname === '/logo.png') {
        try {
          const logoBuf = fs.readFileSync(path.join(__dirname, 'logo.png'));
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
          res.end(logoBuf);
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'logo.png 不存在' }));
        }
      } else if (pathname.startsWith('/js/')) {
        // ===== 手机端静态资源：i18n.js 核心 + 各语言包（/js/i18n/*.js）=====
        try {
          const fsMod = require('fs');
          const pathMod = require('path');
          // 防止路径穿越（例如 /js/../package.json）：规范化后仍必须以 __dirname + /js/ 开头
          let relative = decodeURIComponent(pathname.substring('/js/'.length));
          if (!relative || relative.includes('..')) { throw new Error('invalid path'); }
          const filePath = pathMod.join(__dirname, 'js', relative);
          const expectedPrefix = pathMod.join(__dirname, 'js') + pathMod.sep;
          if (filePath !== expectedPrefix.slice(0, -1) && !filePath.startsWith(expectedPrefix)) {
            throw new Error('outside');
          }
          if (fsMod.existsSync(filePath) && fsMod.statSync(filePath).isFile()) {
            const ext = pathMod.extname(filePath).toLowerCase();
            const mime = ext === '.js' ? 'application/javascript; charset=utf-8'
                       : ext === '.css' ? 'text/css; charset=utf-8'
                       : ext === '.json' ? 'application/json; charset=utf-8'
                       : ext === '.html' ? 'text/html; charset=utf-8'
                       : ext === '.png' ? 'image/png'
                       : ext === '.svg' ? 'image/svg+xml'
                       : 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
            res.end(fsMod.readFileSync(filePath));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success:false, message:'文件不存在: ' + pathname }));
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success:false, message:'非法路径: ' + pathname }));
        }
      } else if (pathname === '/' || pathname === '/remote-control.html') {
        // 提供远程控制页面
        try {
          const htmlContent = fs.readFileSync(path.join(__dirname, 'remote-control.html'), 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(htmlContent);
        } catch (error) {
          log('读取远程控制页面失败:', error);
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>错误</h1><p>无法加载远程控制页面</p></body></html>');
        }

      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: '路径不存在' }));
      }
    } catch (error) {
      log('请求处理错误:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: '服务器内部错误' }));
    }
    }); // end req.on('end')
  });
  
  // 启动服务器，监听1995端口
  const port = 1995;
  log(`启动服务器，监听端口 ${port}...`);
  remoteControlServer.listen(port, '0.0.0.0', () => {
    log(`远程控制服务器已启动，监听端口 ${port}`);
    remoteControlEnabled = true;
    
    // 获取所有网络IP地址并发送给渲染进程
    const ips = getNetworkIPs();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remote-control-ips', {
        success: true,
        ips: ips,
        port: port
      });
    }
  });
  
  // 处理服务器错误
  remoteControlServer.on('error', (error) => {
    log('远程控制服务器错误:', error);
    remoteControlServer = null;
    remoteControlEnabled = false;
  });
  
  log('远程控制服务器启动流程完成');
}

// 停止远程控制服务器
function stopRemoteControlServer() {
  if (remoteControlServer) {
    remoteControlServer.close(() => {
      log('远程控制服务器已停止');
      remoteControlServer = null;
      remoteControlEnabled = false;
    });
  } else {
    log('远程控制服务器未运行');
  }
}

// 主题缓存（供开屏广告读取当前主题）
ipcMain.on('save-theme-cache', (event, themeName) => {
  try {
    const themeFile = path.join(app.getPath('userData'), 'theme-cache.json');
    fs.writeFileSync(themeFile, JSON.stringify({ theme: themeName, updatedAt: Date.now() }), 'utf-8');
    currentThemeName = themeName;
  } catch(_) {}
});

// ===== 开屏广告 =====
function createSplashWindow(callback) {
  const config = loadAppConfig();
  if (!config.showSplash) {
    // 不显示开屏，直接创建主窗口
    if (callback) callback();
    return;
  }
  // 读取上次主窗口尺寸作为开屏尺寸
  const mainState = loadWindowState('main');
  const mainBounds = (mainState && mainState.bounds) ? mainState.bounds : { width: 1600, height: 800 };
  // 读取当前主题
  let themeName = 'dark';
  try {
    const themeFile = path.join(app.getPath('userData'), 'theme-cache.json');
    if (fs.existsSync(themeFile)) {
      const themeObj = JSON.parse(fs.readFileSync(themeFile, 'utf-8') || '{}');
      if (themeObj.theme) themeName = themeObj.theme;
    }
  } catch(_) {}

  splashWindow = new BrowserWindow({
    width: mainBounds.width || 1600,
    icon: path.join(__dirname, 'logo.ico'),
    height: mainBounds.height || 800,
    x: mainBounds.x,
    y: mainBounds.y,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    transparent: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
    },
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'), { query: { theme: themeName } });
  splashWindow.setMenuBarVisibility(false);

  splashWindow.once('ready-to-show', () => {
    splashWindow.show();
    // 3秒后关闭开屏，显示主窗口
    setTimeout(() => {
      try {
        if (splashWindow && !splashWindow.isDestroyed()) {
          // 淡出效果
          splashWindow.webContents.executeJavaScript('document.body.style.transition="opacity 0.3s"; document.body.style.opacity="0";').catch(() => {});
          setTimeout(() => {
            try {
              if (splashWindow && !splashWindow.isDestroyed()) {
                splashWindow.close();
                splashWindow = null;
              }
            } catch(_) {}
            if (callback) callback();
          }, 300);
        } else {
          if (callback) callback();
        }
      } catch(_) {
        if (callback) callback();
      }
    }, 3000);
  });

  // 兜底：如果开屏加载失败，5秒后强制继续
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      try { splashWindow.close(); splashWindow = null; } catch(_) {}
    }
    if (!mainWindow) {
      if (callback) callback();
    }
  }, 5000);
}

// Electron 会在初始化后并准备
// 创建浏览器窗口时，调用这个函数
app.whenReady().then(() => {
  // 需求3：先显示开屏广告，3秒后再创建主窗口
  createSplashWindow(() => {
    createWindow();
  });

  // 启动内置音乐搜索 API 服务
  const { createApiServer } = require('./api-server');
  createApiServer();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 开屏广告开关 IPC
ipcMain.on('get-splash-setting', (event) => {
  const config = loadAppConfig();
  event.returnValue = config.showSplash;
});
ipcMain.on('set-splash-setting', (event, enabled) => {
  saveAppConfig({ showSplash: !!enabled });
  event.returnValue = true;
});

// 渲染进程获取 userData 路径（用于 app-state.json 存取，避免硬编码路径不一致）
ipcMain.handle('get-user-data-path', () => app.getPath('userData'));
// 同步版本（saveAppState 非异步，需同步获取路径）
ipcMain.on('get-user-data-path-sync', (event) => { event.returnValue = app.getPath('userData'); });

// ========== 应用状态文件保存/读取（不依赖 localStorage，防止改名/迁移丢数据）==========
const appStateFile = () => path.join(app.getPath('userData'), 'app-state.json');
// 渲染进程保存状态到文件（同步，saveAppState 需同步完成）
ipcMain.on('app-state:save-sync', (event, stateJson) => {
  try {
    const fp = appStateFile();
    fs.writeFileSync(fp, stateJson, 'utf-8');
    event.returnValue = { ok: true, path: fp };
  } catch (err) {
    event.returnValue = { ok: false, error: String(err && err.message || err) };
  }
});
// 渲染进程从文件读取状态（同步，loadAppState 需同步完成）
ipcMain.on('app-state:load-sync', (event) => {
  try {
    const fp = appStateFile();
    if (fs.existsSync(fp)) {
      const data = fs.readFileSync(fp, 'utf-8');
      event.returnValue = { ok: true, data: data };
    } else {
      event.returnValue = { ok: false, reason: 'not-found' };
    }
  } catch (err) {
    event.returnValue = { ok: false, error: String(err && err.message || err) };
  }
});

// ========== 退出前通知渲染进程保存 ==========
// 不阻止退出流程（preventDefault 会导致窗口不关闭、beforeunload 不触发）
// 正常退出流程：before-quit → 窗口关闭 → beforeunload(渲染进程) → will-quit → quit
// beforeunload 中的 saveAppState() 使用 sendSync 同步保存，会在窗口关闭前完成
app.on('before-quit', () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('save-before-quit');
    }
  } catch (_) {}
});

// 关闭所有窗口时退出应用 (Windows & Linux)
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// 应用退出时注销所有全局快捷键
app.on('will-quit', () => {
  unregisterAllGlobalShortcuts();
  // 电柜 UDP 2021 Socket 释放（若有）
  try {
    if (unifiedRecvSocket && typeof unifiedRecvSocket.close === 'function') {
      unifiedRecvSocket.removeAllListeners('message');
      unifiedRecvSocket.removeAllListeners('error');
      unifiedRecvSocket.close(() => {});
    }
  } catch (_) {}
  // 清 pending 定时器
  try {
    if (cabinetPendingTimer) {
      clearInterval(cabinetPendingTimer);
      cabinetPendingTimer = null;
    }
  } catch (_) {}
});

// =========================================================================
// 电柜管理 UDP 核心（双协议：新版电柜 + 硅箱，同时触发；收包分流；防卡死硬阈值）
// =========================================================================
let unifiedRecvSocket = null;
let cabinetRecvBoundOk = false;
let cabinetRecvBindConflict = false; // 是否存在其他程序也监听 2021
// 发送等待队列（上限 5000，超限 FIFO 丢弃）
const MAX_PENDING = 5000;
let cabinetPendingList = [];
let cabinetPendingTimer = null;
// 心跳 ping：{ cabId: { resolve, timer, fired } }，收包时若匹配到 cabId → resolve(true)；300ms 超时 resolve(false)
let pendingPingMap = new Map();
const PING_TIMEOUT_MS = 300;
// 主进程内存缓存的电柜配置（由渲染进程 cabinet:save-config 更新上来，用于匹配 cabinetId/ip/编号）
let cabinetCachedConfig = null;
// 配置文件路径（持久化到 userData，跨窗口生命周期保留）
const cabinetConfigFilePath = path.join(app.getPath('userData'), 'cabinet-config.json');
// ART-NET 状态：按 `${ip}:${universe}` 维护一份 512 字节 DMX 缓冲（单路开/关不影响其他通道）
const artnetDmxCache = new Map();   // key -> Buffer(512)
const artnetStateFile = () => path.join(app.getPath('userData'), 'artnet-dmx-state.json');
function loadArtnetDmxState(){
  try{
    const raw = fs.readFileSync(artnetStateFile(), 'utf8');
    const obj = JSON.parse(raw);
    if(obj && typeof obj === 'object'){
      artnetDmxCache.clear();
      Object.keys(obj).forEach(k => {
        const s = obj[k];
        if(Array.isArray(s) && s.length === 512){
          artnetDmxCache.set(k, Buffer.from(s));
        } else if(Buffer.isBuffer(s) && s.length === 512){
          artnetDmxCache.set(k, Buffer.from(s));
        }
      });
    }
  }catch(_){}
}
let _artnetSaveTimer = null;
function saveArtnetDmxStateSoon(){
  if(_artnetSaveTimer) return;
  _artnetSaveTimer = setTimeout(() => {
    _artnetSaveTimer = null;
    try{
      const obj = {};
      artnetDmxCache.forEach((buf, k) => { obj[k] = Array.from(buf) });
      fs.writeFileSync(artnetStateFile(), JSON.stringify(obj));
    }catch(_){}
  }, 80);
  if(_artnetSaveTimer && _artnetSaveTimer.unref) _artnetSaveTimer.unref();
}
// 启动立刻加载一次
try{ loadArtnetDmxState(); }catch(_){}
// app ready 后再兜底加载一次（userData 路径在 ready 前可能未初始化/可写）
app.on('ready', () => { try{ loadArtnetDmxState(); }catch(_){} });
function loadCabinetConfigFromFile(){
  try{
    const raw = fs.readFileSync(cabinetConfigFilePath, 'utf-8');
    const obj = JSON.parse(raw);
    if(obj && typeof obj === 'object' && Array.isArray(obj.cabinets)){
      cabinetCachedConfig = obj;
    }
  }catch(_){}
}
function saveCabinetConfigToFile(){
  try{
    fs.writeFileSync(cabinetConfigFilePath, JSON.stringify(cabinetCachedConfig || { cabinets:[] }, null, 2), 'utf-8');
  }catch(_){}
}
// 启动时立即从文件加载
loadCabinetConfigFromFile();

function hexStr(buf){ return buf ? Buffer.from(buf).toString('hex') : ''; }

// 按规范：① >1600 或 <6 丢弃；② 分流：530 字节=硅箱；aa6a..aaa6=新版电柜；其他=垃圾包
function onCabinetRecvMessage(msg, rinfo){
  try{
    if(!msg || msg.length < 6 || msg.length > 1600) return; // 硬阈值 1
    if(msg.length === 530){
      parseSiliconRecv(msg, rinfo);
    } else {
      // 硬阈值 2：帧头尾（新版电柜短包）
      const L = msg.length;
      if(msg[0] === 0xaa && msg[1] === 0x6a && msg[L-2] === 0xaa && msg[L-1] === 0xa6){
        parseCabinetRecv(msg, rinfo);
      }
      // 其他：垃圾包静默丢弃，不打日志（防止刷屏卡死）
    }
  }catch(_){
    // 解析异常直接吞，绝不 throw
  }
}

function ensureCabinetSockets(){
  if(unifiedRecvSocket) return;
  try{
    unifiedRecvSocket = dgram.createSocket({ type:'udp4', reuseAddr:true });
    unifiedRecvSocket.on('error', (err) => {
      const code = (err && err.code) || 'SOCKET_ERR';
      if(code === 'EADDRINUSE'){
        cabinetRecvBoundOk = false;
        cabinetRecvBindConflict = true;
      }
      pushCabinetError({
        code: code === 'EADDRINUSE' ? 'BIND_PORT_2021_FAIL' : 'UDP_SOCKET_ERROR',
        message: code === 'EADDRINUSE'
          ? 'UDP 2021端口被其他程序占用，无法接收设备回传（仍可下发指令）。请关闭其他占用软件后重试。'
          : ('UDP 错误：' + (err && err.message || String(err)))
      });
    });
    unifiedRecvSocket.on('listening', () => {
      try{
        // reuseAddr 绑定成功并不代表独占；尝试看看端口占用有没有冲突提示（没冲突就不提示）
        const addr = unifiedRecvSocket.address();
        cabinetRecvBoundOk = true;
        if(!cabinetRecvBindConflict){
          pushCabinetInfo({ code:'SOCKET_READY', message:`UDP 就绪，监听端口 ${addr.port}` });
        } else {
          pushCabinetError({
            code:'BIND_PORT_2021_CONFLICT',
            message:'2021端口已被本软件以外的程序同时监听，回传稳定性可能受影响。'
          });
        }
      }catch(_){}
    });
    unifiedRecvSocket.on('message', onCabinetRecvMessage);
    unifiedRecvSocket.bind(2021, '0.0.0.0');

    // pending 超时扫描（100ms）—— 纯回传驱动：超时只闪黄框，不改 UI 状态
    if(!cabinetPendingTimer){
      cabinetPendingTimer = setInterval(() => {
        try{
          const now = Date.now();
          const left = [];
          const toPush = [];
          for(let i=0; i<cabinetPendingList.length; i++){
            const it = cabinetPendingList[i];
            if(it.expireAt <= now){
              toPush.push({
                cabinetId: it.cabinetId,
                type: 'timeout',
                road: it.road,
                action: it.action,
                ts: it.ts,
              });
            } else {
              left.push(it);
            }
          }
          cabinetPendingList = left;
          if(toPush.length){
            toPush.forEach(p => pushCabinetStatus(p));
          }
        }catch(_){}
      }, 100);
      if(cabinetPendingTimer && cabinetPendingTimer.unref) cabinetPendingTimer.unref();
    }
  }catch(err){
    pushCabinetError({ code:'UDP_INIT_FAIL', message:'UDP 初始化失败：' + (err && err.message || String(err)) });
  }
}

// ========== 新版电柜 7B 组包 ==========
// type: 0x01 单路 / 0x02 一键 / 0x04 查询
function buildCabinetPacket({ type, cabinetNo, roadNo, action }){
  const buf = Buffer.alloc(7, 0x00);
  buf[0] = 0xaa; buf[1] = 0x6a;
  buf[2] = (type & 0xff);
  buf[3] = (parseInt(cabinetNo,10) || 1) & 0xff;
  buf[4] = (parseInt(roadNo,10) || 0) & 0xff;
  buf[5] = (parseInt(action,10) || 0) & 0xff; // 0x02 开 / 0x00 关 / 查询 0x00
  buf[6] = 0xaa; buf[7] = 0xa6; // 注意 alloc(7) 只到 buf[6]，因此这里 buf[7]越界 → 改为下面正确写法
  return buf;
}
// 重写正确版（上面 alloc(7) → 索引 0..6，帧尾是最后 2 字节 → buf[5]=buf[6]？不：7B 总长=帧头2 + 类型1 + 柜号1 + 路号1 + 动作1 + 帧尾2 = 8？哦文档样例正好是 14 个 hex=7字节！等等我数一下：
// 文档样例：aa6a 01 01 01 02 aaa6 → 正好 14 字符 hex → 7 字节。字节数 2+1+1+1+1+2 = 8 不对啊？我再数一遍：
// 6个字段：aa6a(2)+类型(1)+柜号(1)+路号(1)+动作(1)+aaa6(2) = 8字节。文档说"aa6a01010102aaa6"是 7 字节？那是样例写错了，还是我数错了。实际按 hex 字符数：aa6a01010102aaa6 一共 14 个字符 → 14/2 = 7 字节。哦！对："aa6a 01 01 01 02 aaa6" 中间有空格，连起来是：aa 6a 01 01 01 02 aa a6 → 8 字节（16个 hex 字符），但文档字符串写的是 aaa6 结尾就是"aa6a01010102aaa6"——我们按字符串"aa6a01010102aaa6"数：a a 6 a 0 1 0 1 0 1 0 2 a a a 6 → 16个 → 8字节。所以文档字节位置 1~6 描述的是概念，实际真实长度是 8 字节。按样例二进制重新写：
function buildCabinetPacketV2({ type, cabinetNo, roadNo, actionByte }){
  const buf = Buffer.alloc(8, 0x00);
  buf[0] = 0xaa; buf[1] = 0x6a;
  buf[2] = (type & 0xff);
  buf[3] = (parseInt(cabinetNo,10) || 1) & 0xff;
  buf[4] = (parseInt(roadNo,10) || 0) & 0xff;
  buf[5] = (parseInt(actionByte,10) || 0) & 0xff;
  buf[6] = 0xaa; buf[7] = 0xa6;
  return buf;
}

// ========== 硅箱 530B 组包（按文档：0~7=0x00,8=0x63,9=0x00,10~13=业务,14=0,其余补0x00） ==========
function buildSiliconPacket({ cmd, siliconNo, road, mode }){
  const buf = Buffer.alloc(530, 0x00);
  buf[8] = 0x63;
  buf[9] = 0x00;
  buf[10] = (parseInt(cmd,10) || 0x01) & 0xff;       // 查询=0x01 / 开=0x02 / 关=0x03
  buf[11] = (parseInt(siliconNo,10) || 1) & 0xff;     // 硅箱序号
  buf[12] = (parseInt(road,10) || 0) & 0xff;          // 单路 1..N / 全部/查询=0x00
  buf[13] = (parseInt(mode,10) || 0) & 0xff;          // 单路0x00 / 一键开0x02(顺序) / 一键关0x01(逆序)
  buf[14] = 0x00; // 发送占位
  return buf;
}

// ========== 通用：找配置 ==========
function findCabinetById(cabinetId){
  const cfg = cabinetCachedConfig || { cabinets:[] };
  const list = cfg && Array.isArray(cfg.cabinets) ? cfg.cabinets : [];
  for(const c of list){ if(c && c.id === cabinetId) return c; }
  return null;
}
function findCabinetByNos({ cabinetNo, siliconNo, ip }){
  const cfg = cabinetCachedConfig || { cabinets:[] };
  const list = cfg && Array.isArray(cfg.cabinets) ? cfg.cabinets : [];
  for(const c of list){
    const ccn = parseInt(c.cabinetNo,10)||1;
    // 统一只按电柜编号匹配（2021 协议的 siliconNo = cabinetNo）
    const pNo = (cabinetNo != null) ? (+cabinetNo) : (siliconNo != null ? (+siliconNo) : null);
    const nOk = (pNo == null) ? true : (ccn === pNo);
    const okIp = (!ip || !c.ip || c.ip === ip);
    if(nOk && okIp) return c;
  }
  return null;
}

// ========== 乐观保护锁（远程 API 缓存层，防止设备 ACK 反向包覆盖用户操作） ==========
// 结构：{ `${cabinetId}|${road}`: { expect: 0|1, expireAt: number } }
const remoteOptimisticLocks = new Map();
const REMOTE_OPTIMISTIC_LOCK_MS = 1500; // 保护期 1.5 秒
// 设置乐观锁 + 立即更新缓存为期望值
function setRemoteOptimistic(cabinetId, road, expectVal){
  const key = `${cabinetId}|${road}`;
  remoteOptimisticLocks.set(key, { expect: expectVal, expireAt: Date.now() + REMOTE_OPTIMISTIC_LOCK_MS });
  // 立即更新缓存为期望值（手机端下次轮询看到的也是期望值）
  const arr = cachedCabinetRuntime.statusMap[String(cabinetId)];
  if(Array.isArray(arr)){
    const sti = road - 1;
    if(sti >= 0 && sti < arr.length) arr[sti] = expectVal;
    cachedCabinetRuntime.updatedAt = Date.now();
  }
}
// 检查是否在保护期内 + 回传值是否匹配期望
function checkRemoteOptimisticLock(cabinetId, road, incomingVal){
  const key = `${cabinetId}|${road}`;
  const lock = remoteOptimisticLocks.get(key);
  if(!lock) return { allow: true, acceptLock: false };
  if(Date.now() > lock.expireAt){
    // 保护期已过，清除锁，允许写入
    remoteOptimisticLocks.delete(key);
    return { allow: true, acceptLock: false };
  }
  // 保护期内：回传值与期望一致 → 确认成功，清除锁
  if(incomingVal === lock.expect){
    remoteOptimisticLocks.delete(key);
    return { allow: true, acceptLock: true };
  }
  // 保护期内 + 回传值≠期望（ACK 反向包/中间态）→ 拒绝写入，保持乐观状态
  return { allow: false, acceptLock: false };
}

// ========== push（只给 cabinetWindow，不给 mainWindow）+ 同步远程 API 缓存 ==========
function pushCabinetStatus(payload){
  try{
    // 同步更新远程 API 缓存（电柜运行状态，应用乐观保护锁）
    if(payload && typeof payload === 'object' && payload.cabinetId){
      const cid = String(payload.cabinetId);
      if(Array.isArray(payload.statuses)){
        // queryResult：批量状态回传，逐路过锁
        const oldArr = cachedCabinetRuntime.statusMap[cid] || [];
        const newArr = payload.statuses.slice();
        // 对每一路应用乐观锁：保护期内且与期望不一致的，保留期望值
        for(let i = 0; i < newArr.length; i++){
          const road = i + 1;
          const incoming = newArr[i];
          if(incoming === 0 || incoming === 1){
            const lockRes = checkRemoteOptimisticLock(cid, road, incoming);
            if(!lockRes.allow){
              // 保护期内拒绝写入，保留旧值（期望值）
              newArr[i] = (i < oldArr.length) ? oldArr[i] : incoming;
            }
          }
        }
        cachedCabinetRuntime.statusMap[cid] = newArr;
        cachedCabinetRuntime.updatedAt = Date.now();
      } else if(payload.type === 'road' && payload.road){
        // 单路状态回传，过锁
        const road = parseInt(payload.road, 10) || 0;
        const incoming = (payload.status === 1 || payload.status === 0) ? payload.status : null;
        if(road > 0 && incoming !== null){
          const lockRes = checkRemoteOptimisticLock(cid, road, incoming);
          if(!lockRes.allow){
            // 保护期内拒绝写入，保留缓存中的期望值，不更新
            // 但仍转发给电柜窗口（窗口有自己的乐观锁逻辑）
          } else {
            // 允许写入：更新缓存的对应路
            const arr = cachedCabinetRuntime.statusMap[cid];
            if(Array.isArray(arr)){
              const sti = road - 1;
              if(sti >= 0 && sti < arr.length) arr[sti] = incoming;
              cachedCabinetRuntime.updatedAt = Date.now();
            }
          }
        }
      } else if(payload.type === 'bulk'){
        // bulk 类型（一键回包）：逐路过锁，防止反向包覆盖
        const incoming = (payload.status === 1 || payload.status === 0) ? payload.status : null;
        if(incoming !== null){
          const arr = cachedCabinetRuntime.statusMap[cid];
          if(Array.isArray(arr)){
            // 不直接覆盖全部，逐路检查锁
            // （由于手机端走逐路发送，bulk 反向包通常是 ACK，保护期内应丢弃）
            let changed = false;
            for(let i = 0; i < arr.length; i++){
              const road = i + 1;
              const lockRes = checkRemoteOptimisticLock(cid, road, incoming);
              if(lockRes.allow){
                arr[i] = incoming;
                changed = true;
              }
            }
            if(changed) cachedCabinetRuntime.updatedAt = Date.now();
          }
        }
      }
    }
    if(cabinetWindow && !cabinetWindow.isDestroyed()){
      cabinetWindow.webContents.send('cabinet-status-push', payload || {});
    }
  }catch(_){}
}
function pushCabinetError(payload){
  try{
    if(cabinetWindow && !cabinetWindow.isDestroyed()){
      cabinetWindow.webContents.send('cabinet-error', payload || {});
    }
  }catch(_){}
}
function pushCabinetInfo(payload){
  try{
    if(cabinetWindow && !cabinetWindow.isDestroyed()){
      cabinetWindow.webContents.send('cabinet-info', payload || {});
    }
  }catch(_){}
}

// ========== 推入 pending ==========
function pushPending(item){
  cabinetPendingList.push(item);
  if(cabinetPendingList.length > MAX_PENDING){
    // FIFO 丢最旧的
    cabinetPendingList.splice(0, cabinetPendingList.length - MAX_PENDING);
  }
}

// ========== 匹配 pending 并移除 ==========
function consumePending(predicate){
  const i = cabinetPendingList.findIndex(predicate);
  if(i >= 0){
    const it = cabinetPendingList[i];
    cabinetPendingList.splice(i, 1);
    return it;
  }
  return null;
}

// ========== 新版电柜回包解析 ==========
function parseCabinetRecv(msg, rinfo){
  const ip = rinfo && rinfo.address;
  try { console.log('[CAB RECV]', ip, msg.length + 'B', msg.toString('hex')); } catch(_) {}
  // msg[2] 类型：0x01/0x02 控制原包回传；0x21 查询回包（文档样例）
  const type = msg[2];
  const cabinetNo = msg[3];
  if(type === 0x21){
    // 查询回包：控制包 msg[4]=roadNo, msg[5]=action；因此查询包状态区从 msg[5] 起才是第1路状态（整体+1偏移，防止第1路错读msg[4]保留/路数字段）
    const maxRoads = 36;
    const statuses = [];
    for(let i=0; i<maxRoads; i++){
      const idx = 5 + i; // ← 关键修复：从 5 开始而不是 4，与控制包字段对齐（msg[4]为保留/路号位，非状态）
      if(idx >= msg.length - 2) break; // 帧尾 2 字节前
      const v = msg[idx];
      if(v === 0x02) statuses[i] = 1;
      else if(v === 0x00) statuses[i] = 0;
      else statuses[i] = -1; // 未知
    }
    const cab = findCabinetByNos({ cabinetNo, ip });
    if(cab) resolvePendingPing(cab.id, true);
    pushCabinetStatus({
      cabinetId: cab ? cab.id : null,
      type: 'queryResult',
      cabinetNo,
      ip,
      statuses, // statuses[i] 对应路号 i+1
    });
    // 查询回包也算一次"所有 pending 都已命中"（对 cabinetNo=这个柜的 pending 都消耗掉）
    consumePending(it => {
      const c = findCabinetById(it.cabinetId);
      return !!(c && (parseInt(c.cabinetNo,10)||1) === (cabinetNo & 0xff) && (!ip || !c.ip || c.ip === ip));
    });
    return;
  }
  if(type === 0x01 || type === 0x02){
    const roadNo = msg[4];
    const action = msg[5];
    const status = action === 0x02 ? 1 : (action === 0x00 ? 0 : -1);
    let cab = findCabinetByNos({ cabinetNo, ip });
    if(cab) resolvePendingPing(cab.id, true);
    const it = consumePending(p => {
      const c = findCabinetById(p.cabinetId);
      if(!c) return false;
      const noMatch = (parseInt(c.cabinetNo,10)||1) === (cabinetNo & 0xff);
      const ipMatch = (!ip || !c.ip || c.ip === ip);
      let roadMatch = false;
      if(p.road === 'all') roadMatch = type === 0x02;
      else roadMatch = (parseInt(p.road,10)||0) === (roadNo & 0xff) && type === 0x01;
      return noMatch && ipMatch && roadMatch;
    });
    const cabinetId = (it && it.cabinetId) || (cab ? cab.id : null);
    if(type === 0x02){
      // 一键 → bulk
      pushCabinetStatus({ cabinetId, type:'bulk', status, roads:'all', cabinetNo, ip });
    } else {
      pushCabinetStatus({ cabinetId, type:'road', road: roadNo, status, cabinetNo, ip });
    }
    return;
  }
}

// ========== 硅箱回包解析 ==========
function parseSiliconRecv(msg, rinfo){
  const ip = rinfo && rinfo.address;
  try { console.log('[SI RECV]', ip, msg.length + 'B', msg.toString('hex')); } catch(_) {}
  const byte8 = msg[8], byte9 = msg[9];
  const cmd = msg[10];          // 0x01查询 / 0x02开 / 0x03关
  const siliconNo = msg[11];
  const road = msg[12];         // 单路 1..N / 查询或全部=0x00
  const _mode = msg[13];
  const devStatus = msg[14];    // 单路控制回包的状态
  const singleStatus = devStatus === 0x02 ? 1 : (devStatus === 0x01 ? 0 : -1);

  // 优先匹配 pending（控制命令原包回传）
  const it = consumePending(p => {
    const c = findCabinetById(p.cabinetId);
    if(!c) return false;
    const siMatch = (parseInt(c.siliconNo,10)||1) === (siliconNo & 0xff);
    const ipMatch = (!ip || !c.ip || c.ip === ip);
    let roadMatch = false;
    if(p.road === 'all') roadMatch = road === 0x00;
    else roadMatch = road !== 0x00 && (parseInt(p.road,10)||0) === (road & 0xff);
    return siMatch && ipMatch && roadMatch;
  });
  const cab = findCabinetByNos({ siliconNo, ip });
  if(cab) resolvePendingPing(cab.id, true);
  const cabinetId = (it && it.cabinetId) || (cab ? cab.id : null);

  if(cmd === 0x01 && road === 0x00){
    // ==== 查询回包：逐个解析多路状态（从 byte15 开始，每路1字节；最多36路，覆盖到 byte50）====
    // 注意：单路控制回包(cmd=0x02/0x03 + road>0)用 byte14 表示单路状态；但查询回包的 byte14 并不是所有路的状态
    const maxRoads = 36;
    const statuses = [];
    for(let i=0;i<maxRoads;i++){
      const idx = 15 + i; // 状态区起点：byte15 = 第1路状态
      if(idx >= msg.length) break;
      const v = msg[idx];
      if(v === 0x02) statuses[i] = 1;
      else if(v === 0x01 || v === 0x00) statuses[i] = 0;
      else statuses[i] = -1;
    }
    pushCabinetStatus({ cabinetId, type:'queryResult', statuses, siliconNo, ip, via:'silicon' });
    // 查询回包消耗这个柜的全部 pending
    consumePending(p => {
      const c = findCabinetById(p.cabinetId);
      return !!(c && (parseInt(c.siliconNo,10)||1) === (siliconNo & 0xff) && (!ip || !c.ip || c.ip === ip));
    });
    return;
  }

  if(road === 0x00 && (cmd === 0x02 || cmd === 0x03)){
    // 一键全开/全关回包：推 bulk（全部路统一状态）
    pushCabinetStatus({ cabinetId, type:'bulk', status: singleStatus, roads:'all', siliconNo, ip, via:'silicon' });
    return;
  }

  // 单路控制回包（road > 0）：推 road 类型
  pushCabinetStatus({ cabinetId, type:'road', road, status: singleStatus, siliconNo, ip, via:'silicon' });
}

// ========== ping 辅助：匹配到 cabId 回包时，立即把 pendingPing 里的 resolve 设 true ==========
function resolvePendingPing(cabinetId, ok){
  try{
    if(!cabinetId) return;
    // 同步更新远程 API 缓存（电柜在线状态）
    cachedCabinetRuntime.onlineMap[String(cabinetId)] = !!ok;
    cachedCabinetRuntime.updatedAt = Date.now();
    const item = pendingPingMap.get(cabinetId);
    if(!item || item.fired) return;
    item.fired = true;
    if(item.timer){ try{ clearTimeout(item.timer); }catch(_){} }
    item.timer = null;
    pendingPingMap.delete(cabinetId);
    try{ item.resolve(!!ok); }catch(_){}
  }catch(_){}
}

// ========== IPC：config / save / send / query ==========
ipcMain.handle('cabinet:get-config', async () => {
  ensureCabinetSockets();
  return { ok: true, config: cabinetCachedConfig || { cabinets:[] }, socketBound: cabinetRecvBoundOk, bindConflict: cabinetRecvBindConflict };
});
ipcMain.handle('cabinet:save-config', async (event, cfg) => {
  cabinetCachedConfig = (cfg && typeof cfg === 'object') ? cfg : null;
  saveCabinetConfigToFile(); // 持久化到 JSON 文件，关闭窗口后下次打开仍然保留
  ensureCabinetSockets();
  return { ok: true };
});

// ========== 新功能数据收集/恢复（控台 + 电柜） ==========
// 主进程缓存：控台窗口未打开时暂存 consoleFeatures，等控台窗口打开后再恢复
let pendingConsoleFeatures = null;

// 获取所有新功能数据（电柜配置 + 控台IP占位）—— 主窗口保存项目时调用
ipcMain.handle('get-all-feature-data', async () => {
  return { cabinetConfig: cabinetCachedConfig || null, consoleConnectIp: null };
});

// 保存所有新功能数据（电柜配置 + 控台功能）—— 主窗口加载项目时调用
ipcMain.handle('set-all-feature-data', async (event, payload) => {
  try {
    const data = (payload && typeof payload === 'object') ? payload : {};
    if (data.cabinetConfig && typeof data.cabinetConfig === 'object') {
      cabinetCachedConfig = data.cabinetConfig;
      saveCabinetConfigToFile(); // 持久化电柜配置到 JSON 文件
    }
    if (data.consoleFeatures) {
      // 控台窗口已打开 → 直接转发恢复；未打开 → 缓存等控台窗口打开时再恢复
      if (consoleWindow && !consoleWindow.isDestroyed()) {
        try { consoleWindow.webContents.send('console-restore-features', data.consoleFeatures); } catch(_) {}
      } else {
        pendingConsoleFeatures = data.consoleFeatures;
      }
    }
    return { ok: true };
  } catch(err) {
    return { ok: false, error: err && err.message || String(err) };
  }
});

// 主窗口请求收集控台功能数据 → 转发给控台窗口（控台未打开则回 null 避免主窗口死等）
ipcMain.on('console-collect-features', () => {
  try {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      consoleWindow.webContents.send('console-collect-features');
    } else {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('console-features-collected', null);
      }
    }
  } catch(_) {}
});

// 控台窗口回包收集到的功能数据 → 转发给主窗口
ipcMain.on('console-features-collected', (event, data) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('console-features-collected', data);
    }
  } catch(_) {}
});

// 主窗口请求恢复控台功能数据 → 转发给控台窗口（未打开则缓存）
ipcMain.on('console-restore-features', (event, data) => {
  try {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      consoleWindow.webContents.send('console-restore-features', data);
    } else {
      pendingConsoleFeatures = data;
    }
  } catch(_) {}
});
// ========== 电柜指令发送核心逻辑（IPC 和 HTTP 远程控制共用） ==========
function buildArtNetPacket(universe, dmxBuf){
  // Art-Net ArtDmx 包：12字节头 + 4字节(协议版/Seq/Phys) + 2字节(Universe) + 2字节(Length) + 512字节DMX = 530字节
  const pkt = Buffer.alloc(18 + 512);
  // ID: "Art-Net\0"
  pkt.write('Art-Net\0', 0, 8, 'ascii');
  // OpCode: 0x5000 (ArtDmx) little-endian
  pkt.writeUInt16LE(0x5000, 8);
  // ProtocolVersion: 14 (0x000e) big-endian
  pkt.writeUInt16BE(0x000e, 10);
  // Sequence: 0 (disable)
  pkt[12] = 0x00;
  // Physical: 0
  pkt[13] = 0x00;
  // Universe: 15-bit, little-endian (low byte=sub+uni(0-255), high byte=net 0)
  pkt.writeUInt16LE(universe & 0x7fff, 14);
  // Length: 512 (0x0200) big-endian
  pkt.writeUInt16BE(0x0200, 16);
  // DMX data (512 bytes)
  dmxBuf.copy(pkt, 18, 0, 512);
  return pkt;
}
function sendCabinetCommand(payload){
  ensureCabinetSockets();
  if(!payload || !payload.cabinetId) return { ok:false, error:'缺少 cabinetId' };
  const cab = findCabinetById(payload.cabinetId);
  if(!cab) return { ok:false, error:'cabinetId 未找到，请先保存配置' };
  const ip = cab.ip;
  if(!ip) return { ok:false, error:'电柜IP为空' };
  const cabinetNo = parseInt(cab.cabinetNo,10) || 1;
  const proto = String(cab.protocolVersion || '2023');
  const road = (payload.road === 'all') ? 'all' : (parseInt(payload.road,10) || 0);
  const action = payload.action;
  if(!['on','off'].includes(action)) return { ok:false, error:'action 必须 on/off' };
  const switchCount = parseInt(cab.switchCount,10) || 12;
  if(road !== 'all' && (road < 1 || road > switchCount)) return { ok:false, error:`road 范围 1..${switchCount} 或 all` };

  const sent = { cab:false, si:false, artnet:false };

  if(proto === 'ARTNET'){
    // ART-NET 协议：通过 UDP 发送标准 ArtDmx 帧到 6454 端口（官方默认端口）
    const universe = (cab.artnetUniverse != null) ? (parseInt(cab.artnetUniverse,10)||0) : 0;
    const startAddr = (cab.artnetStartAddress != null) ? (parseInt(cab.artnetStartAddress,10)||1) : 1;
    // 用户可配置的开/关数值（默认开 255 / 关 0）
    const onValue  = (cab.artnetOnValue  != null && !isNaN(parseInt(cab.artnetOnValue,10)))  ? (parseInt(cab.artnetOnValue,10)  & 0xFF) : 0xFF;
    const offValue = (cab.artnetOffValue != null && !isNaN(parseInt(cab.artnetOffValue,10))) ? (parseInt(cab.artnetOffValue,10) & 0xFF) : 0x00;
    const key = `${ip}:${universe}`;
    let dmx = artnetDmxCache.get(key);
    if(!dmx){ dmx = Buffer.alloc(512, 0x00); artnetDmxCache.set(key, dmx); }
    const val = (action === 'on') ? onValue : offValue;
    const dmxOff = startAddr - 1; // DMX512 下标 0-based
    if(road === 'all'){
      for(let i=0; i<switchCount; i++){
        const off = dmxOff + i;
        if(off >= 0 && off < 512) dmx[off] = val;
      }
    } else {
      const off = dmxOff + (road - 1);
      if(off >= 0 && off < 512) dmx[off] = val;
    }
    const artPkt = buildArtNetPacket(universe, dmx);
    try {
      unifiedRecvSocket.send(artPkt, 0, artPkt.length, 6454, ip, (err) => {
        if(err){ pushCabinetError({ code:'SEND_ARTNET_FAIL', message:'ARTNET 包发送失败：' + (err && err.message || '') }); }
      });
      sent.artnet = true;
    } catch(e){
      pushCabinetError({ code:'SEND_ARTNET_FAIL', message:'ARTNET 包发送异常：' + (e && e.message || '') });
    }
    // ARTNET 单向协议：发送完立刻持久化本地 DMX 状态，跨窗口/重启都能恢复
    saveArtnetDmxStateSoon();
  } else if(proto === '2023'){
    let cabType, cabRoad, cabAction;
    if(road === 'all'){
      cabType = 0x02; cabRoad = 0x00; cabAction = action==='on' ? 0x02 : 0x00;
    } else {
      cabType = 0x01; cabRoad = road & 0xff; cabAction = action==='on' ? 0x02 : 0x00;
    }
    const cabBuf = buildCabinetPacketV2({ type: cabType, cabinetNo, roadNo: cabRoad, actionByte: cabAction });
    try {
      unifiedRecvSocket.send(cabBuf, 0, cabBuf.length, 2023, ip, (err) => {
        if(err){ pushCabinetError({ code:'SEND_CAB_FAIL', message:'电柜包发送失败：' + (err && err.message || '') }); }
      });
      sent.cab = true;
    } catch(e){
      pushCabinetError({ code:'SEND_CAB_FAIL', message:'电柜包发送异常：' + (e && e.message || '') });
    }
  } else {
    let siCmd, siRoad, siMode;
    if(road === 'all'){
      siCmd = action === 'on' ? 0x02 : 0x03;
      siRoad = 0x00;
      siMode = action === 'on' ? 0x02 : 0x01;
    } else {
      siCmd = action === 'on' ? 0x02 : 0x03;
      siRoad = road & 0xff;
      siMode = 0x00;
    }
    const siBuf = buildSiliconPacket({ cmd: siCmd, siliconNo: cabinetNo, road: siRoad, mode: siMode });
    try {
      unifiedRecvSocket.send(siBuf, 0, siBuf.length, 2021, ip, (err) => {
        if(err){ pushCabinetError({ code:'SEND_SI_FAIL', message:'硅箱包发送失败：' + (err && err.message || '') }); }
      });
      sent.si = true;
    } catch(e){
      pushCabinetError({ code:'SEND_SI_FAIL', message:'硅箱包发送异常：' + (e && e.message || '') });
    }
  }

  // 只有 2023/2021 双协议才推入 pending 等待回包/超时提醒
  // ARTNET 单向协议不等待设备回传，渲染进程已经本地更新了状态，不能再推送 timeout 覆盖
  if(proto !== 'ARTNET'){
    pushPending({
      ts: Date.now(),
      expireAt: Date.now() + 1000,
      cabinetId: cab.id,
      road: road,
      action: action,
    });
  }

  return { ok:true, sent, cabinetName: cab.name || payload.cabinetId, road, action };
}

ipcMain.handle('cabinet:send', async (event, payload) => {
  try{
    return sendCabinetCommand(payload);
  }catch(err){
    return { ok:false, error: err && err.message || String(err) };
  }
});
ipcMain.handle('cabinet:query', async (event, cabinetId) => {
  try{
    ensureCabinetSockets();
    const cab = findCabinetById(cabinetId);
    if(!cab) return { ok:false, error:'cabinetId 未找到' };
    const ip = cab.ip;
    if(!ip) return { ok:false, error:'电柜IP为空' };
    const cabinetNo = parseInt(cab.cabinetNo,10) || 1;
    const proto = String(cab.protocolVersion || '2023');

    if(proto === 'ARTNET'){
      // ART-NET：单向协议，不发包不等回包。直接把 artnetDmxCache 的状态转为 statuses
      const universe = (cab.artnetUniverse != null) ? (parseInt(cab.artnetUniverse,10)||0) : 0;
      const startAddr = (cab.artnetStartAddress != null) ? (parseInt(cab.artnetStartAddress,10)||1) : 1;
      const cnt = parseInt(cab.switchCount,10) || 12;
      // 用户配置的开/关数值（默认 255/0），状态判断阈值取两者中点
      const onValue  = (cab.artnetOnValue  != null && !isNaN(parseInt(cab.artnetOnValue,10)))  ? (parseInt(cab.artnetOnValue,10)  & 0xFF) : 0xFF;
      const offValue = (cab.artnetOffValue != null && !isNaN(parseInt(cab.artnetOffValue,10))) ? (parseInt(cab.artnetOffValue,10) & 0xFF) : 0x00;
      const threshold = (onValue + offValue) / 2;
      const key = `${ip}:${universe}`;
      const dmx = artnetDmxCache.get(key);
      const statuses = [];
      for(let i=0;i<cnt;i++){
        const off = (startAddr - 1) + i;
        let v = 0;
        if(dmx && off >=0 && off < 512){
          // 用用户配置的开/关数值中点作为开/关判断阈值
          v = dmx[off] > threshold ? 1 : 0;
        }
        statuses.push(v);
      }
      return { ok:true, statuses, offline: 0, online: 1, note: 'ARTNET 单向协议，状态为本地记忆' };
    }

    if(proto === '2023'){
      // 2023 新版电柜查询
      const cabBuf = buildCabinetPacketV2({ type:0x04, cabinetNo, roadNo:0x00, actionByte:0x00 });
      try { console.log('[CABINET QUERY 2023]', 'ip='+ip, 'cabinetNo='+cabinetNo, 'cab(port2023)='+cabBuf.toString('hex')); } catch(_) {}
      try{ unifiedRecvSocket.send(cabBuf, 0, cabBuf.length, 2023, ip); }catch(_){}
    } else {
      // 2021 硅箱查询：cmd=0x01，路=0x00，模式=0x00
      const siBuf = buildSiliconPacket({ cmd:0x01, siliconNo: cabinetNo, road:0x00, mode:0x00 });
      try { console.log('[CABINET QUERY 2021]', 'ip='+ip, 'cabinetNo='+cabinetNo+'(as siliconNo)', 'si(port2021)='+siBuf.toString('hex')); } catch(_) {}
      try{ unifiedRecvSocket.send(siBuf, 0, siBuf.length, 2021, ip); }catch(_){}
    }
    // 查询同样给 1000ms 超时（只提示 timeout，不闪黄按钮也不影响）
    pushPending({
      ts: Date.now(),
      expireAt: Date.now() + 1000,
      cabinetId: cab.id,
      road: 'all',
      action: 'query',
    });
    return { ok:true };
  }catch(err){
    return { ok:false, error: err && err.message || String(err) };
  }
});
ipcMain.handle('cabinet:ping', async (event, cabinetId) => {
  // 给 UI 用：15 秒在线心跳。ART-NET 单向协议直接返回 online=true（本地缓存即在线），不发包不等待回包。
  try{
    ensureCabinetSockets();
    const cab = findCabinetById(cabinetId);
    if(!cab) return { ok:false, online:false, error:'cabinetId 未找到' };
    const ip = cab.ip;
    if(!ip) return { ok:false, online:false, error:'电柜IP为空' };
    const proto = String(cab.protocolVersion || '2023');

    if(proto === 'ARTNET'){
      // ART-NET：不需要在线心跳，永远当作在线（状态完全本地记忆）
      return { ok:true, online:true, artnet:true };
    }

    const cabinetNo = parseInt(cab.cabinetNo,10) || 1;
    // 如果已经有同 cabinetId 在跑的 ping：先把旧的强制 false 结束，避免重复 timer
    try{
      const prev = pendingPingMap.get(cab.id);
      if(prev && !prev.fired){
        prev.fired = true;
        if(prev.timer){ try{ clearTimeout(prev.timer); }catch(_){} prev.timer = null; }
        pendingPingMap.delete(cab.id);
        try{ prev.resolve(false); }catch(_){}
      }
    }catch(_){}
    const result = await new Promise((resolve) => {
      const state = { fired:false, timer:null, resolve };
      state.timer = setTimeout(() => {
        try{
          if(state.fired) return;
          state.fired = true;
          state.timer = null;
          pendingPingMap.delete(cab.id);
          try{ resolve(false); }catch(_){}
        }catch(_){}
      }, PING_TIMEOUT_MS);
      if(state.timer && state.timer.unref) state.timer.unref();
      pendingPingMap.set(cab.id, state);
      // 发送查询包（与 cabinet:query 一致）
      try{
        if(proto === '2023'){
          const cabBuf = buildCabinetPacketV2({ type:0x04, cabinetNo, roadNo:0x00, actionByte:0x00 });
          try{ unifiedRecvSocket.send(cabBuf, 0, cabBuf.length, 2023, ip); }catch(_){}
        } else {
          const siBuf = buildSiliconPacket({ cmd:0x01, siliconNo: cabinetNo, road:0x00, mode:0x00 });
          try{ unifiedRecvSocket.send(siBuf, 0, siBuf.length, 2021, ip); }catch(_){}
        }
      }catch(_){
        // 发送异常：直接判 offline，保证不 hang
        try{
          if(state.fired) return;
          state.fired = true;
          if(state.timer){ try{ clearTimeout(state.timer); }catch(_){} state.timer = null; }
          pendingPingMap.delete(cab.id);
          try{ resolve(false); }catch(_){}
        }catch(__){}
      }
    });
    return { ok:true, online: !!result };
  }catch(err){
    return { ok:false, online:false, error: err && err.message || String(err) };
  }
});
