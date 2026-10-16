// AI触发 - 场景智能匹配引擎（增加随机性 + 强制 4.5~6s 切换）
// 接收 AudioFeatures + 配置(switchMode, playIds)，输出要触发的 playId
// 范围保护：只从用户配置的 playIds 池里选，绝不触发范围外场景

(function() {
  'use strict';

  function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }
  function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function randRange(min, max) { return Math.random() * (max - min) + min; }

  class SceneMatcher {
    constructor() {
      this.currentPlayId = null;       // 当前正在播放的 playId
      this.lastSwitchTime = 0;         // 上次切换时间
      this.minSwitchIntervalMs = 2000; // 最小切换间隔（防抖，paragraph 模式）

      // ===== 强制切换：每 4.5 ~ 6 秒必须换一个场景（随机间隔，避免节奏死板）=====
      this.maxSwitchIntervalMs = 6000; // 上限（用户要求≤6s，实际取 4500~6000 之间随机）
      this.nextForceSwitchAt = 0;      // 下次强制切换的 deadline 时间戳

      // 段落检测
      this.currentSegment = null;     // 当前段落: 'verse'(主歌) / 'chorus'(副歌) / 'bridge'(间奏) / 'drop'(bass爆发)
      this.segmentHistorySize = 90;   // 段落窗口（~2s at 46fps）

      // beat/bar 轮换计数（随机拍数/小节数）
      this.beatCount = 0;              // 累计 beat 数
      this.barIndex = 0;               // 当前小节内 beat 数（0-3）
      this.beatSwitchEvery = this._randBeatSwitchEvery();  // beat 模式：每 N 拍切 1 次（2~5 拍随机）
      this.beatSwitchCountdown = this.beatSwitchEvery;    // 还剩多少拍切一次
      this.barSwitchEvery = this._randBarSwitchEvery();    // bar 模式：每 N 小节切 1 次（1~2 小节随机）
      this.barSwitchCountdown = this.barSwitchEvery;      // 还剩多少小节切一次
    }

    // ========== 随机数生成 ==========
    _randBeatSwitchEvery() { return randInt(2, 5); }   // beat 模式：2~5 拍切一次
    _randBarSwitchEvery()  { return randInt(1, 2); }   // bar 模式：1~2 小节切一次
    _randForceInterval()   { return randRange(4500, 6000); } // 强制切换：4.5~6s 随机

    /**
     * 从 playIds 池中随机选一个 playId
     * @param {string[]} playIds 池
     * @param {string|null} excludePlayId 排除的 playId（确保不和当前一样，除非池大小 1）
     */
    _pickRandom(playIds, excludePlayId) {
      if (!playIds || playIds.length === 0) return null;
      if (playIds.length === 1) return playIds[0];
      // 排除 excludePlayId 后随机选一个
      const pool = playIds.filter(p => p !== excludePlayId);
      if (pool.length === 0) return playIds[Math.floor(Math.random() * playIds.length)];
      return pool[Math.floor(Math.random() * pool.length)];
    }

    /**
     * 按段落权重随机：给当前段落对应索引的 playId 加权（更高概率选中），再加随机扰动
     */
    _pickBySegmentWeighted(segment, playIds, excludePlayId) {
      if (!playIds || playIds.length === 0) return null;
      if (playIds.length === 1) return playIds[0];
      // 段落→偏好索引，用户场景池可能没那么多，所以取模到池大小
      const segMap = { 'drop': 0, 'chorus': 1, 'verse': 2, 'bridge': 3 };
      const prefIdx = segMap[segment];
      // 70% 概率按段落偏好选（偏好在附近 2 个位置 +-1），30% 完全随机
      let candidates;
      if (prefIdx !== undefined && Math.random() < 0.7) {
        // 偏好索引 +-1，从这些位置里挑（过滤 exclude）
        const offsets = [-1, 0, 1];
        candidates = offsets
          .map(off => playIds[((prefIdx + off) % playIds.length + playIds.length) % playIds.length])
          .filter(p => p && p !== excludePlayId);
        if (candidates.length === 0) {
          candidates = playIds.filter(p => p !== excludePlayId);
        }
      } else {
        candidates = playIds.filter(p => p !== excludePlayId);
      }
      if (candidates.length === 0) return playIds[Math.floor(Math.random() * playIds.length)];
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // 重置下次强制切换 deadline（每次成功切换时调用）
    _scheduleNextForceSwitch(now) {
      this.nextForceSwitchAt = now + this._randForceInterval();
    }

    // 主匹配函数：返回 { playId, oldPlayId, reason } 或 null（不切换）
    match(features, config) {
      // 范围保护：没有场景池则不触发
      if (!config.playIds || config.playIds.length === 0) return null;

      const now = performance.now();

      // 初始化首次强制切换 deadline（第一次成功切换后或首次启动时设置）
      if (this.nextForceSwitchAt === 0) {
        // 首轮已经由 AiTrigger.firstTriggerDelayMs 触发，这里从 now 开始算 4.5~6s
        this._scheduleNextForceSwitch(now);
      }

      // ===== 优先级 1：强制切换（到了 deadline 必须切）=====
      if (this.currentPlayId && now >= this.nextForceSwitchAt && config.playIds.length > 1) {
        const nextId = this._pickRandom(config.playIds, this.currentPlayId);
        if (nextId) {
          const oldId = this.currentPlayId;
          this.currentPlayId = nextId;
          this.lastSwitchTime = now;
          this._scheduleNextForceSwitch(now);
          return { playId: nextId, oldPlayId: oldId, reason: '强制随机切换(≤6s)' };
        }
      }

      // Noise gate 关闭时（静音/噪声）不做段落/beat 判断，但强制切换仍可能生效（上面已处理）
      if (!features.noiseGateOpen) return null;

      if (config.switchMode === 'paragraph') {
        // paragraph 模式：2000ms 防抖，避免段落抖动频繁切换
        if (this.currentPlayId && now - this.lastSwitchTime < this.minSwitchIntervalMs) return null;
        return this._matchParagraph(features, config, now);
      } else if (config.switchMode === 'beat') {
        // beat 模式：100ms 防抖（防同一 beat 重复触发）
        if (this.currentPlayId && now - this.lastSwitchTime < 100) return null;
        return this._matchBeat(features, config, now);
      } else if (config.switchMode === 'bar') {
        if (this.currentPlayId && now - this.lastSwitchTime < 100) return null;
        return this._matchBar(features, config, now);
      }
      return null;
    }

    // 段落切换模式：检测段落边界，按段落特征选场景（加权随机+20%概率随机跳）
    _matchParagraph(features, config, now) {
      const energy = features.overallEnergy;
      const bassEnergy = features.bassEnergy;
      const energyHistory = features.energyHistory || [];

      // 需要足够的历史数据才能判断段落
      if (energyHistory.length < this.segmentHistorySize) return null;

      // 近期平均能量（2s 窗口）
      const recent = energyHistory.slice(-this.segmentHistorySize);
      let sum = 0;
      for (let i = 0; i < recent.length; i++) sum += recent[i];
      const recentAvg = sum / recent.length;

      // 判断段落类型
      let segment = null;
      // drop: bass 爆发（bass 能量高且占比大）
      if (bassEnergy > 0.6 && bassEnergy / (energy + 0.001) > 0.5) {
        segment = 'drop';
      }
      // chorus: 高能量段
      else if (recentAvg > 0.5) {
        segment = 'chorus';
      }
      // verse: 低能量稳定段
      else if (recentAvg < 0.25) {
        segment = 'verse';
      }
      // bridge: 中能量段
      else if (recentAvg < 0.5) {
        segment = 'bridge';
      }

      // 段落没变化或无法判断 → 不切换
      if (!segment || segment === this.currentSegment) return null;

      // 段落变化 → 30% 概率"随机跳任意场景"，70% 按段落加权选
      this.currentSegment = segment;
      let playId;
      if (Math.random() < 0.3) {
        playId = this._pickRandom(config.playIds, this.currentPlayId);
      } else {
        playId = this._pickBySegmentWeighted(segment, config.playIds, this.currentPlayId);
      }

      if (playId && playId !== this.currentPlayId) {
        const oldId = this.currentPlayId;
        this.currentPlayId = playId;
        this.lastSwitchTime = now;
        this._scheduleNextForceSwitch(now); // 主动切→重置强制切换 deadline
        return { playId: playId, oldPlayId: oldId, reason: '段落切换→' + segment };
      }
      return null;
    }

    // 每拍切换模式：随机 N 拍（2~5）切一次，场景随机（≠当前）
    _matchBeat(features, config, now) {
      if (!features.isBeat) return null;
      this.beatCount++;
      this.beatSwitchCountdown--;
      if (this.beatSwitchCountdown > 0) return null;
      // 到点了，切一次；然后重抽"下一次切的拍数"
      this.beatSwitchEvery = this._randBeatSwitchEvery();
      this.beatSwitchCountdown = this.beatSwitchEvery;

      const playId = this._pickRandom(config.playIds, this.currentPlayId);
      if (playId && playId !== this.currentPlayId) {
        const oldId = this.currentPlayId;
        this.currentPlayId = playId;
        this.lastSwitchTime = now;
        this._scheduleNextForceSwitch(now); // 主动切→重置强制切换 deadline
        return { playId: playId, oldPlayId: oldId, reason: '每拍切换(' + this.beatSwitchEvery + '拍随机#' + this.beatCount + ')' };
      }
      return null;
    }

    // 每小节切换模式：随机 N 小节（1~2）切一次，场景随机（≠当前）
    _matchBar(features, config, now) {
      if (!features.isBeat) return null;
      this.barIndex++;
      if (this.barIndex < 4) return null; // 攒够 4 拍 = 1 小节
      this.barIndex = 0;
      this.beatCount++;
      this.barSwitchCountdown--;
      if (this.barSwitchCountdown > 0) return null;

      // 到点了，切一次；然后重抽"下一次切的小节数"
      this.barSwitchEvery = this._randBarSwitchEvery();
      this.barSwitchCountdown = this.barSwitchEvery;

      const playId = this._pickRandom(config.playIds, this.currentPlayId);
      if (playId && playId !== this.currentPlayId) {
        const oldId = this.currentPlayId;
        this.currentPlayId = playId;
        this.lastSwitchTime = now;
        this._scheduleNextForceSwitch(now); // 主动切→重置强制切换 deadline
        return { playId: playId, oldPlayId: oldId, reason: '每小节切换(' + this.barSwitchEvery + '小节随机#' + this.beatCount + ')' };
      }
      return null;
    }

    // 重置状态（切歌时调用）
    reset() {
      this.currentPlayId = null;
      this.lastSwitchTime = 0;
      this.currentSegment = null;
      this.beatCount = 0;
      this.barIndex = 0;
      this.nextForceSwitchAt = 0;
      this.beatSwitchEvery = this._randBeatSwitchEvery();
      this.beatSwitchCountdown = this.beatSwitchEvery;
      this.barSwitchEvery = this._randBarSwitchEvery();
      this.barSwitchCountdown = this.barSwitchEvery;
    }
  }

  window.SceneMatcher = SceneMatcher;
})();
