// 音乐管理模块

// 全局变量
let audioElement = null;
let currentPlayingIndex = -1;
let currentGroup = 0;
let groups = [{ id: 0, name: '分组1', musicList: [] }];
let udpSettings = {};
let groupPlaybackEnabled = false;
let bigScreenWindow = null;

// 初始化音频元素
function initAudioElement() {
  audioElement = new Audio();
  // crossOrigin='anonymous'：支持对本地/远程音频做 Web Audio 分析
  // （file:// 在 Electron 下设此属性无害；http(s):// 必须设否则 createMediaElementSource 拿不到 FFT 数据）
  try { audioElement.crossOrigin = 'anonymous'; } catch(_) {}
  audioElement.addEventListener('ended', handleAudioEnded);
  audioElement.addEventListener('timeupdate', handleTimeUpdate);
  return audioElement;
}

// 播放音乐
function playMusic(index) {
  // 检查currentGroup是否有效
  if (currentGroup < 0 || currentGroup >= groups.length) {
    console.error(`无效的当前分组ID: ${currentGroup}`);
    return;
  }
  
  // 获取当前音乐
  const currentGroupMusic = groups[currentGroup].musicList;
  if (!currentGroupMusic || !currentGroupMusic[index]) {
    console.error(`无效的音乐索引: ${index}`);
    return;
  }
  const currentMusic = currentGroupMusic[index];
  
  // 播放对应的视频
  if (bigScreenWindow) {
    if (currentMusic.video) {
      // 直接通过webContents向大屏窗口发送消息
      bigScreenWindow.webContents.send('playVideo', {
        videoPath: currentMusic.video,
        loop: currentMusic.videoLoop !== false
      });
    } else {
      // 如果没有视频素材，发送停止视频的消息，确保大屏保持黑屏
      bigScreenWindow.webContents.send('stopVideo');
    }
  }
  
  // 检查是否是当前正在播放的音乐
  if (audioElement && currentPlayingIndex === index) {
    if (audioElement.paused) {
      // 如果是同一首音乐且已暂停，直接继续播放
      audioElement.play().catch(error => {
        console.error('播放错误:', error);
      });
      // 更新播放状态
      updateMusicStatus(index, 'playing');
      // 更新播放/暂停按钮图标
      const playPauseBtn = document.getElementById('playPauseBtn');
      if (playPauseBtn) {
        playPauseBtn.textContent = '⏸';
      }
      // 发送UDP触发（恢复播放时也需要发送）
      if (window.udpEnabled && udpSettings[currentGroup] && udpSettings[currentGroup][index] && udpSettings[currentGroup][index].enabled) {
        window.sendUdpCommand(udpSettings[currentGroup][index]);
      }
      // 重新启动进度条更新
      startProgressUpdate();
      // AI触发：继续播放→重启分析循环（不重置匹配状态，继续同一首歌的段落）
      if (window.AiTrigger && typeof AiTrigger.resume === 'function') AiTrigger.resume();
    }
    return;
  }
  
  // 处理当前播放的音乐
  if (audioElement) {
    if (groupPlaybackEnabled) {
      // 如果分组保留播放开启，暂停当前音乐但保留进度
      audioElement.pause();
      clearInterval(audioElement.updateInterval);
    } else {
      // 如果分组保留播放关闭，停止当前音乐并将播放时间归0
      audioElement.pause();
      audioElement.currentTime = 0;
      clearInterval(audioElement.updateInterval);
      
      // 重置所有音乐的状态为未播放，除了当前要播放的
      const musicCards = document.querySelectorAll('.music-card');
      musicCards.forEach((card, idx) => {
        if (idx !== index) {
          card.classList.remove('playing', 'paused', 'stopped');
          card.classList.add('unplayed');
        }
      });
      
      // 重置所有分组的播放状态
      if (groups && groups.length > 0) {
        groups.forEach((group, index) => {
          group.playingIndex = -1;
        });
      }
      
      // 更新所有分组的状态指示器
      if (window.updateGroupStatusIndicators) {
        window.updateGroupStatusIndicators();
      }
    }
  }
  
  // 加载并播放新音乐
  if (!audioElement) {
    audioElement = initAudioElement();
  }
  
  audioElement.src = currentMusic.url;
  audioElement.play().catch(error => {
    console.error('播放错误:', error);
  });
  // AI触发：通知总控模块开始分析
  if (window.AiTrigger) AiTrigger.onPlay(audioElement);
  
  // 更新当前播放索引
  currentPlayingIndex = index;
  groups[currentGroup].playingIndex = index;
  
  // 更新播放状态
  updateMusicStatus(index, 'playing');
  
  // 更新播放/暂停按钮图标
  const playPauseBtn = document.getElementById('playPauseBtn');
  if (playPauseBtn) {
    playPauseBtn.textContent = '⏸';
  }
  
  // 更新当前播放信息
  const currentTitle = document.getElementById('currentTitle');
  if (currentTitle) {
    currentTitle.textContent = currentMusic.title;
  }
  
  // 发送UDP触发
  if (window.udpEnabled && udpSettings[currentGroup] && udpSettings[currentGroup][index] && udpSettings[currentGroup][index].enabled) {
    window.sendUdpCommand(udpSettings[currentGroup][index]);
  }
  
  // 启动进度条更新
  startProgressUpdate();
  
  // 更新分组状态指示器
  if (window.updateGroupStatusIndicators) {
    window.updateGroupStatusIndicators();
  }
}

// 暂停音乐
function pauseMusic() {
  if (audioElement && !audioElement.paused) {
    audioElement.pause();
    updateMusicStatus(currentPlayingIndex, 'paused');
    const playPauseBtn = document.getElementById('playPauseBtn');
    if (playPauseBtn) {
      playPauseBtn.textContent = '▶';
    }
    clearInterval(audioElement.updateInterval);
    // AI触发：暂停播放→暂停分析循环（不重置 matcher 状态，继续播放时从中断点恢复）
    if (window.AiTrigger && typeof AiTrigger.pause === 'function') AiTrigger.pause();
  }
}

// 停止音乐
function stopMusic() {
  // AI触发：停止分析
  if (window.AiTrigger) AiTrigger.onStop();
  if (audioElement) {
    audioElement.pause();
    audioElement.currentTime = 0;
    updateMusicStatus(currentPlayingIndex, 'stopped');
    const playPauseBtn = document.getElementById('playPauseBtn');
    if (playPauseBtn) {
      playPauseBtn.textContent = '▶';
    }
    clearInterval(audioElement.updateInterval);
    
    // 重置进度条
    const progressFill = document.getElementById('progressFill');
    const progressDot = document.getElementById('progressDot');
    const currentTime = document.getElementById('currentTime');
    if (progressFill) progressFill.style.width = '0%';
    if (progressDot) progressDot.style.left = '0%';
    if (currentTime) currentTime.textContent = '00:00';
    
    // 发送UDP停止命令
    if (window.udpEnabled && currentPlayingIndex !== -1 && 
        udpSettings[currentGroup] && udpSettings[currentGroup][currentPlayingIndex] && 
        udpSettings[currentGroup][currentPlayingIndex].enabled) {
      window.sendUdpStopCommand(udpSettings[currentGroup][currentPlayingIndex]);
    }
    
    // 重置当前播放索引
    currentPlayingIndex = -1;
    if (groups[currentGroup]) {
      groups[currentGroup].playingIndex = -1;
    }
    
    // 更新分组状态指示器
    if (window.updateGroupStatusIndicators) {
      window.updateGroupStatusIndicators();
    }
  }
}

// 播放上一首
function playPrevious() {
  const currentGroupMusic = groups[currentGroup].musicList;
  if (currentGroupMusic.length > 0) {
    let prevIndex = currentPlayingIndex - 1;
    if (prevIndex < 0) {
      prevIndex = currentGroupMusic.length - 1;
    }
    playMusic(prevIndex);
  }
}

// 播放下一首
function playNext() {
  const currentGroupMusic = groups[currentGroup].musicList;
  if (currentGroupMusic.length > 0) {
    let nextIndex = currentPlayingIndex + 1;
    if (nextIndex >= currentGroupMusic.length) {
      nextIndex = 0;
    }
    playMusic(nextIndex);
  }
}

// 处理音频结束事件
function handleAudioEnded() {
  // 根据循环模式处理
  if (window.repeatMode === 'single' || window.repeatMode === 'one') {
    // 单曲循环或单曲播放
    if (window.repeatMode === 'single') {
      // 单曲循环，重新播放（重置 AI匹配状态，当作新歌开始）
      if (window.AiTrigger && typeof AiTrigger.onPlay === 'function') AiTrigger.onPlay(audioElement);
      audioElement.currentTime = 0;
      audioElement.play().catch(error => {
        console.error('播放错误:', error);
      });
    } else {
      // 单曲播放，停止
      stopMusic();
    }
  } else {
    // 列表播放或列表循环
    const currentGroupMusic = groups[currentGroup].musicList;
    if (currentGroupMusic.length > 0) {
      let nextIndex = currentPlayingIndex + 1;
      if (nextIndex >= currentGroupMusic.length) {
        if (window.repeatMode === 'listRepeat') {
          // 列表循环，回到第一首
          nextIndex = 0;
        } else {
          // 列表播放，停止
          stopMusic();
          return;
        }
      }
      playMusic(nextIndex);
    }
  }
}

// 处理音频时间更新事件
function handleTimeUpdate() {
  if (audioElement && !audioElement.paused) {
    const currentTimeValue = audioElement.currentTime;
    const duration = audioElement.duration;
    if (duration > 0) {
      const progress = (currentTimeValue / duration) * 100;
      const progressFill = document.getElementById('progressFill');
      const progressDot = document.getElementById('progressDot');
      const currentTime = document.getElementById('currentTime');
      const totalTime = document.getElementById('totalTime');
      
      if (progressFill) progressFill.style.width = progress + '%';
      if (progressDot) progressDot.style.left = progress + '%';
      if (currentTime) currentTime.textContent = window.utils.formatTime(currentTimeValue);
      if (totalTime) totalTime.textContent = window.utils.formatTime(duration);
    }
  }
}

// 启动进度条更新
function startProgressUpdate() {
  clearInterval(audioElement.updateInterval);
  audioElement.updateInterval = setInterval(() => {
    if (audioElement && !audioElement.paused) {
      const currentTimeValue = audioElement.currentTime;
      const duration = audioElement.duration;
      if (duration > 0) {
        const progress = (currentTimeValue / duration) * 100;
        const progressFill = document.getElementById('progressFill');
        const progressDot = document.getElementById('progressDot');
        const currentTime = document.getElementById('currentTime');
        const totalTime = document.getElementById('totalTime');
        
        if (progressFill) progressFill.style.width = progress + '%';
        if (progressDot) progressDot.style.left = progress + '%';
        if (currentTime) currentTime.textContent = window.utils.formatTime(currentTimeValue);
        if (totalTime) totalTime.textContent = window.utils.formatTime(duration);
      }
    }
  }, 100);
}

// 更新音乐状态
function updateMusicStatus(index, status) {
  const musicCards = document.querySelectorAll('.music-card');
  if (musicCards[index]) {
    const card = musicCards[index];
    card.classList.remove('playing', 'paused', 'stopped', 'unplayed');
    card.classList.add(status);
  }
}

// 初始化音乐模块
function initMusicModule() {
  audioElement = initAudioElement();
  
  // 绑定播放控制按钮
  const playPauseBtn = document.getElementById('playPauseBtn');
  const stopBtn = document.getElementById('stopBtn');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  
  if (playPauseBtn) {
    playPauseBtn.addEventListener('click', function() {
      if (audioElement && !audioElement.paused) {
        pauseMusic();
      } else if (currentPlayingIndex !== -1) {
        playMusic(currentPlayingIndex);
      } else if (groups[currentGroup].musicList.length > 0) {
        playMusic(0);
      }
    });
  }
  
  if (stopBtn) {
    stopBtn.addEventListener('click', stopMusic);
  }
  
  if (prevBtn) {
    prevBtn.addEventListener('click', playPrevious);
  }
  
  if (nextBtn) {
    nextBtn.addEventListener('click', playNext);
  }
  
  // 绑定音量控制
  const volumeSlider = document.getElementById('volumeSlider');
  if (volumeSlider) {
    volumeSlider.addEventListener('input', function() {
      if (audioElement) {
        audioElement.volume = parseFloat(this.value);
      }
    });
  }
  
  // 绑定进度条点击
  const progressBar = document.getElementById('progressBar');
  if (progressBar) {
    progressBar.addEventListener('click', function(e) {
      if (audioElement && !isNaN(audioElement.duration)) {
        const rect = this.getBoundingClientRect();
        const position = (e.clientX - rect.left) / rect.width;
        audioElement.currentTime = position * audioElement.duration;
      }
    });
  }
}

// 导出音乐模块
window.musicModule = {
  init: initMusicModule,
  play: playMusic,
  pause: pauseMusic,
  stop: stopMusic,
  playPrevious: playPrevious,
  playNext: playNext,
  getCurrentPlayingIndex: () => currentPlayingIndex,
  setCurrentGroup: (index) => currentGroup = index,
  getCurrentGroup: () => currentGroup,
  getGroups: () => groups,
  setGroups: (newGroups) => groups = newGroups,
  getUdpSettings: () => udpSettings,
  setUdpSettings: (newSettings) => udpSettings = newSettings,
  setGroupPlaybackEnabled: (enabled) => groupPlaybackEnabled = enabled,
  setBigScreenWindow: (window) => bigScreenWindow = window
};