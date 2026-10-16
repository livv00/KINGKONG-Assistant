# AI 触发功能设计文档

> 播放音乐时，实时分析音频特征，自动触发控台场景(playId)。

## 1. 目标

- 播放音乐时自动分析音频（节拍/频段/能量/BPM），根据音乐段落变化自动切换控台场景。
- 用户只需配置"切换模式"和"触发场景范围"，助手智能匹配，无需手写规则。
- 场景范围保护：只在用户选定的 playId 组内切换，绝不影响控台上范围外的其他场景。

## 2. UI 入口与交互

### 2.1 入口位置
- 文件：`console-connect.html`
- 位置：按钮栏 `conn-bar` 内，"快捷键"按钮(L583)之后，"全局快捷键"开关之前。
- 按钮：`<button class="btn btn-default" onclick="openAiTriggerModal()">AI触发</button>`（打开配置弹窗）
- 开关：按钮右侧紧跟一个 toggle，复用 `sc-toggle-wrap` 样式（和"全局快捷键"开关一致），label="AI触发"，默认关闭。
- 样式：复用现有 `btn btn-default` / `sc-toggle-wrap`，符合主题色（--accent / --theme-color）。

### 2.2 配置面板
- 复用快捷键弹窗的 `mask + sc-modal` 结构风格。
- 标题："AI 触发设置"
- 面板内容（两个参数）：
  1. **切换模式**（下拉选择）：
     - `段落切换`（默认）：检测音乐段落边界(主歌→副歌→间奏)时切换，一首歌切 3-5 次
     - `每拍切换`：每个 beat 切一个场景，连续轮换
     - `每小节切换`：每 4 拍切一个场景
  2. **触发场景范围**（多选）：
     - 从控台已加载的节目列表(playId)中多选，复选框 + 节目名称
     - 选中的 playId 组成"场景池"，AI 只在这组里切换
- 底部按钮：取消 / 确定（和快捷键弹窗一致）
- **键盘交互**：回车 = 确定(保存)，ESC = 取消(关闭)
- 点击遮罩(空白区) = 取消(关闭)

### 2.3 启用/禁用开关（记忆状态）
- 位置：按钮栏 `conn-bar` 内，"AI触发"按钮右侧，复用 `sc-toggle-wrap` 样式（和"全局快捷键"开关一致）。
- 默认关闭。
- **记忆状态**：开关状态存 `localStorage('aiTriggerEnabled')`。
  - 窗口加载时读取并恢复（已开→自动开，已关→自动关）。
  - 软件重启后同样恢复最后状态，无需重复操作。
  - 开关变化时实时写入 localStorage。
- 开启时：播放音乐自动分析音频并触发场景。
- 关闭时：不做任何音频分析，不影响正常播放。

## 3. 技术架构（5 层数据流）

```
Audio 元素 → ① Web Audio API 接入(AnalyserNode FFT)
          → ② 音频分析引擎(3-band split + beat 检测 + BPM)
          → ③ AudioFeatures 输出
          → ④ 场景智能匹配(段落检测 + 场景池选择)
          → ⑤ 触发执行(console-remote-cmd IPC → 控台)
```

### 3.1 音频接入层
- 渲染进程(index.html)播放音乐用 HTML5 `Audio` 元素(js/music.js)。
- 播放时创建 `AudioContext` + `createMediaElementSource` + `AnalyserNode(fftSize=2048)`。
- 切歌时 `source.disconnect()` 释放，新歌重连。
- 支持 /stream 代理流和本地文件（createMediaElementSource 两者通用）。

### 3.2 音频分析引擎（借鉴 NeewerLite / WLED）
- FFT → dB→[0,1] 归一化
- Noise Gate（RMS floor + spectral flatness，静音不响应）
- 3-band split：Bass(bin 0-6) / Mids(7-93) / Highs(94-511)，每段独立 AGC(peak decay 0.997) + power compression(pow 0.6)
- Beat 检测：spectral flux vs 移动平均(sensitivity 1.5)，min interval 0.2s，BPM = 最近 16 beat 间隔中位数
- 输出 AudioFeatures：{bassEnergy, midEnergy, highEnergy, isBeat, beatIntensity, bpm, overallEnergy, ...}

### 3.3 场景智能匹配（金刚助手特有）
- **段落检测**：overallEnergy + spectralCentroid 滑动窗口变化率，检测段落边界(低能量→高能量→中能量)。
- **场景选择**：
  - 段落切换模式：段落边界时，根据段落特征(bass爆发→playId[0]，副歌→playId[1]，主歌→playId[2]，间奏→playId[3])从场景池选一个
  - 每拍模式：每个 beat 按顺序轮换场景池里的 playId
  - 每小节模式：每 4 拍轮换一个
- **防抖**：同一段落内不重复切换（段落模式）；最小切换间隔 2s（所有模式）。
- **范围保护**：只从用户配置的 playId 池里选，绝不触发范围外场景。

### 3.4 触发执行
- 选出 playId 后走现有 `console-remote-cmd` IPC 通道(main.js L1198)：
  - 先 `stop` 旧 playId（若互斥保护开启），再 `play` 新 playId。
- 不新建协议，复用 console-connect.html 已有的 play/stop/toggleMutex 逻辑。

## 4. 配置数据结构

```js
// 存储在控台配置(localStorage)，和快捷键配置同级
aiTriggerConfig = {
  enabled: false,              // 是否启用
  switchMode: 'paragraph',     // 'paragraph' | 'beat' | 'bar'
  playIds: ['101','102','103'] // 场景池（用户多选的 playId）
}
```

## 5. 落地文件清单

| 文件 | 改动 |
|---|---|
| `console-connect.html` | 按钮 + 配置弹窗 UI + 配置存取 + 启用开关 |
| `js/audio-analyser.js`（新建） | 音频分析引擎(FFT→3-band→beat→AudioFeatures) |
| `js/scene-matcher.js`（新建） | 段落检测 + 场景选择逻辑 |
| `index.html` | 播放循环接入 analyser/matcher，播放时触发 console-remote-cmd |
| `js/music.js` | 播放/切歌时创建/释放 AudioContext + AnalyserNode |

## 6. 开放问题（待确认）

1. 音频源：默认 /stream 代理流 + 本地文件都支持（createMediaElementSource 通用），无需区分。
2. 场景池数量：由用户多选自定，建议 3-6 个效果最佳。
3. 是否需要"灵敏度"滑块：当前用固定参数(sensitivity 1.5)，后续可加。
