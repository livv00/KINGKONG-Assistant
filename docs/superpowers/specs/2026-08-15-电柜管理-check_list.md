# 电柜管理 实现自检 Checklist（check_list.md）
> 对应 Spec：2026-08-15-电柜管理-design.md
> 对应 Tasks：2026-08-15-电柜管理-tasks.md
> 用法：执行完一个任务后，在每个「☐」打勾（完成 → ✅）。

## 一、主线隔离审查（最关键，先查！）
- [ ] **1.1** `index.html` 中**绝对不存在** ipcRenderer.invoke('cabinet:xxx') / ipcRenderer.on('cabinet-xxx') / require('dgram') 等电柜相关代码（仅允许一个入口按钮 send('open-cabinet-window')）。
- [ ] **1.2** main.js 中 UDP 收包回调 onCabinetRecvMessage / pendingList 定时器：**所有 webContents.send 只向 cabinetWindow**，不向 mainWindow 发送任何 cabinet 事件。
- [ ] **1.3** cabinet-manager.html 是**独立 BrowserWindow** 通过 loadFile 加载，不是 iframe / modal / 嵌入 index.html 的任何 DOM 节点。
- [ ] **1.4** 手动烟测：开电柜窗口，发送大量 UDP 垃圾包（或故意在电柜 JS 写一个 1 亿次 for 循环卡死渲染进程），此时回到主界面音乐播放 / 控台连接 / 快捷键触发 **完全正常**。

## 二、入口按钮
- [ ] **2.1** 主界面右上角「⚡ 电柜管理」按钮的**相对顺序正确**：右边邻居是「悬浮窗按钮」（即：电柜按钮在悬浮窗按钮"前面/左边"）。
- [ ] **2.2** 4 种主题 + 自定义主题色时，按钮颜色正确跟随 --theme-color 变化，文字白色，hover/active 动效正常。
- [ ] **2.3** 连续点入口按钮 10 次，只打开 1 个电柜窗口；重复点击时已存在的窗口 focus 到最前面。

## 三、窗口生命周期
- [ ] **3.1** createCabinetWindow() 尺寸 960×640 / min 720×480 / resizable=true / 居中显示。
- [ ] **3.2** 电柜窗口的 X 关闭按钮、底部「取消」、底部「保存并关闭」三种方式都能可靠关闭；关闭后 500ms 兜底 destroy（和 consoleWindow 相同）。
- [ ] **3.3** 主窗口关闭时：若电柜窗口存在，会一起关闭，不会留"孤儿窗口"导致进程活着不退出。

## 四、UDP 通信正确性
- [ ] **4.1** main.js 启动电柜功能时绑定 UDP 2021（reuseAddr）；若端口被占用，push cabinet-error('BIND_PORT_2021_FAIL')，电柜窗口顶部 toast 显示可读中文。
- [ ] **4.2** 单路开：Wireshark 同时抓到 2 个 UDP 包：
  - `aa6a 01 <cabinetNo> <roadNo> 02 aaa6` → `<ip>:2023`（新版电柜）
  - 530B 硅箱包 → `<ip>:2021`，字节0~14 严格符合文档，15~529 全 0x00
- [ ] **4.3** 单路关 / 一键全开 / 一键全关 / 查询：字节 100% 对照文档样例一致，顺序/逆序模式字节13正确。
- [ ] **4.4** 收包分流：
  - 收到 530B → 走硅箱解析，byte14 = 0x01→关 0x02→开；
  - 收到 aa6a...aaa6 短包 → 走新版电柜解析，0x21 查询回包正确读取 byte[4..] 状态；0x01/0x02 控制原包正确匹配 pendingList。
- [ ] **4.5** 防卡死：
  - 收到 1 字节 / 0 字节 / 2000 字节 包 → 直接丢弃；
  - 帧头或帧尾错误包 → 静默丢弃，不 console.log 刷屏；
  - pendingList 超过 5000 → FIFO 丢弃最早的，内存不无限涨。

## 五、配置与持久化
- [ ] **5.1** 添加电柜表单：IP / 名称必填；开关数下拉 12/18/24/30/36；电柜编号/硅箱序号都是 1-255，默认 1。
- [ ] **5.2** 开关数 12→24：自动补默认 buttons 元素，路号=index+1，名称=「第N路」，颜色=当前主题色。
- [ ] **5.3** 开关数 24→12：先弹警告（「后面12条将丢弃，是否继续？」），取消则不裁剪，确认则 slice(0,12)。
- [ ] **5.4** 电柜窗口关了再开 / 整个软件关了再开：所有配置（名称/IP/编号/序号/按钮名/颜色/路号/activeCabinetId）100% 保留。
- [ ] **5.5** 删除电柜：弹确认，确认后从 cabinets 移除；若删除的是 activeCabinetId，则 activeCabinetId 切到下一个（没有就空）。

## 六、按钮交互与视觉
- [ ] **6.1** 单击按钮 → 发送切换动作；按钮点下去有 click 视觉（按下缩小）。
- [ ] **6.2** 纯回传驱动：收到 cabinet-status-push 正确按钮才变亮/变暗；1000ms 超时 → 按钮边框闪黄色虚线 2 秒（@keyframes flash-yellow），期间 status 不变（不会"假开"）。
- [ ] **6.3** 双击按钮 → 打开按钮属性弹窗，可改名称 / 路号 / 颜色（颜色选择器 + 8 个主题色块预设）。
- [ ] **6.4** 一键全开：一次性点亮全部；一键全关：一次性全部变暗；如果其中若干路超时，那几路闪黄框，其他正常已收到回包的保持正确状态。

## 七、主题同步与响应式
- [ ] **7.1** 4 种 data-theme（dark / light / cute / cool）各自背景色/文字色/卡片色/边框色正确显示，与主界面观感一致。
- [ ] **7.2** 电柜窗口打开着时，主界面切换主题或主题色：电柜窗口 500ms 内同步更新，不需要关闭重开。
- [ ] **7.3** 窗口缩放到 820px 以下，按钮网格从 6 列→4 列；按钮保持正方形，文字不溢出。
- [ ] **7.4** 可爱 / 酷炫主题下的圆角、渐变阴影等特效在电柜模态弹窗和按钮上同样生效。

## 八、IPC 与健壮性
- [ ] **8.1** 所有 IPC 都是异步 invoke / send，**没有 sendSync**（不会卡死渲染进程）。
- [ ] **8.2** cabinet-manager.html 在 UDP socket 还未 ready 时（例如 main.js 还没 bind 成功）调用 cabinet:send，不会 throw；至少能 push cabinet-error 友好提示。
- [ ] **8.3** 保存按钮行为：点「保存并关闭」→ localStorage 写盘 → 关闭窗口；点「取消」→ localStorage 不改动 → 关闭窗口。
- [ ] **8.4** 语法烟测：`node --check main.js` 通过；electron 启动时 DevTools Console 0 error（未定义 / null 引用等）。
