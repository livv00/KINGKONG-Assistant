// AI触发 - 音频分析引擎
// 借鉴 NeewerLite Sound-to-Light Engine + WLED Sound Reactive
// 输入 Web Audio AnalyserNode，每帧调用 update() 输出 AudioFeatures 对象

(function() {
  'use strict';

  // 工具：限幅
  function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

  class AudioAnalyser {
    constructor(analyser) {
      this.analyser = analyser;
      this.freqData = new Float32Array(analyser.frequencyBinCount); // 1024 bins, dB 值
      this.timeData = new Uint8Array(analyser.fftSize);            // 2048, 0-255

      // 频段范围（bin 索引，sampleRate≈44100, fftSize=2048, binHz≈21.5Hz）
      // bass:  20-150Hz   → bin 0-6
      // mids:  150-2000Hz → bin 7-93
      // highs: 2000-11000Hz → bin 94-511
      this.bassRange = [0, 7];
      this.midRange = [7, 94];
      this.highRange = [94, 512];

      // per-band AGC 峰值（自动增益控制）
      this.bassPeak = 0.001;
      this.midPeak = 0.001;
      this.highPeak = 0.001;
      this.agcDecay = 0.997; // 峰值衰减率

      // 各段上一帧能量（用于 spectral flux 变化率计算）
      this.prevBassEnergy = 0;
      this.prevMidEnergy = 0;
      this.prevHighEnergy = 0;
      this.prevOverallEnergy = 0;

      // Beat 检测
      this.fluxHistory = [];
      this.fluxWindowSize = 32;  // ~0.7s at 46fps
      this.sensitivity = 1.5;   // 灵敏度倍数
      this.minBeatIntervalMs = 200;
      this.lastBeatTime = 0;
      this.beatIntervals = [];  // 用于 BPM 估算
      this.maxBeatIntervals = 16;
      this.bpm = 0;
      this.beatIntensity = 0;
      this.beatPhase = 0;       // 0-1, beat 周期相位

      // Noise gate（带滞后保持，防频繁开关）
      this.noiseGateOpen = false;
      this.gateHold = 0;

      // 段落检测用能量历史
      this.energyHistory = [];
      this.energyHistorySize = 180; // ~4s at 46fps
    }

    // 主分析函数：每帧调用，返回 AudioFeatures
    update() {
      // 1. 获取频谱（dB）和时域（0-255）数据
      this.analyser.getFloatFrequencyData(this.freqData);
      this.analyser.getByteTimeDomainData(this.timeData);

      // 2. dB→[0,1] 归一化 (minDb=-100, maxDb=-10)
      const normalized = this._normalize(this.freqData);

      // 3. Noise gate（RMS floor + spectral flatness，静音不响应）
      const rms = this._calcRMS(this.timeData);
      const flatness = this._calcSpectralFlatness(normalized);
      this._updateNoiseGate(rms, flatness);

      // 4. 3-band 能量 + per-band AGC + power compression
      const bassRaw = this._bandEnergy(normalized, this.bassRange);
      const midRaw = this._bandEnergy(normalized, this.midRange);
      const highRaw = this._bandEnergy(normalized, this.highRange);

      const bassEnergy = this._agc('bass', bassRaw);
      const midEnergy = this._agc('mid', midRaw);
      const highEnergy = this._agc('high', highRaw);

      // 5. spectral flux（各段半波整流变化率）
      const bassFlux = Math.max(0, bassEnergy - this.prevBassEnergy);
      const midFlux = Math.max(0, midEnergy - this.prevMidEnergy);
      const highFlux = Math.max(0, highEnergy - this.prevHighEnergy);
      this.prevBassEnergy = bassEnergy;
      this.prevMidEnergy = midEnergy;
      this.prevHighEnergy = highEnergy;

      const overallEnergy = (bassEnergy + midEnergy + highEnergy) / 3;
      const overallFlux = Math.max(0, overallEnergy - this.prevOverallEnergy);
      this.prevOverallEnergy = overallEnergy;

      // 6. Beat 检测（spectral flux vs 移动平均）
      const isBeat = this._detectBeat(overallFlux);

      // 7. beat phase（基于 BPM 的周期相位 0-1）
      this._updateBeatPhase();

      // 8. 段落检测用能量历史
      this.energyHistory.push(overallEnergy);
      if (this.energyHistory.length > this.energyHistorySize) this.energyHistory.shift();

      // 9. spectral centroid（高频占比，用于段落特征判断）
      const spectralCentroid = (midEnergy + highEnergy) / (bassEnergy + midEnergy + highEnergy + 0.001);

      return {
        bassEnergy: bassEnergy,
        midEnergy: midEnergy,
        highEnergy: highEnergy,
        bassFlux: bassFlux,
        midFlux: midFlux,
        highFlux: highFlux,
        overallEnergy: overallEnergy,
        overallFlux: overallFlux,
        spectralCentroid: spectralCentroid,
        spectralFlatness: flatness,
        isBeat: isBeat,
        beatIntensity: this.beatIntensity,
        bpm: this.bpm,
        beatPhase: this.beatPhase,
        noiseGateOpen: this.noiseGateOpen,
        rms: rms,
        energyHistory: this.energyHistory
      };
    }

    // dB→[0,1] 归一化
    _normalize(freqData) {
      const minDb = -100, maxDb = -10;
      const out = new Float32Array(freqData.length);
      for (let i = 0; i < freqData.length; i++) {
        out[i] = clamp((freqData[i] - minDb) / (maxDb - minDb), 0, 1);
      }
      return out;
    }

    // RMS（时域波形，0-1）
    _calcRMS(timeData) {
      let sum = 0;
      for (let i = 0; i < timeData.length; i++) {
        const v = (timeData[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / timeData.length);
    }

    // 谱平坦度（0-1，越接近1越像白噪声）
    _calcSpectralFlatness(norm) {
      let geoLogSum = 0, arithSum = 0, n = 0;
      for (let i = 0; i < norm.length; i++) {
        if (norm[i] > 0.001) {
          geoLogSum += Math.log(norm[i]);
          arithSum += norm[i];
          n++;
        }
      }
      if (n === 0 || arithSum === 0) return 1;
      const geoMean = Math.exp(geoLogSum / n);
      const arithMean = arithSum / n;
      return clamp(geoMean / arithMean, 0, 1);
    }

    // Noise gate 更新（带滞后保持，防频繁开关）
    // RMS floor 0.03, flatness < 0.75（更宽容，真实音乐频谱更均匀也能通过）
    _updateNoiseGate(rms, flatness) {
      const shouldOpen = rms > 0.03 && flatness < 0.75;
      if (shouldOpen) {
        this.gateHold = 20; // 保持 20 帧不关（约 0.5s，更稳）
        this.noiseGateOpen = true;
      } else {
        if (this.gateHold > 0) {
          this.gateHold--;
          this.noiseGateOpen = true;
        } else {
          this.noiseGateOpen = false;
        }
      }
    }

    // 频段能量（归一化频谱的均值）
    _bandEnergy(norm, range) {
      let sum = 0;
      const end = Math.min(range[1], norm.length);
      const count = end - range[0];
      for (let i = range[0]; i < end; i++) sum += norm[i];
      return count > 0 ? sum / count : 0;
    }

    // per-band AGC + power compression
    _agc(band, energy) {
      let peak;
      if (band === 'bass') peak = this.bassPeak;
      else if (band === 'mid') peak = this.midPeak;
      else peak = this.highPeak;

      // 峰值衰减 + 更新
      peak = Math.max(peak * this.agcDecay, energy);

      if (band === 'bass') this.bassPeak = peak;
      else if (band === 'mid') this.midPeak = peak;
      else this.highPeak = peak;

      // 归一化到峰值
      let val = clamp(energy / (peak + 0.001), 0, 1);
      // power compression（压缩动态范围，exponent 0.6）
      val = Math.pow(val, 0.6);
      return val;
    }

    // Beat 检测（spectral flux vs 移动平均）
    _detectBeat(overallFlux) {
      this.fluxHistory.push(overallFlux);
      if (this.fluxHistory.length > this.fluxWindowSize) this.fluxHistory.shift();

      // 移动平均
      let sum = 0;
      for (let i = 0; i < this.fluxHistory.length; i++) sum += this.fluxHistory[i];
      const movingAvg = sum / this.fluxHistory.length;

      const now = performance.now();

      // beat 条件：flux 超过移动平均 × 灵敏度，且距上次 beat 足够远
      if (overallFlux > movingAvg * this.sensitivity
          && overallFlux > 0.01
          && now - this.lastBeatTime > this.minBeatIntervalMs) {

        this.beatIntensity = clamp(overallFlux / (movingAvg * this.sensitivity + 0.001), 0, 1);

        // BPM 估算（最近 16 个 beat 间隔的中位数）
        if (this.lastBeatTime > 0) {
          const interval = now - this.lastBeatTime;
          this.beatIntervals.push(interval);
          if (this.beatIntervals.length > this.maxBeatIntervals) this.beatIntervals.shift();
          if (this.beatIntervals.length >= 4) {
            const sorted = this.beatIntervals.slice().sort(function(a, b) { return a - b; });
            const median = sorted[Math.floor(sorted.length / 2)];
            const bpm = 60000 / median;
            // 合理范围 60-200
            if (bpm >= 60 && bpm <= 200) this.bpm = bpm;
          }
        }

        this.lastBeatTime = now;
        return true;
      }

      return false;
    }

    // beat phase（0-1，基于 BPM 的周期相位）
    _updateBeatPhase() {
      if (this.bpm <= 0 || this.lastBeatTime === 0) {
        this.beatPhase = 0;
        return;
      }
      const now = performance.now();
      const beatMs = 60000 / this.bpm;
      const phase = ((now - this.lastBeatTime) % beatMs) / beatMs;
      this.beatPhase = clamp(phase, 0, 1);
    }
  }

  window.AudioAnalyser = AudioAnalyser;
})();
