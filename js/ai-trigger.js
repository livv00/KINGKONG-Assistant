// AI触发 - 总控模块
// 管理 AudioContext + AnalyserNode + 分析循环(rAF) + 场景触发(console-remote-cmd)
// 跨窗口配置：console-connect.html 存配置→IPC→main.js→index.html 接收

(function() {
  'use strict';

  const AiTrigger = {
    audioCtx: null,
    analyser: null,
    sourceNode: null,
    audioAnalyser: null,   // AudioAnalyser 实例
    sceneMatcher: null,    // SceneMatcher 实例
    rafId: null,
    audioElement: null,    // 保存引用，播放中开开关时用
    config: { enabled: false, switchMode: 'paragraph', playIds: [], stopScenesOnMusicStop: false },
    // 首轮兜底：避免"刚播放 1~3 秒内灯完全不亮"，一启动尽快亮第一个场景
    firstTriggerAt: 0,
    firstTriggerDone: false,
    firstTriggerDelayMs: 500,  // 所有模式统一 500ms 出第一个效果（用户点播放≈半秒就亮）
    debug: true,
    // 采样日志：每 1s 打一次音频特征，不刷屏
    _sampleLogAt: 0,
    _sampleCount: 0,
    _warnedZeroFFT: false,  // 只警告一次全 0 FFT
    _warnedNoPool: false,   // 只警告一次空池
    _warnedGate: false,     // noise gate 持续关闭只警告一次

    // 初始化（index.html 加载时调用）
    init() {
      if (typeof SceneMatcher === 'function') {
        this.sceneMatcher = new SceneMatcher();
      }
    },

    // 播放时调用（playMusic 里调用，每次切歌重置匹配状态）
    onPlay(audioElement) {
      this.audioElement = audioElement;
      this._warnedZeroFFT = false;
      this._warnedNoPool = false;
      this._warnedGate = false;
      this._sampleLogAt = 0;
      this._sampleCount = 0;
      // ===== 前奏静音预检状态：先判定是否静音，再亮场景（避免"亮→再关"闪烁）=====
      this._precheckFrames = 0;         // 已采样预检帧数
      this._precheckMaxFrames = 16;     // 预检最多 16 帧 ≈ 260ms（60fps 下 266ms）
      this._precheckHasSound = false;   // 预检过程中是否已探测到声音(>=1帧 overallEnergy>=0.005)
      this._precheckDecided = false;    // 预检是否已做出结论(静音/非静音)，false=还在收集
      this._instantFirePlayId = null;   // 立即点亮的 playId（调试用）

      if (this.config.enabled) {
        this._setupAudio();
        this._startLoop();
        if (this.sceneMatcher) this.sceneMatcher.reset();
        this.firstTriggerAt = performance.now();
        this.firstTriggerDone = false;
        if (this.debug) console.log('[AI触发] onPlay: 启动, mode=' + this.config.switchMode + ', pool=' + JSON.stringify(this.config.playIds));
        if (!this.config.playIds || this.config.playIds.length === 0) {
          if (!this._warnedNoPool) {
            this._warnedNoPool = true;
            console.warn('[AI触发] ⚠️ playIds 池是空的！请在控台窗口→AI触发→勾选触发场景范围后，再播放音乐。');
          }
        }
      } else {
        if (this.debug) console.log('[AI触发] onPlay: 开关关闭，跳过');
      }
    },

    // 暂停（不重置，下次 resume 从中断点继续）
    pause() {
      this._stopLoop();
      if (this.debug) console.log('[AI触发] pause: 暂停分析循环，保留匹配状态');
    },

    // 继续（恢复分析循环，不重置 matcher）
    resume() {
      if (this.config.enabled && this.audioElement) {
        this._setupAudio();
        this._startLoop();
        if (this.debug) console.log('[AI触发] resume: 恢复分析循环');
      }
    },

    // 停止/切歌时调用（不释放 sourceNode，避免重复 createMediaElementSource）
    // 如果开关「音乐停止后关闭播放」勾选，会批量 STOP 本次已勾选触发范围内的所有正在播放场景
    onStop() {
      this._stopLoop();
      if (this.sceneMatcher) this.sceneMatcher.reset();
      this.firstTriggerDone = false;
      // ===== 停止音乐后关闭播放 =====
      if (this.config.stopScenesOnMusicStop && this.config.playIds && this.config.playIds.length > 0) {
        try {
          const electron = require('electron');
          const ipcRenderer = electron.ipcRenderer;
          const pool = this.config.playIds;
          let stopCount = 0;
          pool.forEach(function(pid) {
            try {
              ipcRenderer.send('console-remote-cmd', { action: 'stop', playId: pid });
              stopCount++;
            } catch(_) {}
          });
          if (this.debug) console.log('[AI触发] onStop: 停止并重置 → 音乐停止后关闭播放: STOP触发范围全部 ' + stopCount + ' 个场景（范围=' + JSON.stringify(pool) + '）');
        } catch(e) {
          console.error('AI触发: 音乐停止后关闭场景失败', e);
        }
      } else {
        if (this.debug) console.log('[AI触发] onStop: 停止并重置（未勾选"音乐停止后关闭播放"，场景保留当前状态）');
      }
    },

    // 设置配置（从 IPC 接收 console-connect 窗口的配置）
    setConfig(config) {
      const wasEnabled = this.config.enabled;
      this.config = Object.assign({}, this.config, config);
      if (this.debug) console.log('[AI触发] setConfig:', JSON.stringify(this.config));
      // 开关从关→开，且正在播放 → 启动分析
      if (!wasEnabled && this.config.enabled && this.audioElement) {
        this._setupAudio();
        this._startLoop();
        // 开关中途打开：视为一次"新开始"，重置 matcher + 首轮兜底计时 + 清除旧警告
        if (this.sceneMatcher) this.sceneMatcher.reset();
        this.firstTriggerAt = performance.now();
        this.firstTriggerDone = false;
        this._warnedZeroFFT = false;
        this._warnedNoPool = false;
        this._warnedGate = false;
      }
      // 开关从开→关 → 停止分析（不释放 sourceNode）
      if (wasEnabled && !this.config.enabled) {
        this._stopLoop();
        if (this.sceneMatcher) this.sceneMatcher.reset();
      }
    },

    // 创建 AudioContext + AnalyserNode（挂载到 audioElement）
    _setupAudio() {
      if (!this.audioElement) return;
      try {
        // 共享 AudioContext + AnalyserNode：AiTrigger 和 进度条可视化 共用同一条音频链
        // 避免重复 createMediaElementSource 报错（HTMLMediaElement 最多只能 createSource 一次）
        const shared = (window.SharedAudioCore && typeof window.SharedAudioCore.ensure === 'function')
          ? window.SharedAudioCore.ensure(this.audioElement)
          : null;
        if (!shared || !shared.analyser) {
          console.warn('AI触发: 共享音频核心不可用，跳过音频分析初始化');
          return;
        }
        this.audioCtx = shared.audioCtx;
        this.analyser = shared.analyser;
        // AudioAnalyser 内部只读 getFloatFrequencyData()，不修改 analyser 参数，
        // 所以同一个 analyser 可以被 Viz + AiTrigger 同时使用，互不影响。
        if (!this.audioAnalyser || this.audioAnalyser.analyser !== shared.analyser) {
          this.audioAnalyser = new AudioAnalyser(shared.analyser);
        }
        if (this.debug) console.log('[AI触发] 复用SharedAudioCore共享链 OK, fftSize=' + shared.analyser.fftSize + ', ctx.state=' + shared.audioCtx.state);
      } catch(e) {
        console.error('AI触发: 音频接入失败', e);
      }
    },

    // 启动分析循环
    _startLoop() {
      if (this.rafId) return;
      const self = this;
      const loop = function() {
        self._tick();
        self.rafId = requestAnimationFrame(loop);
      };
      this.rafId = requestAnimationFrame(loop);
      if (this.debug) console.log('[AI触发] 分析循环启动');
    },

    // 停止分析循环
    _stopLoop() {
      if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    },

    // 每帧分析 + 匹配 + 触发
    _tick() {
      if (!this.config.enabled || !this.sceneMatcher) return;
      if (!this.audioAnalyser) return;

      // 空池警告：只打一次
      if (!this._warnedNoPool && (!this.config.playIds || this.config.playIds.length === 0)) {
        this._warnedNoPool = true;
        console.warn('[AI触发] ⚠️ playIds 池是空的！请在控台窗口→AI触发→勾选触发场景范围后，再播放音乐。');
      }

      const features = this.audioAnalyser.update();

      // ===== 采样日志（每 1 秒 1 条）=====
      this._sampleCount++;
      const now = performance.now();
      if (!this._sampleLogAt) this._sampleLogAt = now;
      if (now - this._sampleLogAt >= 1000) {
        this._sampleLogAt = now;
        if (this.debug) {
          console.log('[AI触发] 采样(' + this._sampleCount + '帧/s): gate=' + (features.noiseGateOpen?'开':'关') +
            ' overall=' + features.overallEnergy.toFixed(3) +
            ' bass=' + features.bassEnergy.toFixed(3) +
            ' mid=' + features.midEnergy.toFixed(3) +
            ' high=' + features.highEnergy.toFixed(3) +
            ' flatness=' + features.spectralFlatness.toFixed(3) +
            ' isBeat=' + features.isBeat +
            ' bpm≈' + (features.bpm || 0).toFixed(0) +
            ' AudioContext.state=' + (this.audioCtx && this.audioCtx.state) +
            ' audio.paused=' + (this.audioElement && this.audioElement.paused));
        }
        this._sampleCount = 0;
      }

      // ===== FFT 全 0 警告（典型：CORS 没开 crossOrigin，或没播放声音）=====
      if (!this._warnedZeroFFT && features.overallEnergy < 0.0005 && now - this.firstTriggerAt > 3000) {
        this._warnedZeroFFT = true;
        const u = (this.audioElement && this.audioElement.currentSrc) || (this.audioElement && this.audioElement.src) || '';
        console.warn('[AI触发] ⚠️ 播放3秒后 overallEnergy 仍然接近 0。' +
          ' 可能原因：① audio CORS：请确保 Audio 设置了 crossOrigin="anonymous"（已自动设置）。' +
          ' ② 音频源本身静音或音量为 0。' +
          ' ③ createMediaElementSource 失败。 URL=' + u);
      }

      // ===== Noise gate 持续关闭警告（10 秒还没开过一次门）=====
      if (!this._warnedGate && !features.noiseGateOpen && now - this.firstTriggerAt > 10000) {
        this._warnedGate = true;
        console.warn('[AI触发] ⚠️ 播放10秒内 noise gate 一次都没开。' +
          ' RMS 阈值 0.03 / flatness 阈值 0.75（当前：rms≈' + features.overallEnergy.toFixed(3) +
          ', flatness≈' + features.spectralFlatness.toFixed(3) + '）。' +
          ' 如果音乐其实有声音，请调大音量或把 audio volume 调大后重试。');
      }

      // ===== 前奏静音预检（约 260ms 内）：先判断是否静音，再决定是否立即随机亮 =====
      if (!this._precheckDecided && !this.firstTriggerDone) {
        if (features.overallEnergy >= 0.005) this._precheckHasSound = true;
        this._precheckFrames++;
        // 条件 A：已发现有声音 → 立即判非静音，随机亮
        // 条件 B：或 16 帧（≈260ms）采满 → 根据已收集的结果决定
        if (this._precheckHasSound || this._precheckFrames >= this._precheckMaxFrames) {
          this._precheckDecided = true;
          if (this._precheckHasSound) {
            // 判定：非静音开头 → 立即随机亮一个
            const elapsed = now - this.firstTriggerAt;
            this._fireFirstSceneInstant('先判定非静音→立即随机亮' + '（播放后 ' + elapsed + 'ms）');
          } else {
            // 判定：静音开头 → 不立即亮，等 500ms 兜底/音乐出声后再触发
            const elapsed = now - this.firstTriggerAt;
            if (this.debug) console.log('[AI触发] 前奏静音判定→不立即亮，等音乐出声（播放后 ' + elapsed + 'ms 判定）');
          }
        }
      }

      // 首轮兜底：任何模式都兜底——500ms 内没触发过就亮第一个（让用户一按播放就看到效果）
      if (!this.firstTriggerDone) {
        const elapsed = now - this.firstTriggerAt;
        const neverTriggered = this.sceneMatcher.currentPlayId === null;
        if (neverTriggered && elapsed > this.firstTriggerDelayMs && this.config.playIds.length > 0) {
          const playId = this._pickFirstByFeatures(features, this.config.playIds);
          if (playId) {
            this.sceneMatcher.currentPlayId = playId;
            this.sceneMatcher.lastSwitchTime = performance.now();
            // 首轮兜底触发成功 → 立刻排"下一次强制切换"的 deadline（4.5~6s 内必换第二个）
            try { this.sceneMatcher._scheduleNextForceSwitch(performance.now()); } catch (_) {}
            const segName = this._detectSimpleSegment(features);
            const reason = (features.noiseGateOpen ? '首轮兜底(' + segName + ')' : 'noise gate 未开，保底首场景')
              + '（播放后 ' + (elapsed|0) + 'ms 亮）';
            this._triggerScene({ playId: playId, oldPlayId: null, reason: reason });
            this.firstTriggerDone = true;
          }
        }
      }

      const result = this.sceneMatcher.match(features, this.config);
      if (result) {
        this.firstTriggerDone = true;
        this._triggerScene(result);
      }
    },

    // 预检通过后：随机亮第一个场景（非静音前奏才会走到这里）
    _fireFirstSceneInstant(reasonTag) {
      if (!this.config.enabled || !this.config.playIds || this.config.playIds.length === 0) return;
      if (this.firstTriggerDone) return;
      const playId = this.config.playIds[Math.floor(Math.random() * this.config.playIds.length)];
      this._instantFirePlayId = playId;
      this.sceneMatcher.currentPlayId = playId;
      this.sceneMatcher.lastSwitchTime = performance.now();
      try { this.sceneMatcher._scheduleNextForceSwitch(performance.now()); } catch (_) {}
      this._triggerScene({ playId: playId, oldPlayId: null, reason: reasonTag || '启动即亮（随机首场景）' });
      this.firstTriggerDone = true;
    },

    // 首轮兜底：按能量特征粗略选 playId（改为 70% 按段落加权选 + 30% 完全随机）
    _pickFirstByFeatures(features, playIds) {
      if (!playIds || playIds.length === 0) return null;
      if (playIds.length === 1) return playIds[0];
      const seg = this._detectSimpleSegment(features);
      const idxMap = { drop: 0, chorus: 1, verse: 2, bridge: 3 };
      const prefIdx = idxMap[seg] || 0;
      // 30% 完全随机；70% 按段落附近 ±1 位置里挑
      if (Math.random() < 0.3) {
        return playIds[Math.floor(Math.random() * playIds.length)];
      }
      const offsets = [-1, 0, 1];
      const candidates = offsets
        .map(off => playIds[((prefIdx + off) % playIds.length + playIds.length) % playIds.length])
        .filter(p => p);
      if (candidates.length === 0) return playIds[0];
      return candidates[Math.floor(Math.random() * candidates.length)];
    },

    _detectSimpleSegment(features) {
      if (features.bassEnergy > 0.6 && features.bassEnergy / (features.overallEnergy + 0.001) > 0.5) return 'drop';
      if (features.overallEnergy > 0.4) return 'chorus';
      if (features.overallEnergy < 0.2) return 'verse';
      return 'bridge';
    },

    // 触发控台场景（走现有 console-remote-cmd IPC）
    // 每次切换先 STOP 池内除新 playId 外的所有场景（保险性互斥，确保最多只亮一个），再 PLAY 新场景
    _triggerScene(result) {
      const self = this;
      try {
        const electron = require('electron');
        const ipcRenderer = electron.ipcRenderer;
        // 范围保护：必须在 playIds 池内（双重保险）
        if (!this.config.playIds.includes(result.playId)) {
          console.warn('[AI触发] 拒绝触发范围外 playId:', result.playId, '，池=', this.config.playIds);
          return;
        }
        const newPlayId = result.playId;
        const pool = this.config.playIds;
        // ===== 批量互斥 STOP：池内所有 ≠ newPlayId 的 playId 都发一次 stop =====
        // （彻底避免"旧场景不关闭"，即使单独 stop oldPlayId 因为 IPC 顺序/控台没响应而失败，也会在这里兜底）
        let stopCount = 0;
        pool.forEach(function(pid) {
          if (pid === newPlayId) return;
          try {
            ipcRenderer.send('console-remote-cmd', { action: 'stop', playId: pid });
            stopCount++;
          } catch (_) {}
        });
        // 触发新场景
        ipcRenderer.send('console-remote-cmd', { action: 'play', playId: newPlayId });
        if (this.debug) {
          const extra = stopCount > 0 ? ('（互斥STOP池内其余 ' + stopCount + ' 个）') : '';
          console.log('[AI触发] ' + result.reason + ' → playId: ' + newPlayId + extra);
        }
      } catch(e) {
        console.error('AI触发: 场景触发失败', e);
      }
    }
  };

  window.AiTrigger = AiTrigger;
})();
