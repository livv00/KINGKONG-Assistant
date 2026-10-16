<div align="center">

# 金刚助手 · Jingang Assistant

**面向直播 / 现场演出的一站式音频与灯光控制客户端**

基于 Electron 打造，整合音乐播放与剪辑、大屏投放、硬件控台连接、灯光联动（Art-Net / sACN）、OBS 切镜、全局快捷键、手机远程控制、MIDI 时间码（MTC）等能力。

</div>

---

## 简介

金刚助手是一款专为**舞台演出、Live 直播、现场活动、视频节目录制**等场景打造的综合控制软件。

它将「音乐播放器 + 音频剪辑 + 大屏投放 + 控台联动 + 灯光控制 + 远程遥控」整合进一个客户端，通过 **主界面 + 悬浮窗 + 全局快捷键** 的组合实现「边播边控」，适用于专业直播与现场导播。

## 功能特性

| 模块 | 说明 |
| --- | --- |
| 🎵 分组 / 音乐 | 分组管理、播放控制、随机/顺序/循环模式、音量与进度记忆 |
| ✂️ 音乐剪辑 | 可视化波形剪辑，剪切、淡入淡出、格式转换，成品直接入库 |
| 🎼 多轨混音 | 多轨时间轴编辑器（PyQt6 模块），拖拽拼接并导出成品音乐 |
| ⬇️ 音乐下载 | 对接网络音乐平台，搜索、下载并保存到本地分组 |
| 🎬 大屏投放 | 副屏播放视频 / 滚动图片 / 全屏背景，直播画面背景专用 |
| 🎛️ 连接控台 | 通过 TCP 连接硬件控台，同步节目/场景/推杆，支持快捷键与远程控制 |
| 💡 灯光联动 | Art-Net / sACN 协议驱动灯光，多通道灯库映射播放状态 |
| 🖥️ OBS 切镜 | OBS WebSocket 场景切换，支持时间点自动分镜与快捷键触发 |
| ⌨️ 全局快捷键 | Windows 系统级热键，最小化后仍可控制播放、切歌 |
| 🌐 远程控制 | 手机 / 浏览器接入内置 WebSocket + HTTP 服务远程操控本软件 |
| 🕐 MIDI 时间码 | 发送 / 接收 MTC 时间码，用于联动录音、同步播放 |
| 🔊 音频设备 | 列出系统全部音频输出接口，可独立指定播放设备 |
| 🎨 主题系统 | 暗黑 / 明亮 / 粉嫩 / 酷橙 四套主题，所有窗口实时同步 |
| 🪟 悬浮窗 | 无边框置顶小窗，显示歌曲信息与播放控制 |
| 💻 系统媒体控件 | 集成 Windows SMTC，支持系统级媒体按键与信息显示 |

## 技术栈

- **Electron 25 + Node.js**（主进程 / 渲染进程）
- **原生 HTML / CSS / JavaScript**（无前端框架），8 语言国际化（中 / 英 / 日 / 韩 / 法 / 德 / 西 / 俄）
- **Python 3 + PyQt6**（多轨混音编辑器模块）
- **通信协议**：TCP、UDP、WebSocket、Art-Net、sACN、MIDI（MTC）、OBS WebSocket
- **内置 HTTP 控制服务**（默认端口 `1995`），局域网内手机扫码即可远程控制

## 目录结构

```
├── main.js                  # Electron 主进程入口
├── api-server.js            # 内置 HTTP / API 服务
├── index.html               # 主界面
├── console-connect.html     # 连接控台
├── cabinet-manager.html     # 电柜管理
├── big-screen.html          # 大屏投放
├── remote-control.html      # 手机远程控制页
├── audio-clipper.html       # 音乐剪辑
├── music-download.html      # 音乐下载
├── artnet-trigger.html      # Art-Net 触发
├── floating-window.html     # 悬浮窗
├── splash.html              # 开屏页
├── js/                      # 渲染进程脚本
│   ├── i18n.js              # 国际化框架
│   └── i18n/                # 8 个语言包
├── *.py                     # 多轨混音编辑器（PyQt6）
├── scripts/                 # 构建辅助脚本
├── docs/                    # 设计与规格文档
└── build-obfuscated.js      # 混淆 + 打包脚本
```

## 快速开始

### 环境要求

- Windows 10 / 11
- Node.js ≥ 18
- Python 3.10+ 与 PyQt6（仅「多轨混音编辑器」模块需要）

### 运行

```bash
npm install
npm start
```

### 打包

```bash
npm run build            # 使用 electron-builder 打包
node build-obfuscated.js # 混淆 + 打包（发布流程）
```

## 使用文档

- [产品功能说明](产品功能说明.md)
- [金刚助手使用说明书](金刚助手使用说明书.md)

## 许可

本项目基于 [MIT](LICENSE) 许可证开源。
