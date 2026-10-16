/**
 * SharedAudioCore
 * ------------------
 * 全窗口共享的 AudioContext + MediaElementSource + AnalyserNode 单例。
 *
 * 为什么需要：
 *   Web Audio API 规定同一个 HTMLMediaElement 在一个窗口里最多只能
 *   createMediaElementSource 一次，重复创建会报错：
 *   "Failed to execute 'createMediaElementSource': HTMLMediaElement already
 *    connected previously to a different MediaElementSourceNode"。
 *   本项目里 AiTrigger（AI触发）和 AudioViz（进度条可视化）都需要
 *   AnalyserNode 数据，因此这里做一个共享单例 + 引用计数：
 *
 *      const shared = SharedAudioCore.ensure(myAudioEl);
 *      shared.getFreqBytes(uint8arr);  // 取频谱 (0~255)
 *      shared.getTimeBytes(uint8arr);  // 取时域波形 (0~255)
 *      shared.release();               // 不再使用时释放引用
 *
 * 切换音频：每次换一首新歌（newAudio）时再次调用 ensure(newAudio)，
 *           它会自动 detach 旧 audio 并 attach 新 audio。
 */
(function(global) {
  'use strict';

  const SharedAudioCore = {
    audioCtx: null,
    source: null,        // MediaElementAudioSourceNode （只挂一次，单例）
    analyser: null,      // AnalyserNode 单例（AiTrigger + Viz 共用）
    destGain: null,      // 最终连 destination 的 Gain，保证声音正常输出
    currentAudio: null,  // 当前连在 source 上的 HTMLMediaElement
    refCount: 0,

    _pendingResolvers: [], // 兼容老代码第一次调用需 await AudioContext.resume

    /**
     * 确保有一条连通的 source → analyser → destGain → destination 音频链，
     * 并把传入的 audioEl 作为输入。返回 { analyser, audioCtx, release }。
     * 同一 audio 多次调 ensure 只累加 refCount，不会重连。
     * 换了新 audioEl 会 detach 旧的（source.mediaElement 改绑为新 audioEl）。
     */
    ensure: function(audioEl) {
      const self = this;
      // 1. AudioContext 首次创建
      if (!self.audioCtx) {
        try {
          const AC = global.AudioContext || global.webkitAudioContext;
          self.audioCtx = new AC();
        } catch (e) {
          console.error('SharedAudioCore: 创建 AudioContext 失败', e);
          return null;
        }
      }
      // 2. analyser / destGain 首次创建（单例，只建一次）
      if (!self.analyser) {
        self.analyser = self.audioCtx.createAnalyser();
        self.analyser.fftSize = 2048;        // 1024 条频点 → 取频谱时足够精细
        self.analyser.smoothingTimeConstant = 0.78;
        // 一个共享的 gain 挂到 destination，避免多个节点要 destination
        self.destGain = self.audioCtx.createGain();
        self.destGain.gain.value = 1.0;
        try {
          self.destGain.connect(self.audioCtx.destination);
        } catch (_) {}
        try {
          self.analyser.connect(self.destGain);
        } catch (_) {}
      }
      // 3. 新 audio 或 audio 变了 → attach 到共享 MediaElementSource
      if (audioEl && audioEl !== self.currentAudio) {
        // 注意：createMediaElementSource 整个窗口生命周期只能调一次（同 HTMLMediaElement）。
        // 但"新 audioEl 每次都是新对象"，所以每个新 HTMLAudioElement 都可以且必须调一次。
        try {
          const newSource = self.audioCtx.createMediaElementSource(audioEl);
          // 旧 source（如果之前是同一个 audioElement）就不 disconnect，避免声音断掉
          // 这里 audioEl !== currentAudio 所以直接切换
          try { newSource.connect(self.analyser); } catch (_) {}
          self.source = newSource;
          self.currentAudio = audioEl;
        } catch (e) {
          // 典型错误：同一 audioEl 被重复 createMediaElementSource → 忽略，继续用
          console.warn('SharedAudioCore: createMediaElementSource 跳过（可能已连过）', e && e.message);
        }
      }
      // 4. 引用计数 + 自动跨浏览器 unlock
      self.refCount++;
      self.resumeCtx();
      return {
        audioCtx: self.audioCtx,
        analyser: self.analyser,
        release: function() { self.release(); }
      };
    },

    resumeCtx: function() {
      const ctx = this.audioCtx;
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        try {
          const p = ctx.resume();
          if (p && typeof p.then === 'function') p.catch(function(){});
        } catch (_) {}
      }
    },

    release: function() {
      if (this.refCount > 0) this.refCount--;
      // 保持链连通：其他模块可能还要用。不 disconnect。
    },

    /**
     * 取频谱（频率域）数据到 Uint8Array，长度通常 analyser.frequencyBinCount ≈ 1024，
     * 数值 0~255，越大代表这一档能量越高。若没数据返回传入的数组不变。
     */
    getFreqBytes: function(outUint8Arr) {
      if (this.analyser) {
        try { this.analyser.getByteFrequencyData(outUint8Arr); } catch(_) {}
      }
      return outUint8Arr;
    },

    /**
     * 取时域波形数据到 Uint8Array，数值 0~255，中心 128 是静息点。
     */
    getTimeBytes: function(outUint8Arr) {
      if (this.analyser) {
        try { this.analyser.getByteTimeDomainData(outUint8Arr); } catch(_) {}
      }
      return outUint8Arr;
    },

    /** 当前有音频在播放 & 有真实 FFT 数据流动（用来判断空态/静音衰减）。大致取平均能量。 */
    getAvgEnergy: function() {
      if (!this.analyser) return 0;
      const n = 256;
      if (!this._energyBuf || this._energyBuf.length !== n) this._energyBuf = new Uint8Array(n);
      try { this.analyser.getByteFrequencyData(this._energyBuf); } catch(_){ return 0; }
      let s = 0;
      for (let i = 0; i < n; i++) s += this._energyBuf[i];
      return (s / n) / 255; // 0~1
    }
  };

  global.SharedAudioCore = SharedAudioCore;
})(typeof window !== 'undefined' ? window : globalThis);
