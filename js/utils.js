// 工具函数模块

// 格式化时间
function formatTime(seconds) {
  // 访问全局时间单位设置
  const currentTimeUnit = window.currentTimeUnit || 'hh:mm:ss:ff';
  
  switch (currentTimeUnit) {
    case 'mm:ss':
      const minutes = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      const milliseconds = Math.floor((seconds % 1) * 100);
      return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${milliseconds.toString().padStart(2, '0')}`;
    case 'measures.beats':
      // 假设4/4拍，每分钟120拍
      const totalBeats = seconds * 2; // 120拍/分钟 = 2拍/秒
      const measures = Math.floor(totalBeats / 4);
      const beats = Math.floor(totalBeats % 4);
      return `${measures}.${beats}`;
    case 'seconds':
      return seconds.toFixed(2);
    case 'samples':
      // 假设44.1kHz采样率
      return Math.floor(seconds * 44100).toString();
    case 'hh:mm:ss:ff':
      const frameRate = parseInt(document.getElementById('mtcFrameRateSelect').value) || 25;
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      const sec = Math.floor(seconds % 60);
      const frames = Math.floor((seconds % 1) * frameRate);
      return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
    case 'absoluteFrames':
      const frRate = parseInt(document.getElementById('mtcFrameRateSelect').value) || 25;
      return Math.floor(seconds * frRate).toString();
    default:
      const hrs = Math.floor(seconds / 3600);
      const min = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 100);
      if (hrs > 0) {
        return `${hrs.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
      } else {
        return `${min.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
      }
  }
}

// 显示自定义提示框
function showAlert(message) {
  const customAlert = document.getElementById('customAlert');
  const customAlertMessage = document.getElementById('customAlertMessage');
  const customAlertOverlay = document.getElementById('customAlertOverlay');
  const customAlertButton = document.getElementById('customAlertButton');
  
  if (customAlert && customAlertMessage && customAlertOverlay && customAlertButton) {
    customAlertMessage.textContent = message;
    customAlert.style.display = 'block';
    customAlertOverlay.style.display = 'block';
    
    customAlertButton.onclick = function() {
      customAlert.style.display = 'none';
      customAlertOverlay.style.display = 'none';
    };
  } else {
    alert(message);
  }
}

// 生成唯一ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// 深度克隆对象
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// 检查文件类型
function isAudioFile(file) {
  const fileName = file.name.toLowerCase();
  return file.type.startsWith('audio/') || 
         fileName.endsWith('.mp3') || 
         fileName.endsWith('.wav') || 
         fileName.endsWith('.ogg') || 
         fileName.endsWith('.flac');
}

function isVideoFile(file) {
  const fileName = file.name.toLowerCase();
  // 支持所有常见视频格式：mp4/avi/mov/mkv/wmv/m4v/webm/flv/f4v/rmvb/rm/3gp/mpeg/mpg/mpe/vob/ts/mts/m2ts/divx/asf/ogv/qt/mxf/gxf
  // 以及 file.type 以 video/ 开头的所有类型（覆盖浏览器识别的格式）
  return file.type.startsWith('video/') ||
         /\.(mp4|avi|mov|mkv|wmv|m4v|webm|flv|f4v|rmvb|rm|3gp|mpeg|mpg|mpe|vob|ts|mts|m2ts|divx|asf|wm|ogv|qt|mxf|gxf)$/.test(fileName);
}

// 导出工具函数
window.utils = {
  formatTime,
  showAlert,
  generateId,
  deepClone,
  isAudioFile,
  isVideoFile
};