/**
 * AudioViz —— 主界面播放进度条背面的动态音频可视化（强化版）
 * ---------------------------------------------------------------
 * 入口：
 *   AudioViz.attach(progressBarWrapperElement)
 *   AudioViz.onPlay(audioElement)
 *   AudioViz.onPause()
 *   AudioViz.onStop()
 *   AudioViz.setConfig({ series, colorway })   // 设置面板实时调用
 *   AudioViz.getConfig()
 *
 * 配置（用户在设置面板选择）：
 *   series   系列 / 风格系列
 *      'bars'        柱子系列（bars / bars-glow / tape-wave / mirror 里随机）
 *      'wave'        波浪系列（wave 强化版 + radial-ring 波感 里随机）
 *      'particles'   粒子系列（particles 强化版 + tape-wave 带粒子点缀 里随机）
 *      'mixed'       综合随机（全部 8 种随机 = 之前行为）
 *   colorway 配色方案（6 种）：
 *      'rainbow'   彩虹（默认）
 *      'theme'     主题色（读取 CSS var(--theme-color)）
 *      'dopamine'  多巴胺（高饱和撞色，粉/橙/黄/青/蓝/紫渐变）
 *      'red-white'    红白渐变
 *      'green-white'  绿白渐变
 *      'blue-white'   蓝白渐变
 *
 * 默认 = 柱子 + 彩虹
 */
(function(global) {
  'use strict';

  // ===== 配置常量 =====
  // 原 8 种 + 本次新增 11 种（liquid 3 / neon 3 / aurora 3 / blocks 3）= 共 19 种
  const ALL_STYLES = ['bars', 'bars-glow', 'wave', 'mirror', 'tape-wave', 'rainbow', 'particles', 'radial-ring',
    // A. 液态/流体
    'liquid-blob', 'wave-stack', 'ripple',
    // B. 霓虹EQ
    'equalizer', 'circular-flat', 'v-meters',
    // C. 极光/漩涡
    'aurora-flow', 'galaxy-spiral', 'pulse-rings',
    // D. 方块/点阵
    'matrix-rain', 'blocks-fall', 'dot-grid'];
  const SERIES_POOLS = {
    bars:        ['bars', 'bars-glow', 'mirror', 'tape-wave'],
    wave:        ['wave', 'radial-ring', 'mirror', 'bars-glow'],
    particles:   ['particles'],
    // ===== 新增 4 个系列 =====
    liquid:      ['liquid-blob', 'wave-stack', 'ripple'],
    neon:        ['equalizer', 'circular-flat', 'v-meters'],
    aurora:      ['aurora-flow', 'galaxy-spiral', 'pulse-rings'],
    blocks:      ['matrix-rain', 'blocks-fall', 'dot-grid'],
    mixed:       ALL_STYLES
  };
  const COLORWAYS = ['rainbow', 'theme', 'dopamine', 'red-white', 'green-white', 'blue-white'];
  // 允许的系列值（设置面板校验用）
  const VALID_SERIES = Object.keys(SERIES_POOLS);

  // 多巴胺色板（高饱和 6 色）
  const DOPAMINE_PALETTE = ['#ff3d7f', '#ff8a3d', '#ffd93d', '#3dffa7', '#3db5ff', '#a73dff'];

  const AudioViz = {
    // 配置
    series: 'bars',
    colorway: 'rainbow',
    // 外部可见状态
    canvas: null, ctx: null, mountedEl: null,
    style: 'bars',
    isPlaying: false,
    // 内部
    rafId: null, dpr: 1, w: 0, h: 0,
    freqBuf: null, timeBuf: null,
    particles: [], tapeHeights: null,
    prevStyle: '', blend: 1, _blendStart: 0,
    lastEnergy: 0,
    debug: true,

    attach: function(progressWrapper) {
      if (!progressWrapper || this.canvas) return;
      const self = this;
      self.mountedEl = progressWrapper;
      // ===== 用户要求：视觉不能超出进度条界面外，所以：=====
      // - 取消之前 padding:±40 外扩方案
      // - 父容器 overflow:hidden（严格把 canvas 裁切在进度条区域内）
      // - canvas 完全贴合父容器 content box (inset:0, width/height 100%)
      // - 后面所有渲染函数都会按 safePad 规则进一步压缩，保证视觉元素不贴边
      try {
        const cs = global.getComputedStyle(progressWrapper);
        if (!cs.position || cs.position === 'static') progressWrapper.style.position = 'relative';
        progressWrapper.style.overflow = 'hidden';
        // 清理旧的外扩样式（避免影响已运行窗口 reload）
        progressWrapper.style.paddingTop    = '';
        progressWrapper.style.paddingBottom = '';
        progressWrapper.style.marginTop     = '';
        progressWrapper.style.marginBottom  = '';
      } catch (_) {}
      const canvas = document.createElement('canvas');
      canvas.className = 'audio-viz-canvas';
      canvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; z-index:0; pointer-events:none; display:block; opacity:0.96;';
      if (progressWrapper.firstChild) progressWrapper.insertBefore(canvas, progressWrapper.firstChild);
      else progressWrapper.appendChild(canvas);
      const bar = progressWrapper.querySelector('#progressBar, .progress-bar');
      if (bar) { bar.style.position = 'relative'; bar.style.zIndex = '1'; }
      ['#timeInfo', '.time-info', '#currentTitle', '.now-playing-title'].forEach(function(sel){
        const el = progressWrapper.querySelector(sel);
        if (el && el.style) {
          if (global.getComputedStyle(el).position === 'static') el.style.position = 'relative';
          el.style.zIndex = '1';
        }
      });
      self.canvas = canvas;
      self.ctx = canvas.getContext('2d');
      self._resize();
      global.addEventListener('resize', function(){ self._resize(); });
      if (global.ResizeObserver) {
        try {
          const ro = new global.ResizeObserver(function(){ self._resize(); });
          ro.observe(progressWrapper);
        } catch(_) {}
      }
      self.freqBuf = new Uint8Array(256);
      self.timeBuf = new Uint8Array(2048);
      self.tapeHeights = new Float32Array(64);
      self._loadConfig();
      // 初始从系列里挑一个风格（避免 undefined）
      self.pickStyleFromSeries(true);
      self.prevStyle = self.style;
      self._startLoop();
      // ===== 首次尺寸兜底：布局是异步的，DOMContentLoaded 时 canvas rect 往往是 0 =====
      // 多次延迟重算，确保首次播放前 canvas 尺寸已经正确
      [80, 260, 600, 1200].forEach(function(delay){
        try { global.setTimeout(function(){ if (self && self.canvas) self._resize(); }, delay); } catch(_){}
      });
      return self;
    },

    _loadConfig: function() {
      const self = this;
      try {
        const raw = (global.localStorage && global.localStorage.getItem('audioVizConfig')) ? global.localStorage.getItem('audioVizConfig') : null;
        if (raw) {
          let cfg;
          try { cfg = JSON.parse(raw); } catch(_) { cfg = null; }
          if (cfg && typeof cfg === 'object') {
            if (cfg.series && SERIES_POOLS[cfg.series]) self.series = cfg.series;
            if (cfg.colorway && COLORWAYS.indexOf(cfg.colorway) >= 0) self.colorway = cfg.colorway;
            return;
          }
        }
      } catch(_) {}
      // 默认 = 柱子 + 彩虹
      self.series = 'bars';
      self.colorway = 'rainbow';
    },

    _saveConfig: function() {
      try {
        if (global.localStorage) {
          global.localStorage.setItem('audioVizConfig', JSON.stringify({
            series: this.series,
            colorway: this.colorway
          }));
        }
      } catch(_) {}
    },

    /** 外部设置面板调用 */
    setConfig: function(opts) {
      const self = this;
      if (!opts || typeof opts !== 'object') return;
      let changed = false;
      if (opts.series && SERIES_POOLS[opts.series] && opts.series !== self.series) {
        self.series = opts.series;
        self.pickStyleFromSeries(true); // 系列切换立刻换风格
        changed = true;
      }
      if (opts.colorway && COLORWAYS.indexOf(opts.colorway) >= 0 && opts.colorway !== self.colorway) {
        self.colorway = opts.colorway;
        changed = true;
      }
      // 始终保存（即使值相同），防止旧配置残留导致下次加载读到错误值
      self._saveConfig();
      if (self.debug) console.log('[AudioViz] setConfig → 系列=' + self.series + ', 配色=' + self.colorway);
    },

    getConfig: function() {
      return { series: this.series, colorway: this.colorway };
    },

    _resize: function() {
      const self = this;
      if (!self.canvas || !self.mountedEl) return;
      const rect = self.canvas.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(3, global.devicePixelRatio || 1));
      self.dpr = dpr;
      // ===== 现在 canvas 用 inset:0 100% 填父容器（父容器 padding 上下各 40px 已把外扩算进盒模型）=====
      // canvas.getBoundingClientRect() 直接就是精确的像素尺寸；
      // 仍做多层兜底，避免 layout 没完成时为 0。
      let cssW = Math.floor(rect.width);
      let cssH = Math.floor(rect.height);
      if (cssW < 50) {
        try { cssW = Math.max(cssW, self.canvas.offsetWidth || self.mountedEl.clientWidth || self.mountedEl.offsetWidth || 0); } catch(_) {}
      }
      if (cssH < 50) {
        // clientHeight 已经包含 paddingTop/paddingBottom(40*2)，所以直接用，不用再加 80
        try { cssH = Math.max(cssH, self.canvas.offsetHeight || self.mountedEl.clientHeight || self.mountedEl.offsetHeight || 0); } catch(_) {}
      }
      // 最终兜底：整窗还没展开
      if (cssW < 50) {
        try { cssW = Math.max(1, Math.floor((global.innerWidth || 1200) * 0.65)); } catch(_){ cssW = 800; }
      }
      if (cssH < 50) cssH = 110; // 进度条域 30 + 上下外扩40+40 = 110
      cssW = Math.max(1, cssW);
      cssH = Math.max(1, cssH);
      if (self.w !== cssW || self.h !== cssH) {
        self.w = cssW; self.h = cssH;
        self.canvas.width = Math.floor(cssW * dpr);
        self.canvas.height = Math.floor(cssH * dpr);
      }
      if (self.ctx) self.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      self.blend = 1;
    },

    onPlay: function(audioEl) {
      const self = this;
      self.isPlaying = true;
      if (audioEl && global.SharedAudioCore && typeof global.SharedAudioCore.ensure === 'function') {
        global.SharedAudioCore.ensure(audioEl);
      }
      // ===== 关键修复：每次 onPlay（特别是第一次切歌）强制 _resize =====
      try { self._resize(); } catch(_) {}
      // ===== 每次播放前重新从 localStorage 读取最新配置，确保用户设置生效 =====
      try { self._loadConfig(); } catch(_) {}
      // 切歌/播放：从用户选的系列里随机挑风格（避免和上一首重复）
      self.pickStyleFromSeries(true);
      if (self.debug) console.log('[AudioViz] onPlay → 系列=' + self.series + ', 风格=' + self.style + ', 配色=' + self.colorway + ', size=' + self.w + 'x' + self.h);
    },

    onPause: function() { this.isPlaying = false; },
    onStop: function() { this.isPlaying = false; },

    /** 根据当前系列挑一个风格 */
    pickStyleFromSeries: function(avoidRepeat) {
      const self = this;
      const pool = (SERIES_POOLS[self.series] || SERIES_POOLS.mixed).slice();
      if (avoidRepeat && pool.length > 1) {
        const idx = pool.indexOf(self.style);
        if (idx >= 0) pool.splice(idx, 1);
      }
      const s = pool[Math.floor(Math.random() * pool.length)];
      if (s !== self.style) {
        self.prevStyle = self.style;
        self.style = s;
        self.blend = 0;
        self._blendStart = performance.now();
        try { if (global.localStorage) global.localStorage.setItem('audioVizStyle', s); } catch(_) {}
        if (self.debug) console.log('[AudioViz] 切换风格: ' + self.prevStyle + ' → ' + self.style);
      }
    },

    _startLoop: function() {
      const self = this;
      if (self.rafId) return;
      const loop = function() {
        self._renderFrame();
        self.rafId = requestAnimationFrame(loop);
      };
      self.rafId = requestAnimationFrame(loop);
    },

    _sampleFFT: function() {
      const self = this;
      const sc = global.SharedAudioCore;
      if (sc && sc.getFreqBytes) sc.getFreqBytes(self.freqBuf);
      if (sc && sc.getTimeBytes) sc.getTimeBytes(self.timeBuf);
      const e = (sc && sc.getAvgEnergy) ? sc.getAvgEnergy() : 0;
      if (!self.isPlaying || e < 0.002) {
        self.lastEnergy = Math.max(0, self.lastEnergy * 0.94 - 0.0005);
        for (let i = 0; i < self.freqBuf.length; i++) self.freqBuf[i] = (self.freqBuf[i] | 0) * 0.94;
      } else {
        self.lastEnergy = e;
      }
      return self.lastEnergy;
    },

    _renderFrame: function() {
      const self = this;
      if (!self.ctx) return;
      const ctx = self.ctx;
      const w = self.w, h = self.h;
      // ====== 全局安全区：上下各 12% 留白（严格不穿出进度条界面外，也不与标题/时间挤压）======
      // 所有渲染函数统一用这对 safePad / hSafe / wSafe，集体高度按 ≤ 76% 内分布压缩
      const safePad = Math.max(4, Math.floor(h * 0.12));
      const hSafe   = h - safePad * 2;
      const wSafe   = w - Math.max(2, Math.floor(w * 0.01)) * 2;
      const energy = self._sampleFFT();
      ctx.clearRect(0, 0, w, h);
      if (self.blend < 1) {
        const t = Math.min(1, (performance.now() - (self._blendStart || 0)) / 600);
        self.blend = easeOutCubic(t);
      }
      // 把 safePad 挂到 self 上，renderStyle / 具体 draw 都能读
      self._safePad = safePad; self._hSafe = hSafe; self._wSafe = wSafe;
      const ctxW = w, ctxH = h;
      if (self.prevStyle !== self.style && self.blend < 1) {
        ctx.globalAlpha = 1 - self.blend;
        self._renderStyle(self.prevStyle, ctx, ctxW, ctxH, energy);
        ctx.globalAlpha = self.blend;
        self._renderStyle(self.style, ctx, ctxW, ctxH, energy);
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = 1;
        self._renderStyle(self.style, ctx, ctxW, ctxH, energy);
      }
    },

    // 便捷 helper：渲染函数开头读一下这 3 个值（默认在 _renderFrame 已设置）
    _getSafeBox: function() {
      const self = this;
      // 万一没被渲染循环调用到（未来 API 扩展），兜底给值
      const safePad = self._safePad != null ? self._safePad : Math.max(4, Math.floor(self.h * 0.12));
      const hSafe   = self._hSafe   != null ? self._hSafe   : Math.max(1, self.h - safePad * 2);
      const wSafe   = self._wSafe   != null ? self._wSafe   : Math.max(1, self.w - Math.max(2, Math.floor(self.w * 0.01)) * 2);
      return { safePad: safePad, hSafe: hSafe, wSafe: wSafe };
    },

    _renderStyle: function(style, ctx, w, h, energy) {
      const self = this;
      switch (style) {
        case 'bars':        self._drawBars(ctx, w, h, energy, { glow:false, mirror:false }); break;
        case 'bars-glow':   self._drawBars(ctx, w, h, energy, { glow:true,  mirror:false }); break;
        case 'mirror':      self._drawBars(ctx, w, h, energy, { glow:false, mirror:true  }); break;
        case 'rainbow':     self._drawBars(ctx, w, h, energy, { glow:false, mirror:false, forceRainbow:true }); break;
        case 'wave':        self._drawWave(ctx, w, h, energy); break;
        case 'tape-wave':   self._drawTapeWave(ctx, w, h, energy); break;
        case 'radial-ring': self._drawRadialRing(ctx, w, h, energy); break;
        case 'particles':   self._drawParticles(ctx, w, h, energy); break;
        // A. 液态/流体
        case 'liquid-blob': self._drawLiquidBlob(ctx, w, h, energy); break;
        case 'wave-stack':  self._drawWaveStack(ctx, w, h, energy); break;
        case 'ripple':      self._drawRipple(ctx, w, h, energy); break;
        // B. 霓虹/EQ
        case 'equalizer':   self._drawEqualizer(ctx, w, h, energy); break;
        case 'circular-flat': self._drawCircularFlat(ctx, w, h, energy); break;
        case 'v-meters':    self._drawVMeters(ctx, w, h, energy); break;
        // C. 极光/漩涡
        case 'aurora-flow': self._drawAuroraFlow(ctx, w, h, energy); break;
        case 'galaxy-spiral': self._drawGalaxySpiral(ctx, w, h, energy); break;
        case 'pulse-rings': self._drawPulseRings(ctx, w, h, energy); break;
        // D. 方块/点阵
        case 'matrix-rain': self._drawMatrixRain(ctx, w, h, energy); break;
        case 'blocks-fall': self._drawBlocksFall(ctx, w, h, energy); break;
        case 'dot-grid':    self._drawDotGrid(ctx, w, h, energy); break;
        default:            self._drawBars(ctx, w, h, energy, { glow:false, mirror:false });
      }
    },

    // ===== 1. 柱子系列（bars / bars-glow / mirror / rainbow）=====
    _drawBars: function(ctx, w, h, energy, flags) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const N = 96;
      const xStart = Math.floor((w - wSafe) / 2);
      const gap = Math.max(1, Math.floor(wSafe / 480));
      const barW = Math.max(2, (wSafe - gap * (N + 1)) / N);
      const yFloor = safePad + hSafe;           // 安全区底部（柱子底边）
      const baseY  = flags.mirror ? (safePad + hSafe / 2) : (yFloor);
      const maxH   = flags.mirror ? (hSafe * 0.44) : (hSafe * 0.70); // 柱子高度压缩到 ≤70%，镜像 ≤44%（严格不穿出）
      const cw = self.colorway;
      const forceRainbow = !!flags.forceRainbow || cw === 'rainbow';

      for (let i = 0; i < N; i++) {
        const freqIdx = Math.floor(i / N * 180);
        let v = fb[freqIdx] / 255;
        v = Math.min(1, v * 1.25 + energy * 0.3 + 0.02);
        const bh = Math.max(1, Math.floor(v * maxH));
        const x = xStart + Math.floor(gap + i * (barW + gap));
        const colorInfo = pickBarColor(i, N, cw, forceRainbow);
        const color = colorInfo.color;
        if (flags.glow || colorInfo.glow) {
          ctx.shadowColor = color;
          ctx.shadowBlur = 8 + v * 14;
        } else {
          ctx.shadowBlur = 0;
        }
        const r = Math.max(1, Math.floor(barW / 2));
        if (flags.mirror) {
          const grd = buildBarGradient(ctx, x, baseY - bh, x, baseY + bh, colorInfo, v);
          ctx.fillStyle = grd;
          roundRect(ctx, x, baseY - bh, barW, bh, r); ctx.fill();
          const grd2 = buildBarGradient(ctx, x, baseY, x, baseY + bh, colorInfo, v, true);
          ctx.fillStyle = grd2;
          roundRect(ctx, x, baseY,     barW, bh, r); ctx.fill();
        } else {
          const grd = buildBarGradient(ctx, x, baseY - bh, x, baseY, colorInfo, v);
          ctx.fillStyle = grd;
          roundRect(ctx, x, baseY - bh, barW, bh, r);
          ctx.fill();
        }
      }
      ctx.shadowBlur = 0;
    },

    // ===== 2. 波浪系列（强化版）=====
    _drawWave: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const tb = self.timeBuf;
      const cw = self.colorway;
      const mid  = safePad + hSafe * 0.58;
      // 振幅压缩到 hSafe 的 44% 内（高度限制下不穿出）
      const ampBase = hSafe * (0.20 + energy * 0.24);
      const L = tb.length;

      for (let layer = 2; layer >= 0; layer--) {
        const ampScale = [1.0, 0.7, 0.42][layer];
        const offsetX = (layer - 1) * 4;
        const amp = ampBase * ampScale;
        ctx.beginPath();
        for (let x = 0; x < w; x++) {
          let i = Math.floor((x + offsetX) / w * L);
          if (i < 0) i = 0; else if (i >= L) i = L - 1;
          const val = (tb[i] - 128) / 128;
          const t = performance.now() / 900 + layer * 1.3;
          const ambient = Math.sin((x / w) * Math.PI * 4 + t) * (0.06 + energy * 0.08);
          const y = mid + (val + ambient) * amp;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.lineTo(w, safePad + hSafe); ctx.lineTo(0, safePad + hSafe); ctx.closePath();
        const col = pickWaveColor(layer, cw, 0.55 - layer * 0.12);
        ctx.fillStyle = col;
        ctx.fill();
      }

      // 2.2 中间层：双层轮廓线（清晰线条）
      for (let layer = 0; layer < 2; layer++) {
        ctx.beginPath();
        const ampScale = (layer === 0) ? 0.95 : 0.6;
        const amp = ampBase * ampScale;
        const midOff = (layer === 0) ? 0 : - hSafe * 0.04;
        for (let x = 0; x < w; x++) {
          const i = Math.floor(x / w * L);
          const val = (tb[i] - 128) / 128;
          const t = performance.now() / 1000 + layer * 2;
          const ambient = Math.sin((x / w) * Math.PI * 3 + t) * (0.05 + energy * 0.05);
          const y = mid + midOff + (val + ambient) * amp;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        const lineCol = pickWaveColor(layer, cw, layer === 0 ? 0.95 : 0.55);
        ctx.strokeStyle = lineCol;
        ctx.lineWidth = (layer === 0) ? 2.4 : 1.3;
        ctx.stroke();
      }

      // 2.3 顶层：一条最亮的主波线（带发光）
      ctx.beginPath();
      const mainAmp = ampBase * 1.05;
      for (let x = 0; x < w; x++) {
        const i = Math.floor(x / w * L);
        const val = (tb[i] - 128) / 128;
        const ambient = Math.sin((x / w) * Math.PI * 6 + performance.now() / 700) * (0.07 + energy * 0.06);
        const y = mid + (val + ambient) * mainAmp;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      const glowColor = pickWaveColor(0, cw, 1);
      ctx.shadowColor = stripAlpha(glowColor);
      ctx.shadowBlur = 8 + energy * 18;
      ctx.strokeStyle = glowColor;
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.shadowBlur = 0;
    },

    // ===== 3. 磁带波动 =====
    _drawTapeWave: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const N = 64;
      const gap = 2;
      const xStart = Math.floor((w - wSafe) / 2);
      const barW = Math.max(2, (wSafe - gap * (N + 1)) / N);
      const fb = self.freqBuf;
      const peak = Math.max(0.04, energy + 0.04);
      if (!self._tapeTick) self._tapeTick = 0;
      self._tapeTick++;
      if (self._tapeTick % 2 === 0) {
        for (let i = 0; i < N; i++) {
          const freqIdx = Math.floor(i / N * 180);
          const v = fb[freqIdx] / 255;
          const target = Math.min(1, v * 1.15 + peak);
          if (target > self.tapeHeights[i]) self.tapeHeights[i] = target;
          else self.tapeHeights[i] = Math.max(0, self.tapeHeights[i] - 0.05);
        }
      }
      const baseY = safePad + hSafe * 0.90;
      const maxH = hSafe * 0.70;
      const cw = self.colorway;
      for (let i = 0; i < N; i++) {
        const bh = Math.max(2, Math.floor(self.tapeHeights[i] * maxH));
        const x = xStart + Math.floor(gap + i * (barW + gap));
        const colorInfo = pickBarColor(i, N, cw, cw === 'rainbow');
        const grd = buildBarGradient(ctx, x, baseY - bh, x, baseY, colorInfo, self.tapeHeights[i]);
        ctx.fillStyle = grd;
        ctx.fillRect(x, baseY - bh, Math.max(1, Math.floor(barW)), bh);
        const headColor = pickWaveColor(0, cw, 0.95);
        ctx.fillStyle = headColor;
        ctx.fillRect(x, baseY - bh, Math.max(1, Math.floor(barW)), 2);
        const peakY = baseY - Math.max(2, Math.floor((self.tapeHeights[i] * 0.98) * maxH));
        ctx.fillStyle = colorInfo.color;
        ctx.globalAlpha = 0.8;
        ctx.fillRect(x, peakY, Math.max(1, Math.floor(barW)), 1);
        ctx.globalAlpha = 1;
      }
    },

    // ===== 4. 圆环脉冲（扁椭圆安全区） =====
    _drawRadialRing: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const cx = w / 2;
      const cy = safePad + hSafe * 0.5;
      // 扁椭圆安全区内：宽 ~44% wSafe，高 ~54% hSafe
      const baseRx = Math.min(wSafe * 0.22, hSafe * 1.1);
      const baseRy = baseRx * Math.min(0.28, hSafe / (wSafe * 0.85));
      const maxAddR = Math.min(wSafe * 0.16, hSafe * 0.44);
      const bars = 140;
      const cw = self.colorway;
      ctx.save();
      ctx.translate(cx, cy);
      for (let i = 0; i < bars; i++) {
        const ang = (i / bars) * Math.PI * 2;
        const idx = Math.floor(i / bars * 200);
        const v = fb[idx] / 255;
        const grow = Math.max(2, v * maxAddR * 1.15 + energy * 14 + 2);
        const sx = Math.cos(ang) * baseRx;
        const sy = Math.sin(ang) * baseRy;
        let nx = Math.cos(ang) / Math.max(1, baseRx), ny = Math.sin(ang) / Math.max(1, baseRy);
        const nl = Math.sqrt(nx * nx + ny * ny) || 1; nx /= nl; ny /= nl;
        const ex = sx + nx * grow;
        const ey = sy + ny * grow;
        const colorInfo = pickBarColor(i, bars, cw, cw === 'rainbow');
        ctx.strokeStyle = colorInfo.color;
        ctx.shadowColor = stripAlpha(colorInfo.color);
        ctx.shadowBlur = 5 + v * 12;
        ctx.lineWidth = Math.max(1, Math.floor(w / 900));
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      }
      ctx.shadowBlur = 0;
      const bass = (fb[1] + fb[3] + fb[6]) / 255 / 3;
      for (let r = 0; r < 3; r++) {
        const pulse = 0.55 + Math.min(0.45, energy * 0.8 + (r === 0 ? 0 : -0.08 * r));
        const colorInfo = pickBarColor(r * 20, 60, cw, cw === 'rainbow');
        const rgb = colorToRgb(colorInfo.color);
        ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (0.35 + 0.2 * (2 - r)).toFixed(3) + ')';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.ellipse(0, 0, baseRx * (0.36 + 0.15 * r) * pulse, baseRy * (0.36 + 0.15 * r) * pulse, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    },

    // ===== 5. 粒子（严格压在安全区内） =====
    _drawParticles: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const cw = self.colorway;
      const liveEnergy = Math.max(energy, self.isPlaying ? 0.1 : 0.03);
      let bassRaw = (fb[1] + fb[3] + fb[6] + fb[10] + fb[16]) / 255 / 5;
      if (!isFinite(bassRaw) || bassRaw < 0) bassRaw = 0;
      const bass = Math.max(bassRaw, self.isPlaying ? 0.06 : 0.01);
      // 喷发量稍微降一点（保证粒子不会多到超出边界全挤在一起）
      const baseBurst = self.isPlaying ? 10 : 3;
      const burst = Math.min(42, baseBurst + Math.floor(bass * 70 + liveEnergy * 38));
      const xStart = (w - wSafe) / 2;
      // 起点：安全区 84% 位置（偏中下部，粒子不会飞太高出顶）
      const baseY = safePad + hSafe * 0.84;
      const yMaxTop = safePad + 2; // 粒子飞行不要穿过 safePad 顶部以上
      const yMaxBot = safePad + hSafe - 2;
      for (let i = 0; i < burst; i++) {
        // x 严格在 wSafe 内（也不贴左右边）
        const ox = xStart + (Math.random() * wSafe * 0.98) + wSafe * 0.01;
        const oy = baseY - Math.random() * 6;
        // 初速度压小，重力稍大 → 不会一帧飞出顶
        const speed = 1.2 + Math.random() * 2.8 + liveEnergy * 3.0;
        const dir = Math.PI * (1.5 + (Math.random() - 0.5) * 0.95); // 角度更竖、少斜飞
        const colorInfo = pickBarColor(Math.floor(Math.random() * 96), 96, cw, cw === 'rainbow');
        self.particles.push({
          x: ox, y: oy,
          vx: Math.cos(dir) * speed,
          vy: Math.sin(dir) * speed,
          life: 1,
          size: 1.5 + Math.random() * 2.4,
          color: colorInfo.color,
          hueShift: (Math.random() - 0.5) * 40
        });
      }
      if (self.particles.length > 1400) self.particles.splice(0, self.particles.length - 1400);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < self.particles.length; i++) {
        const p = self.particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.06;   // 重力加大 → 不会冲穿顶
        p.vx *= 0.996;
        p.life -= 0.010;
        if (p.life <= 0) { self.particles.splice(i, 1); i--; continue; }
        // ⭐ 关键：粒子撞到顶/底安全区/左右边界 → 直接剔除（保证 100% 不超出进度条界面外）
        if (p.y < yMaxTop || p.y > yMaxBot || p.x < 1 || p.x > w - 1) {
          self.particles.splice(i, 1); i--; continue;
        }
        const al = Math.max(0, Math.min(1, p.life));
        if (al <= 0.01) { self.particles.splice(i, 1); i--; continue; }
        const col = hexShiftAlpha(p.color, p.hueShift, 1);
        // 还是 4 层叠加，但体积缩小一圈
        ctx.globalAlpha = al * 0.32;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 3.0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = al * 0.65;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 1.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = al;
        const core = hexShiftAlpha('#ffffff', 0, al * 0.88);
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.restore();
    },

    // ================================================================
    //  ===== A. 液态 / 流体系列 =====
    // ================================================================
    _drawLiquidBlob: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const cw = self.colorway;
      const midY = safePad + hSafe * 0.60;
      const yFloor = safePad + hSafe;
      // 3~4 个"水团"叠加（multiply / screen 混合像水彩融合）
      const N = 4;
      for (let n = 0; n < N; n++) {
        let y = 0;
        const freqIdxBase = Math.floor(n / N * 120);
        let amp = 0;
        for (let k = 0; k < 18; k++) amp += fb[freqIdxBase + k] || 0;
        amp = (amp / 18 / 255) * (0.30 + energy * 0.38);
        // 振幅严格按 hSafe 的 42% 上限
        const ampPx = hSafe * (0.34 * amp + 0.08) + (n % 2 === 0 ? 2 : -2);
        const colorInfo = pickBarColor(n * 18, N * 18, cw, cw === 'rainbow');
        const rgb = colorToRgb(colorInfo.color);
        ctx.beginPath();
        for (let x = 0; x <= w; x++) {
          const t = performance.now() / 900 + n * 1.5;
          const w1 = Math.sin((x / w) * Math.PI * (3 + n * 0.5) + t) * 0.5;
          const w2 = Math.sin((x / w) * Math.PI * (6 + n) + t * 1.3) * 0.35;
          const w3 = (fb[Math.floor(x / w * 180)] / 255 - 0.5) * 0.52 * (0.55 + energy);
          y = midY + (w1 + w2 + w3) * ampPx + n * 2;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.lineTo(w, yFloor); ctx.lineTo(0, yFloor); ctx.closePath();
        const grd = ctx.createLinearGradient(0, midY - ampPx, 0, yFloor);
        grd.addColorStop(0, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (0.14 + n * 0.036).toFixed(3) + ')');
        grd.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (0.42 + n * 0.05).toFixed(3) + ')');
        ctx.fillStyle = grd;
        ctx.fill();
      }
      // 顶部一条白边
      ctx.beginPath();
      for (let x = 0; x <= w; x++) {
        const t = performance.now() / 850;
        const w1 = Math.sin((x / w) * Math.PI * 4 + t) * 0.5;
        const w2 = Math.sin((x / w) * Math.PI * 7 + t * 1.4) * 0.3;
        const y = midY + (w1 + w2) * (hSafe * 0.13) * (0.46 + energy * 0.34);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.44 + energy * 0.28).toFixed(3) + ')';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    },

    _drawWaveStack: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const tb = self.timeBuf;
      const cw = self.colorway;
      const L = tb.length;
      const layers = 6;
      const yFloor = safePad + hSafe;
      const baseMid = safePad + hSafe * 0.58;
      for (let layer = 0; layer < layers; layer++) {
        const delay = layer * (L / 20);
        const ampScale = 0.80 - layer * 0.10;
        // 振幅压到 hSafe * 0.40 上限
        const amp = hSafe * (0.14 + energy * 0.26) * ampScale;
        const mid = baseMid + (layer - layers / 2) * 2;
        ctx.beginPath();
        for (let x = 0; x <= w; x++) {
          let i = Math.floor(x / w * L + delay);
          while (i >= L) i -= L;
          while (i < 0) i += L;
          const val = (tb[i] - 128) / 128;
          const ambient = Math.sin((x / w) * Math.PI * 3 + performance.now() / 900 + layer) * (0.08 + energy * 0.05);
          const y = mid + (val + ambient) * amp;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        const colorInfo = pickBarColor(layer * 14, layers * 14, cw, cw === 'rainbow');
        const rgb = colorToRgb(colorInfo.color);
        const a = 0.66 - layer * 0.09;
        ctx.lineTo(w, yFloor); ctx.lineTo(0, yFloor); ctx.closePath();
        const grd = ctx.createLinearGradient(0, mid - amp, 0, yFloor);
        grd.addColorStop(0, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (a * 0.28).toFixed(3) + ')');
        grd.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + a.toFixed(3) + ')');
        ctx.fillStyle = grd;
        ctx.fill();
      }
    },

    _drawRipple: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const cw = self.colorway;
      const bass = Math.max(0, (fb[1] + fb[3] + fb[6] + fb[10]) / 255 / 4 - 0.12) * (1 / 0.88);
      if (!self._ripples) self._ripples = [];
      if (!self._lastBass) self._lastBass = 0;
      if (bass - self._lastBass > 0.12 && self.isPlaying) {
        const count = 3 + Math.floor(Math.random() * 4);
        const xStart = (w - wSafe) / 2;
        for (let i = 0; i < count; i++) {
          const colorInfo = pickBarColor(i * 10, 70, cw, cw === 'rainbow');
          self._ripples.push({
            cx: xStart + ((i + 0.5 + Math.random() * 0.6) / count * wSafe),
            cy: safePad + hSafe * (0.86 + Math.random() * 0.12),  // 控制在安全区底部附近
            r: 0, life: 1,
            speed: 1.2 + bass * 3.4 + Math.random() * 0.5,
            color: colorInfo.color
          });
        }
      }
      self._lastBass = bass;
      const now = performance.now();
      if (!self._lastRippleTs) self._lastRippleTs = 0;
      if (self.isPlaying && now - self._lastRippleTs > 380) {
        self._lastRippleTs = now;
        const colorInfo = pickBarColor(20, 100, cw, cw === 'rainbow');
        const xStart = (w - wSafe) / 2;
        self._ripples.push({
          cx: xStart + Math.random() * wSafe,
          cy: safePad + hSafe * (0.82 + Math.random() * 0.12),
          r: 0, life: 1,
          speed: 0.7 + energy * 1.3,
          color: colorInfo.color
        });
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < self._ripples.length; i++) {
        const r = self._ripples[i];
        r.r += r.speed;
        r.life -= 0.018;
        if (r.life <= 0) { self._ripples.splice(i, 1); i--; continue; }
        const rgb = colorToRgb(r.color);
        const alpha = r.life * 0.85;
        // 椭圆 ry 更扁，且严格控制环大小不穿出安全区（maxR ≈ hSafe*0.62）
        const ryK = 0.22;
        for (let k = 0; k < 3; k++) {
          const rr = Math.max(0, r.r - k * 8);
          if (rr <= 0) continue;
          // 扩散一旦超出安全区边界就直接自然淘汰
          if (rr * ryK > hSafe * 0.42) { r.life = Math.min(r.life, 0.2); }
          ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (alpha * (1 - k * 0.25)).toFixed(3) + ')';
          ctx.lineWidth = Math.max(0.6, 1.6 * r.life - k * 0.4);
          ctx.beginPath();
          ctx.ellipse(r.cx, r.cy, rr * 1.0, rr * ryK, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    },

    // ================================================================
    //  ===== B. 霓虹 / EQ 系列 =====
    // ================================================================
    _drawEqualizer: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const cw = self.colorway;
      const N = 14;
      const levels = 8;
      const xPad = Math.max(4, wSafe * 0.015);
      const innerW = wSafe - xPad * 2;
      const xStart = (w - wSafe) / 2 + xPad;
      const gap = Math.max(3, Math.floor(innerW / 220));
      const barW = (innerW - (N - 1) * gap) / N;
      // 顶部/底部留白 = 安全区再额外 9%/13%
      const innerH = hSafe * 0.74;
      const yTop = safePad + hSafe * 0.13;
      const cellH = (innerH - (levels - 1) * gap) / levels;
      for (let i = 0; i < N; i++) {
        const freqIdx = Math.floor(i / N * 160);
        const v = Math.min(1, fb[freqIdx] / 255 * 1.25 + energy * 0.3);
        const lit = Math.max(0, Math.round(v * levels));
        const x = xStart + i * (barW + gap);
        for (let lv = 0; lv < levels; lv++) {
          const isLit = lv < lit;
          const y = yTop + (levels - 1 - lv) * (cellH + gap);
          const colorInfo = pickBarColor(i + lv, N + levels, cw, cw === 'rainbow');
          if (isLit) {
            const rgb = colorToRgb(colorInfo.color);
            const intensity = 0.55 + (lv / levels) * 0.45;
            ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + intensity.toFixed(3) + ')';
            ctx.shadowColor = colorInfo.color;
            ctx.shadowBlur = 6 + (lv / levels) * 8;
          } else {
            ctx.fillStyle = 'rgba(255,255,255,0.05)';
            ctx.shadowBlur = 0;
          }
          roundRect(ctx, x, y, barW, cellH, Math.max(1, Math.floor(barW / 3)));
          ctx.fill();
        }
      }
      ctx.shadowBlur = 0;
    },

    _drawCircularFlat: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const cw = self.colorway;
      const cx = w / 2;
      const cy = safePad + hSafe * 0.5;
      // 扁椭圆半径严格限制在安全区内（再压小一圈）
      const rx = Math.min(wSafe * 0.34, hSafe * 1.1);
      const ry = Math.min(hSafe * 0.32, rx * 0.22);
      const maxAdd = Math.min(wSafe * 0.14, hSafe * 0.42);
      const bars = 120;
      ctx.save();
      ctx.translate(cx, cy);
      for (let i = 0; i < bars; i++) {
        const ang = (i / bars) * Math.PI * 2;
        const freqIdx = Math.floor(i / bars * 180);
        const v = fb[freqIdx] / 255;
        const len = Math.max(2, v * maxAdd * 1.15 + energy * 14 + 2);
        const sx = Math.cos(ang) * rx;
        const sy = Math.sin(ang) * ry;
        let nx = Math.cos(ang) / Math.max(1, rx), ny = Math.sin(ang) / Math.max(1, ry);
        const nl = Math.sqrt(nx * nx + ny * ny) || 1; nx /= nl; ny /= nl;
        const ex = sx + nx * len;
        const ey = sy + ny * len;
        const colorInfo = pickBarColor(i, bars, cw, cw === 'rainbow');
        ctx.strokeStyle = colorInfo.color;
        ctx.shadowColor = stripAlpha(colorInfo.color);
        ctx.shadowBlur = 5 + v * 12;
        ctx.lineWidth = Math.max(1, Math.floor(w / 900));
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      }
      ctx.shadowBlur = 0;
      const bass = (fb[1] + fb[3] + fb[6]) / 255 / 3;
      for (let k = 0; k < 3; k++) {
        const colorInfo = pickBarColor(k * 20, 60, cw, cw === 'rainbow');
        const rgb = colorToRgb(colorInfo.color);
        ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (0.5 - k * 0.12).toFixed(3) + ')';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        const sc = 0.52 + Math.min(0.48, bass * 0.8 + energy * 0.3 - k * 0.06);
        ctx.ellipse(0, 0, rx * (0.42 - 0.08 * k) * sc, ry * (0.42 - 0.08 * k) * sc, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    },

    _drawVMeters: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const cw = self.colorway;
      const bands = [
        { label: 'L', idx: [1,2,3,5,8,12,16] },
        { label: 'M', idx: [28,36,44,52,60,72,84,96] },
        { label: 'H', idx: [120,135,150,165,180,195,210,224] }
      ];
      const sidePad = Math.max(6, wSafe * 0.05);
      const innerW = wSafe - sidePad * 2;
      const meterW = (innerW - 2 * innerW * 0.05) / 3;
      const gap = innerW * 0.05;
      const xStart = (w - wSafe) / 2 + sidePad;
      const pivot = safePad + hSafe * 0.70;        // 表心
      const baseY = safePad + hSafe * 0.94;        // 标签底座线
      const scaleFrom = Math.PI * 0.80;
      const scaleTo   = Math.PI * 0.20;
      for (let i = 0; i < 3; i++) {
        const mcX = xStart + (meterW + gap) * i + meterW / 2;
        let v = 0;
        for (let k = 0; k < bands[i].idx.length; k++) v += fb[bands[i].idx[k]] || 0;
        v = Math.min(1, (v / bands[i].idx.length / 255) * 1.3 + energy * 0.25);
        const colorInfo = pickBarColor(i * 20, 60, cw, cw === 'rainbow');
        const rgb = colorToRgb(colorInfo.color);
      // 半径压到 hSafe*0.48 以内，label 底部也贴在安全区内
        const R = Math.min(meterW * 0.36, hSafe * 0.48);
        ctx.beginPath();
        ctx.arc(mcX, pivot, R, scaleFrom, scaleTo, false);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 2;
        ctx.stroke();
        const seg = 10;
        for (let s = 0; s <= seg; s++) {
          const t = s / seg;
          const a = scaleFrom + (scaleTo + Math.PI * 2 - scaleFrom) * t;
          const x1 = mcX + Math.cos(a) * (R - 2);
          const y1 = pivot + Math.sin(a) * (R - 2);
          const x2 = mcX + Math.cos(a) * (R + (s % 5 === 0 ? 8 : 4));
          const y2 = pivot + Math.sin(a) * (R + (s % 5 === 0 ? 8 : 4));
          ctx.strokeStyle = s / seg <= v ? colorInfo.color : 'rgba(255,255,255,0.28)';
          ctx.lineWidth = s % 5 === 0 ? 2 : 1;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
        const needleAngle = scaleFrom + (scaleTo + Math.PI * 2 - scaleFrom) * v;
        const nx = mcX + Math.cos(needleAngle) * (R - 4);
        const ny = pivot + Math.sin(needleAngle) * (R - 4);
        ctx.strokeStyle = colorInfo.color;
        ctx.shadowColor = stripAlpha(colorInfo.color);
        ctx.shadowBlur = 8 + v * 14;
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(mcX, pivot); ctx.lineTo(nx, ny); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
        ctx.beginPath(); ctx.arc(mcX, pivot, 3.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(mcX, pivot, 1.4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mcX - meterW * 0.4, baseY);
        ctx.lineTo(mcX + meterW * 0.4, baseY);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        const labelY = baseY + Math.max(10, hSafe * 0.045);
        ctx.fillText(bands[i].label, mcX, labelY > safePad + hSafe - 2 ? (safePad + hSafe - 2) : labelY);
      }
      ctx.lineCap = 'butt';
    },

    // ================================================================
    //  ===== C. 极光 / 漩涡系列 =====
    // ================================================================
    _drawAuroraFlow: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const cw = self.colorway;
      const belts = 4;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let b = 0; b < belts; b++) {
        let v = 0;
        for (let k = 0; k < 12; k++) v += fb[Math.floor(b / belts * 160) + k] || 0;
        v = Math.min(1, v / 12 / 255 * 1.2 + energy * 0.3);
        const colorInfo = pickBarColor(b * 16, belts * 16, cw, cw === 'rainbow');
        const rgb = colorToRgb(colorInfo.color);
        // 基准Y分布在 36%~88% 安全区内
        const baseY = safePad + hSafe * (0.36 + 0.13 * b);
        // 振幅上限约 hSafe*0.28（压小保证不出界）
        const amp = hSafe * (0.14 + 0.34 * (belts - b) / belts) * (0.3 + v * 0.7);
        const phase = performance.now() / (900 + b * 120) + b * 2;
        ctx.beginPath();
        for (let x = 0; x <= w; x++) {
          const dist = (x / w);
          const wobble =
            Math.sin(dist * Math.PI * 3 + phase) * 0.5 +
            Math.sin(dist * Math.PI * 6 + phase * 1.5 + b) * 0.3 +
            Math.sin(dist * Math.PI * 11 + phase * 2.2) * 0.18;
          const shake = (fb[Math.floor(dist * 180)] / 255 - 0.5) * 0.6 * v;
          const y = baseY + (wobble + shake) * amp;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        for (let x = w; x >= 0; x--) {
          const dist = (x / w);
          const wobble =
            Math.sin(dist * Math.PI * 3 + phase - 0.3) * 0.5 +
            Math.sin(dist * Math.PI * 6 + phase * 1.5 - 0.3 + b) * 0.3 +
            Math.sin(dist * Math.PI * 11 + phase * 2.2 - 0.3) * 0.18;
          const shake = (fb[Math.floor(dist * 180)] / 255 - 0.5) * 0.6 * v;
          const ribbonThickness = Math.max(4, hSafe * 0.03 + v * hSafe * 0.04);
          const y = baseY + (wobble + shake) * amp + ribbonThickness;
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        const grd = ctx.createLinearGradient(0, baseY - amp, 0, baseY + amp);
        grd.addColorStop(0, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0)');
        grd.addColorStop(0.5, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (0.32 + 0.09 * b).toFixed(3) + ')');
        grd.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0)');
        ctx.fillStyle = grd;
        ctx.fill();
      }
      ctx.restore();
    },

    _drawGalaxySpiral: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const cw = self.colorway;
      const cx = w / 2;
      const cy = safePad + hSafe * 0.52;
      const arms = 3;
      const spins = 2;
      // maxR 严格控制在安全区大小内（压小一圈）
      const maxR = Math.min(wSafe * 0.40, hSafe * 1.25);
      const aspect = Math.min(0.32, hSafe / (wSafe * 0.82));
      for (let arm = 0; arm < arms; arm++) {
        ctx.beginPath();
        let first = true;
        for (let i = 0; i < 220; i++) {
          const t = i / 220;
          const freqIdx = Math.floor(t * 200);
          const v = fb[freqIdx] / 255;
          const angle = t * spins * Math.PI * 2 + (arm / arms) * Math.PI * 2 + performance.now() / 3000;
          const r = t * maxR * (0.45 + v * 0.55 + energy * 0.18);
          const px = cx + Math.cos(angle) * r;
          const py = cy + Math.sin(angle) * r * aspect;
          if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py);
        }
        const colorInfo = pickBarColor(arm * 28, arms * 28, cw, cw === 'rainbow');
        const rgb = colorToRgb(colorInfo.color);
        const grd = ctx.createLinearGradient(cx, cy, cx + maxR * 0.6, cy + maxR * aspect);
        grd.addColorStop(0, 'rgba(255,255,255,0.78)');
        grd.addColorStop(0.2, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.7)');
        grd.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0)');
        ctx.strokeStyle = grd;
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(1, 2.2 + energy * 1.8);
        ctx.shadowColor = stripAlpha(colorInfo.color);
        ctx.shadowBlur = 8 + energy * 14;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      // 中心尘埃（粒子量下调 + 出安全区就剔除）
      const bass = (fb[1] + fb[3] + fb[6] + fb[10]) / 255 / 4;
      const burst = 3 + Math.floor(bass * 20 + energy * 10);
      if (!self._galaxyDust) self._galaxyDust = [];
      for (let i = 0; i < burst; i++) {
        const ang = Math.random() * Math.PI * 2;
        const speed = 0.45 + Math.random() * 2.2 + bass * 2.4;
        const colorInfo = pickBarColor(Math.floor(Math.random() * 70), 70, cw, cw === 'rainbow');
        self._galaxyDust.push({
          x: cx + (Math.random() - 0.5) * 8,
          y: cy + (Math.random() - 0.5) * 4,
          vx: Math.cos(ang) * speed,
          vy: Math.sin(ang) * speed * aspect,
          size: 0.8 + Math.random() * 2.0,
          life: 1,
          color: colorInfo.color
        });
      }
      if (self._galaxyDust.length > 500) self._galaxyDust.splice(0, self._galaxyDust.length - 500);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < self._galaxyDust.length; i++) {
        const p = self._galaxyDust[i];
        const dx = p.x - cx, dy = p.y - cy;
        const rot = 0.004;
        const nvx = p.vx * 0.994 + (- dx * rot * 2) + Math.cos(performance.now() / 500 + i) * 0.025;
        const nvy = p.vy * 0.994 + ( dx * rot * 2) + Math.sin(performance.now() / 500 + i) * 0.025;
        p.vx = nvx; p.vy = nvy;
        p.x += p.vx; p.y += p.vy;
        p.life -= 0.011;
        // ⭐ 粒子出安全区直接剔除
        if (p.life <= 0 ||
            p.y < safePad + 1 || p.y > safePad + hSafe - 1 ||
            p.x < 1 || p.x > w - 1) {
          self._galaxyDust.splice(i, 1); i--; continue;
        }
        const rgb = colorToRgb(p.color);
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life)) * 0.85;
        ctx.fillStyle = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      // 中心发光点（大小限制在 wSafe*0.10, hSafe*0.28）
      const coreColor = pickBarColor(50, 100, cw, cw === 'rainbow');
      const coreRGB = colorToRgb(coreColor.color);
      const pulse = 0.7 + Math.min(0.3, bass * 0.7 + energy * 0.3);
      ctx.globalCompositeOperation = 'lighter';
      const coreR = Math.max(6, Math.min(wSafe * 0.10, hSafe * 0.28));
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.9 * pulse).toFixed(3) + ')');
      g.addColorStop(0.35, 'rgba(' + coreRGB.r + ',' + coreRGB.g + ',' + coreRGB.b + ',' + (0.55 * pulse).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + coreRGB.r + ',' + coreRGB.g + ',' + coreRGB.b + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    },

    _drawPulseRings: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const cw = self.colorway;
      const bass = Math.max(0, (fb[1] + fb[3] + fb[6] + fb[10]) / 255 / 4 - 0.1) * (1 / 0.9);
      if (!self._pulseRings) self._pulseRings = [];
      if (!self._prevPulse) self._prevPulse = [0,0,0];
      const bands = [bass, fb[60]/255, fb[140]/255];
      for (let b = 0; b < 3; b++) {
        const rise = bands[b] - self._prevPulse[b];
        if (self.isPlaying && rise > 0.15) {
          const colorInfo = pickBarColor(b * 30, 90, cw, cw === 'rainbow');
          self._pulseRings.push({
            r: 0, life: 1,
            speed: 1.8 + bands[b] * 4.2,
            band: b,
            color: colorInfo.color
          });
        }
        self._prevPulse[b] = bands[b];
      }
      const now = performance.now();
      if (!self._pulseTs) self._pulseTs = 0;
      if (self.isPlaying && now - self._pulseTs > 550) {
        self._pulseTs = now;
        const colorInfo = pickBarColor(40, 100, cw, cw === 'rainbow');
        self._pulseRings.push({ r: 0, life: 1, speed: 1.2 + energy * 2.0, band: 1, color: colorInfo.color });
      }
      const baseY = safePad + hSafe * 0.88;
      const ryKs = [0.16, 0.24, 0.36];
      for (let i = 0; i < self._pulseRings.length; i++) {
        const p = self._pulseRings[i];
        p.r += p.speed;
        p.life -= 0.014;
        if (p.life <= 0) { self._pulseRings.splice(i, 1); i--; continue; }
        const ryK = ryKs[p.band];
        // 扁环一旦纵向顶到 safePad 就强制淘汰
        if (p.r * ryK > hSafe * 0.42) { p.life = Math.min(p.life, 0.2); }
        const rgb = colorToRgb(p.color);
        for (let k = 0; k < 3; k++) {
          const rr = Math.max(0, p.r - k * 8);
          if (rr <= 0) continue;
          ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (p.life * (0.6 - k * 0.15)).toFixed(3) + ')';
          ctx.lineWidth = Math.max(0.5, (2.0 * p.life - k * 0.45));
          ctx.shadowColor = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
          ctx.shadowBlur = 5 + p.life * 8;
          ctx.beginPath();
          const cxP = w / 2 + (k - 1) * w * 0.05;
          const cyP = baseY - p.band * 3;
          ctx.ellipse(cxP, cyP, rr * 1.0, rr * ryK, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.shadowBlur = 0;
    },

    // ================================================================
    //  ===== D. 方块 / 点阵系列 =====
    // ================================================================
    _drawMatrixRain: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const cw = self.colorway;
      const cols = Math.max(12, Math.floor(wSafe / 22));
      const rows = Math.max(5, Math.floor(hSafe / 14));
      const cellW = wSafe / cols;
      const cellH = hSafe / rows;
      const xStart = (w - wSafe) / 2;
      if (!self._matrixCols || self._matrixCols.length !== cols) self._matrixCols = new Array(cols).fill(0).map(function(){ return Math.random() * rows; });
      if (!self._matrixSpeeds || self._matrixSpeeds.length !== cols) self._matrixSpeeds = new Array(cols).fill(0).map(function(){ return 0.2 + Math.random() * 0.4; });
      ctx.save();
      for (let c = 0; c < cols; c++) {
        const freqIdx = Math.floor(c / cols * 200);
        const v = Math.min(1, fb[freqIdx] / 255 * 1.3 + energy * 0.3);
        self._matrixCols[c] += self._matrixSpeeds[c] * (0.6 + v * 2.6);
        if (self._matrixCols[c] > rows + 4) self._matrixCols[c] = -2;
        const stack = Math.round(v * (rows * 0.92 + 1));
        const head = Math.floor(self._matrixCols[c]);
        for (let r = 0; r < rows; r++) {
          const dHead = r - head;
          const inStack = r >= (rows - stack);
          const inTrail = dHead >= 0 && dHead <= 3;
          if (!inStack && !inTrail) continue;
          const intensity = inStack
            ? (0.25 + (r - (rows - stack)) / Math.max(1, stack) * 0.75)
            : (1 - dHead / 3) * 0.9;
          const colorInfo = pickBarColor(c + r * 0.4, cols + rows, cw, cw === 'rainbow');
          const rgb = colorToRgb(colorInfo.color);
          const a = Math.max(0, Math.min(1, intensity));
          ctx.fillStyle = inTrail ? 'rgba(255,255,255,' + a.toFixed(3) + ')' : 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + a.toFixed(3) + ')';
          const px = xStart + c * cellW + 1;
          const py = safePad + r * cellH + 1;
          const sz = Math.max(1, Math.floor(Math.min(cellW, cellH) - 2));
          ctx.fillRect(px, py, sz, sz);
        }
      }
      ctx.restore();
    },

    _drawBlocksFall: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const cw = self.colorway;
      const cols = 20;
      const rows = Math.max(6, Math.floor(hSafe / 16));
      const sidePad = Math.max(8, wSafe * 0.02);
      const innerW = wSafe - sidePad * 2;
      const xStart0 = (w - wSafe) / 2 + sidePad;
      const cellW = (innerW - (cols - 1) * 2) / cols;
      const cellH = (hSafe * 0.86) / rows;
      const topPad = safePad + hSafe * 0.07;
      const cellSize = Math.min(cellW, cellH);
      for (let c = 0; c < cols; c++) {
        const freqIdx = Math.floor(c / cols * 180);
        const v = Math.min(1, fb[freqIdx] / 255 * 1.3 + energy * 0.3);
        const stack = Math.max(0, Math.round(v * (rows * 0.86)));
        // 从底部向上堆叠方块，严格在安全区内
        for (let r = 0; r < stack; r++) {
          const ratio = r / Math.max(1, rows - 1);
          const colorInfo = pickBarColor(c * 3 + r, cols * 2 + rows, cw, cw === 'rainbow');
          const rgb = colorToRgb(colorInfo.color);
          const intensity = 0.35 + ratio * 0.65;
          ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + intensity.toFixed(3) + ')';
          const x = Math.floor(xStart0 + c * (cellW + 2));
          const y = Math.floor(topPad + (rows - 1 - r) * (cellH + 1));
          const sz = Math.max(2, Math.floor(cellSize) - 1);
          ctx.shadowBlur = ratio > 0.85 ? 5 + energy * 8 : 0;
          ctx.shadowColor = stripAlpha(colorInfo.color);
          roundRect(ctx, x, y, sz, sz, Math.max(1, Math.floor(sz / 4)));
          ctx.fill();
          if (r === stack - 1 && stack > 0) {
            ctx.shadowBlur = 0;
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 1;
            roundRect(ctx, x, y, sz, sz, Math.max(1, Math.floor(sz / 4)));
            ctx.stroke();
          }
        }
      }
      ctx.shadowBlur = 0;
    },

    _drawDotGrid: function(ctx, w, h, energy) {
      const self = this;
      const { safePad, hSafe, wSafe } = self._getSafeBox();
      const fb = self.freqBuf;
      const cw = self.colorway;
      const cols = Math.max(28, Math.floor(wSafe / 14));
      const rows = Math.max(6, Math.floor(hSafe / 14));
      const x0 = (w - wSafe) / 2;
      const cellW = wSafe / cols;
      const cellH = hSafe / rows;
      const dotR = Math.max(1.2, Math.min(cellW, cellH) * 0.35);
      for (let r = 0; r < rows; r++) {
        // 行高决定对应频段（底部=低频，顶部=高频）
        const rowBand = 1 - (r / Math.max(1, rows - 1));
        for (let c = 0; c < cols; c++) {
          const baseIdx = Math.floor(rowBand * 180);
          const colIdx = Math.floor(c / cols * 18);
          const v = Math.min(1, (fb[Math.min(255, baseIdx + colIdx)] / 255) * 1.3 + energy * 0.28);
          const y = safePad + r * cellH + cellH / 2;
          const x = x0 + c * cellW + cellW / 2;
          // 点阵屏"越底部低频→越容易亮"（符合 EQ 堆叠的直觉）
          const threshold = (r / Math.max(1, rows)) * 0.95;  // 底部 threshold 低 → 容易亮
          const lit = (v > threshold);
          const colorInfo = pickBarColor(c * 0.5 + r, cols + rows, cw, cw === 'rainbow');
          const rgb = colorToRgb(colorInfo.color);
          if (lit) {
            // 亮：本体 + 小发光
            const excess = Math.max(0, v - threshold) / Math.max(0.05, 1 - threshold); // 超阈值多少
            const sizeR = dotR * (0.88 + excess * 0.6);
            ctx.shadowBlur = 3 + excess * 8;
            ctx.shadowColor = stripAlpha(colorInfo.color);
            ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (0.72 + excess * 0.28).toFixed(3) + ')';
            ctx.beginPath();
            ctx.arc(x, y, sizeR, 0, Math.PI * 2);
            ctx.fill();
            // 中心亮点
            ctx.shadowBlur = 0;
            ctx.fillStyle = 'rgba(255,255,255,' + (0.5 + excess * 0.5).toFixed(3) + ')';
            ctx.beginPath();
            ctx.arc(x, y, sizeR * 0.4, 0, Math.PI * 2);
            ctx.fill();
          } else {
            // 灭：一个灰暗点（保留点阵屏骨架）
            ctx.shadowBlur = 0;
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            ctx.beginPath();
            ctx.arc(x, y, dotR * 0.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.shadowBlur = 0;
    },
  };

  // ===== 配色工具函数 =====

  /** 取柱条颜色：返回 { color, glow } */
  function pickBarColor(i, N, cw, forceRainbow) {
    if (forceRainbow || cw === 'rainbow') {
      const hue = (i / N) * 300 + (performance.now() / 35) % 360;
      return { color: 'hsl(' + (hue % 360).toFixed(1) + ',94%,62%)', glow: true };
    }
    if (cw === 'theme') {
      const theme = readThemeColor();
      return { color: theme, glow: false };
    }
    if (cw === 'dopamine') {
      // 6 色轮流
      const idx = Math.floor(i / N * DOPAMINE_PALETTE.length) % DOPAMINE_PALETTE.length;
      return { color: DOPAMINE_PALETTE[idx], glow: true };
    }
    // 白渐变系（红/绿/蓝 白）：顶部白色 → 底部主色（通过 buildBarGradient 实现，这里返回主色）
    if (cw === 'red-white')    return { color: '#ff4c4c', glow: true };
    if (cw === 'green-white')  return { color: '#2ecc71', glow: true };
    if (cw === 'blue-white')   return { color: '#3ba3ff', glow: true };
    return { color: readThemeColor(), glow: false };
  }

  /** 柱条上下方向渐变（让"XX白"配色真正体现出白色→主色） */
  function buildBarGradient(ctx, x1, y1, x2, y2, colorInfo, v, flip) {
    const c = colorInfo.color;
    const grd = ctx.createLinearGradient(x1, y1, x2, y2);
    // 提取主色的 rgb
    const rgb = colorToRgb(c);
    const rgbaTop    = 'rgba(255,255,255,' + (0.55 + v * 0.4).toFixed(3) + ')';
    const rgbaMid1   = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (0.85 + v * 0.15).toFixed(3) + ')';
    const rgbaBottom = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',1)';
    if (flip) {
      grd.addColorStop(0, rgbaBottom);
      grd.addColorStop(0.5, rgbaMid1);
      grd.addColorStop(1, rgbaTop);
    } else {
      grd.addColorStop(0, rgbaTop);
      grd.addColorStop(0.5, rgbaMid1);
      grd.addColorStop(1, rgbaBottom);
    }
    return grd;
  }

  /** 波浪颜色（多层） */
  function pickWaveColor(layer, cw, alpha) {
    if (cw === 'rainbow') {
      const hues = [340, 200, 50, 280, 130, 170];
      const h = (hues[layer % hues.length] + performance.now() / 25) % 360;
      return 'hsla(' + h.toFixed(1) + ',95%,63%,' + alpha.toFixed(3) + ')';
    }
    if (cw === 'theme') {
      const c = readThemeColor();
      const rgb = colorToRgb(c);
      const a = Math.max(0.15, alpha * (1 - layer * 0.18));
      return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + a.toFixed(3) + ')';
    }
    if (cw === 'dopamine') {
      const col = DOPAMINE_PALETTE[(layer + Math.floor(performance.now() / 900)) % DOPAMINE_PALETTE.length];
      const rgb = colorToRgb(col);
      return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha.toFixed(3) + ')';
    }
    // 红白 / 绿白 / 蓝白：白色轮廓 + 主色填充
    const mainColor =
      cw === 'red-white'   ? '#ff4c4c' :
      cw === 'green-white' ? '#2ecc71' :
      cw === 'blue-white'  ? '#3ba3ff' : readThemeColor();
    if (layer === 0) {
      // 顶层线条 → 白色（不透明）
      return 'rgba(255,255,255,' + Math.min(1, alpha * 1.1).toFixed(3) + ')';
    }
    // 下面填充层 → 主色
    const rgb = colorToRgb(mainColor);
    const a = Math.max(0.12, alpha * (1 - layer * 0.2));
    return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + a.toFixed(3) + ')';
  }

  // ===== 小工具 =====
  function readThemeColor() {
    try {
      const cs = getComputedStyle(document.documentElement);
      const c = (cs.getPropertyValue('--theme-color') || '').trim();
      if (c && c.length) return c;
    } catch (_) {}
    try {
      const prog = document.querySelector('.progress-fill, #progressFill');
      if (prog) {
        const c = getComputedStyle(prog).backgroundColor;
        if (c) return c;
      }
    } catch (_) {}
    return '#7c5cff';
  }

  function colorToRgb(c) {
    if (typeof c !== 'string') return { r: 124, g: 92, b: 255 };
    const s = c.trim();
    if (s.startsWith('rgb')) {
      const m = s.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/);
      if (m) return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
    }
    if (s.startsWith('hsl')) {
      const m = s.match(/hsla?\(\s*([\d.]+)[ ,]+([\d.]+)%[ ,]+([\d.]+)%/);
      if (m) return hslToRgb(parseFloat(m[1]), parseFloat(m[2]) / 100, parseFloat(m[3]) / 100);
    }
    let h = s.replace('#', '');
    if (h.length === 3) h = h.split('').map(function(x){ return x + x; }).join('');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return { r: 124, g: 92, b: 255 };
    return { r, g, b };
  }

  function hslToRgb(h, s, l) {
    h /= 360;
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      const hue2rgb = function(p, q, t) {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }

  function stripAlpha(c) {
    const rgb = colorToRgb(c);
    return 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
  }

  function hexShiftAlpha(hex, hueDelta, alpha) {
    const rgb = colorToRgb(hex);
    let [r, g, b] = [rgb.r / 255, rgb.g / 255, rgb.b / 255];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      switch (mx) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
        case g: h = ((b - r) / d + 2); break;
        case b: h = ((r - g) / d + 4); break;
      }
      h *= 60;
    }
    h = (h + hueDelta + 360) % 360;
    const rgb2 = hslToRgb(h, s, l);
    return 'rgba(' + rgb2.r + ',' + rgb2.g + ',' + rgb2.b + ',' + alpha.toFixed(3) + ')';
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    if (rr <= 0) { ctx.rect(x, y, w, h); return; }
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  global.AudioViz = AudioViz;
  global.__AUDIO_VIZ_SERIES_POOLS = SERIES_POOLS;
  global.__AUDIO_VIZ_COLORWAYS = COLORWAYS;
})(typeof window !== 'undefined' ? window : globalThis);
