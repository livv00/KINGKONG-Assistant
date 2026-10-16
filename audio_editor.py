"""
多轨音频编辑器 - 主窗口

类似 Adobe Audition 多轨模式的主窗口。
包含：菜单栏、工具栏、轨道控制区+时间轴编辑区、播放控制栏、状态栏。

依赖：PyQt6, numpy, pydub
"""

import os
import sys
import time
from typing import Optional, List, Callable, Dict

# ── 配置 pydub 的 ffmpeg 路径（在导入其他模块之前） ──
def _init_ffmpeg():
    """自动查找并配置 ffmpeg 路径"""
    try:
        import imageio_ffmpeg
        ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
        from pydub import AudioSegment
        AudioSegment.converter = ffmpeg_path
        ffprobe_path = ffmpeg_path.replace('ffmpeg', 'ffprobe')
        # 处理可能的 ffprobe 路径
        import os
        if os.path.exists(ffprobe_path):
            AudioSegment.ffprobe = ffprobe_path
        else:
            AudioSegment.ffprobe = ffmpeg_path
    except Exception:
        pass

_init_ffmpeg()

from PyQt6.QtCore import Qt, QTimer, QRectF, QPointF, QSize
from PyQt6.QtGui import (
    QColor, QPen, QBrush, QPainter, QFont, QAction, QIcon,
    QKeySequence, QDragEnterEvent, QDropEvent,
)
from PyQt6.QtWidgets import (
    QMainWindow, QWidget, QHBoxLayout, QVBoxLayout, QLabel, QPushButton,
    QSlider, QScrollArea, QGraphicsView, QGraphicsScene, QGraphicsLineItem,
    QGraphicsRectItem, QFileDialog, QStatusBar, QToolBar, QMenu,
    QSizePolicy, QFrame, QDialog, QDialogButtonBox, QSpinBox, QCheckBox,
    QMessageBox, QApplication, QStyle,
)

from track_item import (
    AudioTrack, AudioItem, AudioBlockItem, TrackColor, FadeType,
    generate_fade_envelope, apply_fade_in, apply_fade_out,
)
from track_widget import TrackWidget, TrackControlWidget, TrackEditorWidget
from mixer import AudioMixer, mix_tracks
from export_dialog import ExportDialog
from edit_history import EditHistory, ActionType
from project_io import ProjectIO
from mixer_panel import MixerPanel


# ═══════════════════════════════════════════════════════
# 时间轴标尺
# ═══════════════════════════════════════════════════════

class TimelineRuler(QWidget):
    """
    时间轴标尺组件。

    显示时间刻度（秒/分钟），播放指针，循环区域。
    缩放时自动调整刻度密度。
    """

    HEIGHT = 28

    def __init__(self, px_per_sec: float = 50.0, parent=None):
        super().__init__(parent)
        self.px_per_sec = px_per_sec
        self.duration = 60.0
        self.playhead_time = 0.0
        self.loop_start = -1.0
        self.loop_end = -1.0

        self.setFixedHeight(self.HEIGHT)
        self.setMinimumWidth(400)
        self.setStyleSheet("background: #1a1a1a; border-bottom: 1px solid #333;")

    def set_px_per_sec(self, px_per_sec: float):
        self.px_per_sec = px_per_sec
        self.update()

    def set_duration(self, duration: float):
        self.duration = max(duration, 10.0)
        self.update()

    def set_playhead(self, time_sec: float):
        self.playhead_time = time_sec
        self.update()

    def set_loop_region(self, start: float, end: float):
        self.loop_start = start
        self.loop_end = end
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        w = self.width()
        h = self.height()

        min_label_spacing = 60
        candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300]
        interval = 10
        for c in candidates:
            if c * self.px_per_sec >= min_label_spacing:
                interval = c
                break

        painter.setPen(QPen(QColor(120, 120, 120), 1))
        font = QFont("Consolas", 8)
        painter.setFont(font)

        total_secs = int(self.duration) + 1
        for sec in range(0, total_secs, interval):
            x = sec * self.px_per_sec
            if x > w:
                break
            painter.drawLine(QPointF(x, h - 10), QPointF(x, h))
            label = self._format_time(sec)
            painter.drawText(QRectF(x + 2, 0, 50, h - 12),
                             Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                             label)

        sub_interval = max(1, interval // 5)
        painter.setPen(QPen(QColor(80, 80, 80), 1))
        for sec in range(0, total_secs, sub_interval):
            if sec % interval == 0:
                continue
            x = sec * self.px_per_sec
            if x > w:
                break
            painter.drawLine(QPointF(x, h - 5), QPointF(x, h))

        if self.loop_start >= 0 and self.loop_end > self.loop_start:
            x1 = self.loop_start * self.px_per_sec
            x2 = self.loop_end * self.px_per_sec
            painter.fillRect(QRectF(x1, 0, x2 - x1, h), QBrush(QColor(255, 107, 107, 40)))

        if self.playhead_time >= 0:
            x = self.playhead_time * self.px_per_sec
            painter.setPen(QPen(QColor(255, 107, 107), 1.5))
            painter.drawLine(QPointF(x, 0), QPointF(x, h))

    @staticmethod
    def _format_time(sec: int) -> str:
        m = sec // 60
        s = sec % 60
        return f"{m}:{s:02d}"


# ═══════════════════════════════════════════════════════
# 主窗口
# ═══════════════════════════════════════════════════════

class AudioEditorWindow(QMainWindow):
    """
    多轨音频编辑器主窗口。
    """

    DEFAULT_PX_PER_SEC = 50.0
    MIN_PX_PER_SEC = 10.0
    MAX_PX_PER_SEC = 400.0
    MAX_TRACKS = 32

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("多轨音频编辑器")
        self.resize(1200, 750)
        self.setAcceptDrops(True)  # 整个窗口支持拖放文件

        # ── 状态 ──
        self.tracks: List[AudioTrack] = []
        self.track_widgets: List[TrackWidget] = []
        self.px_per_sec = self.DEFAULT_PX_PER_SEC
        self.project_duration = 60.0
        self._current_playhead_time = 0.0  # 当前播放指针位置

        self._is_playing = False
        self._play_start_time = 0.0
        self._play_real_start = 0.0
        self._play_timer = QTimer(self)
        self._play_timer.setInterval(33)  # ~30fps，平衡流畅度和性能
        self._play_timer.timeout.connect(self._on_play_tick)

        self._loop_enabled = False
        self._loop_start = 0.0
        self._loop_end = 0.0

        self._snap_enabled = True
        self._snap_interval = 0.1

        # 撤销/重做
        self._history = EditHistory(max_steps=100)
        self._project_name = "未命名项目"
        self._project_file_path: Optional[str] = None

        # 混音面板
        self._mixer_panel: Optional[MixerPanel] = None

        # ── 构建 UI ──
        self._build_menu_bar()
        self._build_toolbar()
        self._build_central_widget()
        self._build_playback_bar()
        self._build_status_bar()

        for i in range(3):
            self._add_track()

        self._update_status()

    # ── 获取播放指针时间的回调 ──

    def _get_playhead_time(self) -> float:
        return self._current_playhead_time

    # ════════════════════════════════════════════════
    # UI 构建
    # ════════════════════════════════════════════════

    def _build_menu_bar(self):
        menubar = self.menuBar()

        file_menu = menubar.addMenu("文件")
        file_menu.addAction(self._create_action("新建项目", self._on_new_project, "Ctrl+N"))
        file_menu.addAction(self._create_action("打开项目", self._on_open_project, "Ctrl+O"))
        file_menu.addAction(self._create_action("保存项目", self._on_save_project, "Ctrl+S"))
        file_menu.addAction(self._create_action("另存为...", self._on_save_project_as, "Ctrl+Shift+S"))
        file_menu.addSeparator()
        file_menu.addAction(self._create_action("导入音频", self._on_import_audio, "Ctrl+I"))
        file_menu.addAction(self._create_action("导出混音", self._on_export, "Ctrl+E"))
        file_menu.addSeparator()
        file_menu.addAction(self._create_action("退出", self.close, "Ctrl+Q"))

        edit_menu = menubar.addMenu("编辑")
        edit_menu.addAction(self._create_action("撤销", self._on_undo, "Ctrl+Z"))
        edit_menu.addAction(self._create_action("重做", self._on_redo, "Ctrl+Y"))
        edit_menu.addSeparator()
        edit_menu.addAction(self._create_action("分割", self._on_split, "S"))
        edit_menu.addAction(self._create_action("合并", self._on_merge, "J"))
        edit_menu.addAction(self._create_action("删除选中", self._on_delete_selected, "Delete"))
        edit_menu.addSeparator()
        edit_menu.addAction(self._create_action("全选", self._on_select_all, "Ctrl+A"))
        edit_menu.addAction(self._create_action("取消选择", self._on_deselect_all, "Ctrl+D"))

        track_menu = menubar.addMenu("轨道")
        track_menu.addAction(self._create_action("添加轨道", self._add_track, "Ctrl+T"))
        track_menu.addAction(self._create_action("删除最后轨道", self._remove_last_track))
        track_menu.addSeparator()
        track_menu.addAction(self._create_action("全部静音", self._mute_all))
        track_menu.addAction(self._create_action("取消独奏", self._unsolo_all))

        effect_menu = menubar.addMenu("效果")
        effect_menu.addAction(self._create_action("淡入", lambda: self._apply_fade_to_selected(True)))
        effect_menu.addAction(self._create_action("淡出", lambda: self._apply_fade_to_selected(False)))

        view_menu = menubar.addMenu("视图")
        view_menu.addAction(self._create_action("放大", self._zoom_in, "+"))
        view_menu.addAction(self._create_action("缩小", self._zoom_out, "-"))
        view_menu.addAction(self._create_action("适应窗口", self._zoom_fit, "0"))
        view_menu.addSeparator()
        view_menu.addAction(self._create_action("切换吸附", self._toggle_snap, "N"))

        help_menu = menubar.addMenu("帮助")
        help_menu.addAction(self._create_action("关于", self._show_about))

    def _build_toolbar(self):
        toolbar = QToolBar("工具栏")
        toolbar.setMovable(False)
        toolbar.setIconSize(QSize(16, 16))
        self.addToolBar(toolbar)

        toolbar.addAction(self._create_action("导入音频", self._on_import_audio))
        toolbar.addAction(self._create_action("导出", self._on_export))
        toolbar.addSeparator()
        toolbar.addAction(self._create_action("新建", self._on_new_project))
        toolbar.addAction(self._create_action("打开", self._on_open_project))
        toolbar.addAction(self._create_action("保存", self._on_save_project))
        toolbar.addSeparator()
        toolbar.addAction(self._create_action("撤销", self._on_undo))
        toolbar.addAction(self._create_action("重做", self._on_redo))
        toolbar.addSeparator()
        toolbar.addAction(self._create_action("分割", self._on_split))
        toolbar.addAction(self._create_action("合并", self._on_merge))
        toolbar.addAction(self._create_action("静音", self._mute_all))
        toolbar.addAction(self._create_action("独奏", self._unsolo_all))
        toolbar.addSeparator()
        toolbar.addAction(self._create_action("混音面板", self._open_mixer_panel))
        toolbar.addSeparator()
        toolbar.addAction(self._create_action("对齐网格", self._toggle_snap))
        toolbar.addAction(self._create_action("放大", self._zoom_in))
        toolbar.addAction(self._create_action("缩小", self._zoom_out))
        toolbar.addAction(self._create_action("适应", self._zoom_fit))

    def _build_central_widget(self):
        central = QWidget()
        central.setStyleSheet("background: #1a1a1a;")
        self.setCentralWidget(central)

        main_layout = QHBoxLayout(central)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)

        # ── 左侧：轨道控制区滚动 ──
        self._control_scroll = QScrollArea()
        self._control_scroll.setFixedWidth(TrackControlWidget.CONTROL_WIDTH)
        self._control_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._control_scroll.setWidgetResizable(True)
        self._control_scroll.setStyleSheet(
            "QScrollArea { border: none; background: #1a1a1a; }"
            "QScrollArea::viewport { background: #1a1a1a; }"
        )

        self._control_container = QWidget()
        self._control_container.setStyleSheet("background: #1a1a1a;")
        self._control_layout = QVBoxLayout(self._control_container)
        self._control_layout.setContentsMargins(0, 0, 0, 0)
        self._control_layout.setSpacing(0)

        # 添加与右侧时间标尺等高的顶部空白，确保轨道对齐
        top_spacer = QWidget()
        top_spacer.setFixedHeight(TimelineRuler.HEIGHT)
        top_spacer.setStyleSheet("background: #1a1a1a; border-bottom: 1px solid #333;")
        self._control_layout.addWidget(top_spacer)

        self._control_layout.addStretch()
        self._control_scroll.setWidget(self._control_container)

        add_track_btn = QPushButton("+ 添加轨道")
        add_track_btn.setFixedHeight(28)
        add_track_btn.setStyleSheet(
            "QPushButton { background: #2a2a2a; color: #ff6b6b; border: none;"
            "  border-top: 1px solid #333; font-size: 12px; }"
            "QPushButton:hover { background: #3a3a3a; }"
        )
        add_track_btn.clicked.connect(self._add_track)

        left_panel = QWidget()
        left_panel.setStyleSheet("background: #1a1a1a;")
        left_layout = QVBoxLayout(left_panel)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(0)
        left_layout.addWidget(self._control_scroll, 1)
        left_layout.addWidget(add_track_btn)
        main_layout.addWidget(left_panel)

        # ── 右侧：时间轴 + 轨道编辑区 ──
        right_panel = QWidget()
        right_panel.setStyleSheet("background: #1a1a1a;")
        right_layout = QVBoxLayout(right_panel)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(0)

        self._ruler = TimelineRuler(self.px_per_sec)
        right_layout.addWidget(self._ruler)

        self._editor_scroll = QScrollArea()
        self._editor_scroll.setWidgetResizable(True)
        self._editor_scroll.setAcceptDrops(True)
        self._editor_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self._editor_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self._editor_scroll.setStyleSheet(
            "QScrollArea { border: none; background: #1a1a1a; }"
            "QScrollArea::viewport { background: #1a1a1a; }"
        )

        self._editor_container = QWidget()
        self._editor_container.setStyleSheet("background: #1a1a1a;")
        self._editor_container.setAcceptDrops(True)
        self._editor_layout = QVBoxLayout(self._editor_container)
        self._editor_layout.setContentsMargins(0, 0, 0, 0)
        self._editor_layout.setSpacing(0)
        self._editor_layout.addStretch()
        self._editor_scroll.setWidget(self._editor_container)

        right_layout.addWidget(self._editor_scroll, 1)
        main_layout.addWidget(right_panel, 1)

        self._control_scroll.verticalScrollBar().valueChanged.connect(
            self._editor_scroll.verticalScrollBar().setValue
        )
        self._editor_scroll.verticalScrollBar().valueChanged.connect(
            self._control_scroll.verticalScrollBar().setValue
        )

    def _build_playback_bar(self):
        bar = QFrame()
        bar.setFixedHeight(50)
        bar.setStyleSheet(
            "QFrame { background: #1a1a1a; border-top: 1px solid #333; }"
            "QPushButton { background: #ff6b6b; color: white; border: none;"
            "  border-radius: 4px; font-size: 14px; }"
            "QPushButton:hover { background: #ff5252; }"
            "QLabel { color: #999; font-size: 11px; }"
        )
        layout = QHBoxLayout(bar)
        layout.setContentsMargins(12, 6, 12, 6)
        layout.setSpacing(8)

        self._prev_btn = QPushButton("⏮")
        self._prev_btn.setFixedSize(32, 32)
        self._prev_btn.clicked.connect(self._on_prev)
        layout.addWidget(self._prev_btn)

        self._play_btn = QPushButton("▶")
        self._play_btn.setFixedSize(40, 32)
        self._play_btn.clicked.connect(self._on_play_pause)
        layout.addWidget(self._play_btn)

        self._next_btn = QPushButton("⏭")
        self._next_btn.setFixedSize(32, 32)
        self._next_btn.clicked.connect(self._on_next)
        layout.addWidget(self._next_btn)

        self._record_btn = QPushButton("⏺")
        self._record_btn.setFixedSize(32, 32)
        self._record_btn.setStyleSheet(
            "QPushButton { background: #2a2a4a; color: #ff3b30; }"
            "QPushButton:hover { background: #3a1a1a; }"
        )
        layout.addWidget(self._record_btn)

        self._loop_btn = QPushButton("🔁")
        self._loop_btn.setFixedSize(32, 32)
        self._loop_btn.setCheckable(True)
        self._loop_btn.clicked.connect(self._on_loop_toggled)
        layout.addWidget(self._loop_btn)

        self._progress_slider = QSlider(Qt.Orientation.Horizontal)
        self._progress_slider.setRange(0, 1000)
        self._progress_slider.sliderMoved.connect(self._on_seek)
        layout.addWidget(self._progress_slider, 1)

        self._time_label = QLabel("00:00 / 00:00")
        self._time_label.setFixedWidth(110)
        self._time_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._time_label.setStyleSheet("color: #eee; font-family: Consolas; font-size: 12px;")
        layout.addWidget(self._time_label)

        sep = QFrame()
        sep.setFixedWidth(1)
        sep.setStyleSheet("background: #333;")
        layout.addWidget(sep)

        layout.addWidget(QLabel("主音量"))
        self._master_vol = QSlider(Qt.Orientation.Horizontal)
        self._master_vol.setRange(0, 200)
        self._master_vol.setValue(100)
        self._master_vol.setFixedWidth(80)
        layout.addWidget(self._master_vol)

        layout.addWidget(QLabel("BPM"))
        self._bpm_spin = QSpinBox()
        self._bpm_spin.setRange(40, 300)
        self._bpm_spin.setValue(120)
        self._bpm_spin.setFixedWidth(60)
        layout.addWidget(self._bpm_spin)

        self._metronome_btn = QPushButton("节拍器")
        self._metronome_btn.setCheckable(True)
        self._metronome_btn.setFixedHeight(32)
        layout.addWidget(self._metronome_btn)

        old_central = self.centralWidget()
        wrapper = QWidget()
        wrapper.setStyleSheet("background: #1a1a1a;")
        wrapper_layout = QVBoxLayout(wrapper)
        wrapper_layout.setContentsMargins(0, 0, 0, 0)
        wrapper_layout.setSpacing(0)
        wrapper_layout.addWidget(old_central, 1)
        wrapper_layout.addWidget(bar)
        self.setCentralWidget(wrapper)

    def _build_status_bar(self):
        self._status = QStatusBar()
        self.setStatusBar(self._status)
        self._status_label = QLabel("就绪")
        self._status.addWidget(self._status_label, 1)

        self._track_count_label = QLabel("轨道: 0")
        self._status.addWidget(self._track_count_label)

        self._item_count_label = QLabel("音频块: 0")
        self._status.addWidget(self._item_count_label)

        self._duration_label = QLabel("时长: 00:00")
        self._status.addWidget(self._duration_label)

    # ════════════════════════════════════════════════
    # 轨道管理
    # ════════════════════════════════════════════════

    def _add_track(self):
        if len(self.tracks) >= self.MAX_TRACKS:
            QMessageBox.warning(self, "提示", f"最多支持 {self.MAX_TRACKS} 个轨道")
            return

        idx = len(self.tracks)
        track = AudioTrack(
            name=f"轨道 {idx + 1}",
            index=idx,
            color=TrackColor.get(idx),
        )
        self.tracks.append(track)

        widget = TrackWidget(track, self.px_per_sec,
                             get_playhead_time=self._get_playhead_time)
        self.track_widgets.append(widget)

        widget.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)

        self._control_layout.insertWidget(self._control_layout.count() - 1, widget.control)
        self._editor_layout.insertWidget(self._editor_layout.count() - 1, widget.editor)

        widget.muteToggled.connect(self._on_track_mute)
        widget.soloToggled.connect(self._on_track_solo)
        widget.volumeChanged.connect(self._on_track_volume)
        widget.panChanged.connect(self._on_track_pan)
        widget.nameChanged.connect(self._on_track_rename)
        widget.colorChangeRequested.connect(self._on_track_color)
        widget.audioDropped.connect(self._on_audio_dropped)
        widget.splitRequested.connect(self._on_split_requested)
        widget.deleteRequested.connect(self._on_delete_requested)
        widget.blockDragToTrack.connect(self._on_block_drag_to_track)
        widget.blockTrimmed.connect(self._on_block_trimmed)
        widget.itemMoved.connect(self._on_item_moved)
        widget.itemSelected.connect(self._on_item_selected)
        widget.fadeChanged.connect(self._on_fade_changed)

        self._update_status()

    def _remove_last_track(self):
        if len(self.tracks) <= 1:
            QMessageBox.information(self, "提示", "至少保留 1 个轨道")
            return

        widget = self.track_widgets.pop()
        track = self.tracks.pop()

        self._control_layout.removeWidget(widget.control)
        self._editor_layout.removeWidget(widget.editor)
        widget.control.deleteLater()
        widget.editor.deleteLater()
        widget.deleteLater()

        self._update_status()

    def _update_all_tracks_zoom(self):
        for widget in self.track_widgets:
            widget.set_px_per_sec(self.px_per_sec)
        self._ruler.set_px_per_sec(self.px_per_sec)

    def _update_status(self):
        track_count = len(self.tracks)
        item_count = sum(len(t.items) for t in self.tracks)
        duration = max((t.duration for t in self.tracks), default=0.0)

        self._track_count_label.setText(f"轨道: {track_count}")
        self._item_count_label.setText(f"音频块: {item_count}")
        self._duration_label.setText(f"时长: {self._format_time(duration)}")

        self.project_duration = max(duration, 10.0)
        self._ruler.set_duration(self.project_duration)

        self._progress_slider.setMaximum(int(self.project_duration * 1000))

    # ════════════════════════════════════════════════
    # 窗口级拖放（拖到任意位置都能导入文件）
    # ════════════════════════════════════════════════

    VALID_AUDIO_EXTS = ('.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a')

    def _extract_file_paths_from_drag(self, event):
        """从拖放事件中安全提取文件路径（兼容多种 URL 格式）"""
        paths = []
        md = event.mimeData()
        if not md.hasUrls():
            return paths
        for url in md.urls():
            # 方案 1：Qt 的 toLocalFile
            path = url.toLocalFile()

            # 方案 2：如果 toLocalFile 失败，手动解析 URL 字符串
            if not path:
                url_str = url.toString()
                if url_str.startswith('file://'):
                    # 去掉 file:// 前缀（可能是 file:/// 或 file://）
                    from urllib.parse import unquote
                    if url_str.startswith('file:///'):
                        raw = url_str[8:]
                    else:
                        raw = url_str[7:]
                    path = unquote(raw)
                    # 修复 Windows 盘符: /C:/xxx -> C:/xxx 或 C%3A/... -> C:/...
                    if len(path) >= 3 and path[0] == '/' and path[2] == ':':
                        path = path[1:]

            # 清理路径字符串中的多余字符
            if path:
                import re as _re
                # 去掉开头多余的斜杠/反斜杠
                path = path.strip()
                if path.startswith('\\\\') and not path.startswith('\\\\\\\\'):
                    # 不是 UNC 路径的话去掉开头多余的
                    pass
                # 修正 /D/... -> D:/ 这种格式
                if (len(path) >= 3 and path[0].isalpha()
                        and path[1] in ('/', '\\\\') and ':' not in path[:3]):
                    path = path[0] + ':' + path[1:]

            if path:
                paths.append(path)
        return paths

    def dragEnterEvent(self, event: QDragEnterEvent):
        """窗口级拖拽进入：检查是否是音频文件"""
        paths = self._extract_file_paths_from_drag(event)
        has_urls = event.mimeData().hasUrls()
        self._debug_log(
            f'[dragEnterEvent] hasUrls={has_urls}, paths={paths}, '
            f'mimeText={event.mimeData().text()[:120]!r}'
        )
        for p in paths:
            if p.lower().endswith(self.VALID_AUDIO_EXTS):
                self._debug_log(f'  -> acceptProposedAction: {p}')
                event.acceptProposedAction()
                return
        self._debug_log(f'  -> ignore')
        event.ignore()

    def dragMoveEvent(self, event):
        """窗口级拖拽移动：保持接受"""
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event: QDropEvent):
        """窗口级拖拽释放：判断轨道位置并导入"""
        paths = self._extract_file_paths_from_drag(event)
        self._debug_log(f'[dropEvent] paths={paths}')

        target_track = 0
        start_time = 0.0

        # 尝试根据 Y 坐标判断目标轨道
        try:
            pos = event.position().toPoint()
            global_pos = self.mapToGlobal(pos)
            for idx, tw in enumerate(self.track_widgets):
                ctrl = tw.control
                top_left = ctrl.mapToGlobal(ctrl.rect().topLeft())
                if (top_left.y() <= global_pos.y()
                        <= top_left.y() + ctrl.height()):
                    target_track = idx
                    break
        except Exception as e_track:
            self._debug_log(f'  轨道定位异常: {e_track}')

        loaded = 0
        for p in paths:
            if p.lower().endswith(self.VALID_AUDIO_EXTS):
                self._debug_log(f'  调用 _load_audio_to_track("{p}", track={target_track})')
                self._load_audio_to_track(p, target_track, start_time=start_time)
                loaded += 1
        self._debug_log(f'  loaded={loaded} -> {"acceptProposedAction" if loaded else "ignore"}')
        if loaded > 0:
            event.acceptProposedAction()
        else:
            event.ignore()

    # ════════════════════════════════════════════════
    # 音频导入
    # ════════════════════════════════════════════════

    def _on_import_audio(self):
        file_paths, _ = QFileDialog.getOpenFileNames(
            self, "选择音频文件", "",
            "音频文件 (*.mp3 *.wav *.ogg *.flac *.aac *.m4a);;所有文件 (*.*)"
        )
        if not file_paths:
            return
        for path in file_paths:
            self._load_audio_to_track(path, 0)

    def _on_audio_dropped(self, track_index: int, file_path: str,
                           start_time: float = 0.0):
        self._load_audio_to_track(file_path, track_index, start_time=start_time)

    @staticmethod
    def _debug_log(msg: str):
        """写调试日志到桌面，方便排查拖放加载问题"""
        try:
            import os as _os
            import datetime as _dt
            log_dir = _os.path.join(_os.path.expanduser('~'), 'Desktop')
            if not _os.path.isdir(log_dir):
                log_dir = _os.path.expanduser('~')
            log_path = _os.path.join(log_dir, 'audio_editor_debug.log')
            ts = _dt.datetime.now().strftime('%H:%M:%S.%f')[:-3]
            with open(log_path, 'a', encoding='utf-8') as f:
                f.write(f'[{ts}] {msg}\\n')
        except Exception:
            pass

    @staticmethod
    def _parse_wav_header(raw_bytes: bytes):
        """手动解析 WAV 文件头。
        返回 (channels, bits_per_sample, frame_rate, audio_format, data_offset, data_length)
        audio_format: 1=PCM, 3=IEEE float
        完全不依赖 wave 模块，支持 format 1 (PCM) 和 format 3 (IEEE float)。"""
        import struct as _struct
        if len(raw_bytes) < 44:
            raise ValueError('WAV 文件太小，无法解析头部')

        if raw_bytes[0:4] != b'RIFF':
            raise ValueError('不是有效的 WAV 文件（缺少 RIFF 标识）')
        if raw_bytes[8:12] != b'WAVE':
            raise ValueError('不是有效的 WAV 文件（缺少 WAVE 标识）')

        offset = 12
        channels = 0
        bits_per_sample = 0
        frame_rate = 0
        audio_format = 0
        data_offset = 0
        data_length = 0
        file_size = len(raw_bytes)

        while offset < file_size - 8:
            if offset + 8 > file_size:
                break
            chunk_id = raw_bytes[offset:offset + 4]
            chunk_size = _struct.unpack_from('<I', raw_bytes, offset + 4)[0]
            chunk_data_start = offset + 8
            if chunk_data_start + chunk_size > file_size:
                chunk_size = file_size - chunk_data_start

            if chunk_id == b'fmt ':
                if chunk_size < 16:
                    raise ValueError('fmt 块长度不足')
                audio_format = _struct.unpack_from('<H', raw_bytes, chunk_data_start)[0]
                channels = _struct.unpack_from('<H', raw_bytes, chunk_data_start + 2)[0]
                frame_rate = _struct.unpack_from('<I', raw_bytes, chunk_data_start + 4)[0]
                bits_per_sample = _struct.unpack_from('<H', raw_bytes, chunk_data_start + 14)[0]
            elif chunk_id == b'data':
                data_offset = chunk_data_start
                data_length = chunk_size
                break

            offset = chunk_data_start + chunk_size
            if chunk_size % 2 == 1:
                offset += 1

        if not channels or not frame_rate or data_length == 0:
            raise ValueError('WAV 解析失败：缺少必要的头信息或 data 块')

        if audio_format not in (1, 3):
            raise ValueError(f'不支持的 WAV 编码格式: {audio_format}')

        return channels, bits_per_sample, frame_rate, audio_format, data_offset, data_length

    @staticmethod
    def _convert_to_pcm16(raw_data: bytes, channels: int, bits_per_sample: int,
                           audio_format: int):
        """将各种 WAV 格式的原始数据转换为 16-bit PCM 数据。
        PCM16 是 pydub AudioSegment 最稳定支持的格式。"""
        import numpy as np
        import struct as _struct

        if audio_format == 3:
            # IEEE float
            if bits_per_sample == 32:
                # float32 -> pcm16
                float_samples = np.frombuffer(raw_data, dtype=np.float32)
                float_samples = np.clip(float_samples, -1.0, 1.0)
                pcm16 = (float_samples * 32767).astype(np.int16)
                return pcm16.tobytes(), 2
            elif bits_per_sample == 64:
                # float64 -> pcm16
                float_samples = np.frombuffer(raw_data, dtype=np.float64)
                float_samples = np.clip(float_samples, -1.0, 1.0)
                pcm16 = (float_samples * 32767).astype(np.int16)
                return pcm16.tobytes(), 2
            else:
                raise ValueError(f'不支持的 float 位深: {bits_per_sample}')

        # PCM format
        if bits_per_sample == 8:
            # 8-bit PCM 是 unsigned，需要转换
            samples = np.frombuffer(raw_data, dtype=np.uint8)
            samples = (samples.astype(np.int32) - 128) * 256
            samples = np.clip(samples, -32768, 32767).astype(np.int16)
            return samples.tobytes(), 2
        elif bits_per_sample == 16:
            # 已经是 16-bit PCM，直接返回
            return raw_data, 2
        elif bits_per_sample == 24:
            # 24-bit PCM: 需要手动处理每个 3 字节样本
            n_samples = len(raw_data) // 3
            pcm16 = bytearray(n_samples * 2)
            for i in range(n_samples):
                # 读 3 字节 (little-endian)
                b0 = raw_data[i * 3]
                b1 = raw_data[i * 3 + 1]
                b2 = raw_data[i * 3 + 2]
                # 组合成 24-bit 有符号值
                sample24 = (b2 << 16) | (b1 << 8) | b0
                # 符号扩展
                if sample24 & 0x800000:
                    sample24 |= ~0xFFFFFF
                # 缩放为 16-bit
                sample16 = max(-32768, min(32767, sample24 >> 8))
                pcm16[i * 2] = sample16 & 0xFF
                pcm16[i * 2 + 1] = (sample16 >> 8) & 0xFF
            return bytes(pcm16), 2
        elif bits_per_sample == 32:
            # 32-bit PCM (有符号整数)
            samples = np.frombuffer(raw_data, dtype=np.int32)
            samples = (samples >> 16).astype(np.int16)
            return samples.tobytes(), 2
        else:
            raise ValueError(f'不支持的 PCM 位深: {bits_per_sample}')

    @staticmethod
    def _load_wav_native(file_path: str):
        """
        加载 WAV 文件（支持所有常见格式）：
        1) open() 读取原始字节
        2) 手动解析 WAV 头（支持 PCM 和 IEEE float）
        3) 转换为 16-bit PCM
        4) 构造 pydub AudioSegment
        """
        import os as _os
        from pydub import AudioSegment

        AudioEditorWindow._debug_log(f'_load_wav_native 开始: {repr(file_path)}')

        with open(file_path, 'rb') as f:
            wav_bytes = f.read()
        AudioEditorWindow._debug_log(f'  读取字节数: {len(wav_bytes)}')

        # 解析 WAV 头
        channels, bits_per_sample, frame_rate, audio_format, data_offset, data_length = \
            AudioEditorWindow._parse_wav_header(wav_bytes)
        AudioEditorWindow._debug_log(
            f'  WAV头: fmt={audio_format} ch={channels} bps={bits_per_sample} '
            f'sr={frame_rate} data_off={data_offset} data_len={data_length}'
        )

        raw_audio_data = wav_bytes[data_offset:data_offset + data_length]

        # 转换为 16-bit PCM
        pcm16_data, sample_width = AudioEditorWindow._convert_to_pcm16(
            raw_audio_data, channels, bits_per_sample, audio_format
        )
        AudioEditorWindow._debug_log(
            f'  转换为PCM16: {len(pcm16_data)} bytes, sample_width={sample_width}'
        )

        audio = AudioSegment(
            data=pcm16_data,
            sample_width=sample_width,
            frame_rate=frame_rate,
            channels=channels,
        )
        AudioEditorWindow._debug_log(
            f'  加载成功: {len(audio)}ms, {audio.channels}ch, '
            f'{audio.frame_rate}Hz, {audio.sample_width}B/sample'
        )
        return audio

    def _load_audio_to_track(self, file_path: str, track_index: int,
                              start_time: float = 0.0):
        if track_index >= len(self.tracks):
            track_index = 0

        # 路径规范化：先做绝对路径 + 清理字符 + 规范分隔符
        file_path = str(file_path).strip().strip('\x00').strip()
        file_path = os.path.abspath(file_path)
        file_path = os.path.normpath(file_path)

        self._debug_log(
            f'[_load_audio_to_track] 原始参数 file_path={repr(file_path)}, '
            f'track={track_index}, isfile={os.path.isfile(file_path)}'
        )

        if not os.path.isfile(file_path):
            QMessageBox.critical(
                self, "加载失败",
                f"文件不存在或不是有效文件:\n{file_path}\n\n请确认文件路径是否正确。"
            )
            return

        try:
            from pydub import AudioSegment
        except ImportError:
            QMessageBox.critical(self, "错误", "缺少 pydub 库，请安装: pip install pydub")
            return

        try:
            ext = os.path.splitext(file_path)[1].lower().lstrip('.')
            audio = None

            if ext == 'wav':
                try:
                    audio = self._load_wav_native(file_path)
                except Exception:
                    try:
                        audio = AudioSegment.from_wav(file_path)
                    except Exception:
                        audio = AudioSegment.from_file(file_path)
            elif ext == 'mp3':
                try:
                    audio = AudioSegment.from_mp3(file_path)
                except Exception:
                    audio = AudioSegment.from_file(file_path)
            elif ext == 'ogg':
                try:
                    audio = AudioSegment.from_ogg(file_path)
                except Exception:
                    audio = AudioSegment.from_file(file_path)
            elif ext == 'flac':
                try:
                    audio = AudioSegment.from_file(file_path, 'flac')
                except Exception:
                    audio = AudioSegment.from_file(file_path)
            elif ext in ('aac', 'm4a'):
                try:
                    audio = AudioSegment.from_file(file_path)
                except Exception:
                    audio = AudioSegment.from_file(file_path, format=ext)
            else:
                audio = AudioSegment.from_file(file_path)

            if audio is None:
                raise RuntimeError("音频加载返回空数据")

        except Exception as e:
            import traceback
            error_detail = traceback.format_exc()
            QMessageBox.critical(
                self, "加载失败",
                f"无法加载音频文件:\n{file_path}\n\n错误: {e}\n\n详细信息:\n{error_detail[:500]}"
            )
            return

        track = self.tracks[track_index]
        name = os.path.splitext(os.path.basename(file_path))[0]
        item = AudioItem(
            audio_data=audio,
            _original_audio=audio,
            track=track,
            start_time=start_time,
            name=name,
        )
        item._source_file = file_path  # 保存源文件路径用于项目保存
        track.add_item(item)
        self.track_widgets[track_index].add_audio_block(item)

        self._update_status()
        self._status_label.setText(f"已导入: {name}")

    # ════════════════════════════════════════════════
    # 导出
    # ════════════════════════════════════════════════

    def _on_export(self):
        if not any(t.items for t in self.tracks):
            QMessageBox.information(self, "提示", "没有音频块可导出")
            return

        dialog = ExportDialog(self.tracks, self.project_duration, self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return

        params = dialog.get_export_params()

        try:
            from pydub import AudioSegment
        except ImportError:
            QMessageBox.critical(self, "错误", "缺少 pydub 库")
            return

        try:
            mixer = AudioMixer(self.tracks)

            # 混音
            mix = mixer.mix(
                start_time=params["start_time"],
                duration=params["duration"],
            )

            # 按采样率转换
            if params["sample_rate"] != AudioMixer.SAMPLE_RATE:
                mix = mix.set_frame_rate(params["sample_rate"])

            # 导出
            mix.export(
                params["file_path"],
                format=params["format"],
                bitrate=params["quality"].split()[0] if params["format"] != "wav" else None,
            )

            self._status_label.setText(f"已导出: {params['file_path']}")

            # 分轨导出
            if params.get("export_stems"):
                stem_dir = os.path.dirname(params["file_path"])
                stem_base = os.path.splitext(params["file_name"])[0]
                for track in self.tracks:
                    if not track.items:
                        continue
                    stem_mixer = AudioMixer([track])
                    stem_mix = stem_mixer.mix(
                        start_time=params["start_time"],
                        duration=params["duration"],
                    )
                    stem_path = os.path.join(stem_dir, f"{stem_base}_{track.name}.{params['format']}")
                    stem_mix.export(
                        stem_path,
                        format=params["format"],
                        bitrate=params["quality"].split()[0] if params["format"] != "wav" else None,
                    )

            QMessageBox.information(self, "导出成功",
                                    f"混音已导出到:\n{params['file_path']}")

        except Exception as e:
            QMessageBox.critical(self, "导出失败", f"导出时出错:\n{e}")

    # ════════════════════════════════════════════════
    # 播放控制
    # ════════════════════════════════════════════════

    def _on_play_pause(self):
        if self._is_playing:
            self._pause()
        else:
            self._play()

    def _play(self):
        self._is_playing = True
        self._play_btn.setText("⏸")
        # 从当前播放指针位置开始
        self._play_start_time = self._current_playhead_time
        self._play_real_start = time.time()
        self._play_timer.start()

    def _pause(self):
        self._is_playing = False
        self._play_btn.setText("▶")
        self._play_timer.stop()

    def _on_play_tick(self):
        elapsed = self._play_start_time + (time.time() - self._play_real_start)
        if elapsed >= self.project_duration:
            if self._loop_enabled:
                elapsed = self._loop_start
                self._play_start_time = elapsed
                self._play_real_start = time.time()
            else:
                self._pause()
                elapsed = 0.0
                for widget in self.track_widgets:
                    widget.hide_playhead()

        self._current_playhead_time = elapsed

        for widget in self.track_widgets:
            widget.set_playhead_position(elapsed)
        self._ruler.set_playhead(elapsed)

        self._progress_slider.setValue(int(elapsed * 1000))
        self._time_label.setText(
            f"{self._format_time(elapsed)} / {self._format_time(self.project_duration)}"
        )

    def _on_seek(self, value: int):
        time_sec = value / 1000.0
        self._current_playhead_time = time_sec
        for widget in self.track_widgets:
            widget.set_playhead_position(time_sec)
        self._ruler.set_playhead(time_sec)
        self._time_label.setText(
            f"{self._format_time(time_sec)} / {self._format_time(self.project_duration)}"
        )

    def _move_playhead(self, delta_sec: float):
        """移动播放指针"""
        new_time = max(0, min(self.project_duration,
                              self._current_playhead_time + delta_sec))
        self._on_seek(int(new_time * 1000))

    def _on_prev(self):
        self._on_seek(0)

    def _on_next(self):
        self._on_seek(int(self.project_duration * 1000))

    def _on_loop_toggled(self):
        self._loop_enabled = self._loop_btn.isChecked()
        if self._loop_enabled:
            self._loop_start = 0.0
            self._loop_end = self.project_duration
            self._ruler.set_loop_region(self._loop_start, self._loop_end)
        else:
            self._ruler.set_loop_region(-1, -1)

    # ════════════════════════════════════════════════
    # 轨道事件处理
    # ════════════════════════════════════════════════

    def _on_track_mute(self, index: int, muted: bool):
        self._status_label.setText(f"轨道 {index + 1} {'静音' if muted else '取消静音'}")

    def _on_track_solo(self, index: int, solo: bool):
        self._status_label.setText(f"轨道 {index + 1} {'独奏' if solo else '取消独奏'}")

    def _on_track_volume(self, index: int, volume: float):
        pass

    def _on_track_pan(self, index: int, pan: float):
        pass

    def _on_track_rename(self, index: int, name: str):
        self.tracks[index].name = name
        self._status_label.setText(f"轨道 {index + 1} 重命名为: {name}")

    def _on_track_color(self, index: int):
        from PyQt6.QtWidgets import QColorDialog
        color = QColorDialog.getColor(self.tracks[index].color, self, "选择轨道颜色")
        if color.isValid():
            self.tracks[index].color = color
            self.track_widgets[index].update_track_color(color)
            self._status_label.setText(f"轨道 {index + 1} 颜色已更新")

    def _mute_all(self):
        for track in self.tracks:
            track.muted = True
        for widget in self.track_widgets:
            widget.sync_from_track()
        self._status_label.setText("全部轨道已静音")

    def _unsolo_all(self):
        for track in self.tracks:
            track.solo = False
        for widget in self.track_widgets:
            widget.sync_from_track()
        self._status_label.setText("已取消所有独奏")

    # ════════════════════════════════════════════════
    # 音频块事件处理
    # ════════════════════════════════════════════════

    def _on_split_requested(self, audio_item: AudioItem, split_time: float):
        """从音频块右键菜单触发的分割"""
        self._split_item(audio_item, split_time)

    def _on_delete_requested(self, audio_item: AudioItem):
        """从音频块右键菜单触发的删除"""
        for widget in self.track_widgets:
            for block in widget.editor._block_items[:]:
                if block.audio_item is audio_item:
                    widget.editor.remove_audio_block(block)
        self._update_status()
        self._status_label.setText("已删除音频块")

    def _on_block_drag_to_track(self, audio_item: AudioItem, global_y: float):
        """垂直拖拽音频块到其他轨道：从全局Y坐标计算目标轨道"""
        if not audio_item.track:
            return

        # 从全局Y坐标查找目标轨道
        from PyQt6.QtWidgets import QApplication
        widget = QApplication.widgetAt(int(global_y), int(global_y))
        # 向上遍历找到 TrackEditorWidget
        while widget:
            if isinstance(widget, TrackEditorWidget):
                target_idx = widget.track.index
                break
            widget = widget.parentWidget()
        else:
            return

        if target_idx < 0 or target_idx >= len(self.tracks):
            return
        if audio_item.track.index == target_idx:
            return

        # 从原轨道移除
        old_track = audio_item.track
        old_track.remove_item(audio_item)
        for widget in self.track_widgets:
            if widget.track is old_track:
                for block in widget.editor._block_items[:]:
                    if block.audio_item is audio_item:
                        widget.editor._block_items.remove(block)
                        widget.editor._scene.removeItem(block)
                        break

        # 添加到新轨道
        new_track = self.tracks[target_idx]
        new_track.add_item(audio_item)
        audio_item.track = new_track
        self.track_widgets[target_idx].add_audio_block(audio_item)

        self._update_status()
        self._status_label.setText(f"音频块已移到轨道 {target_idx + 1}")

    def _on_block_trimmed(self, audio_item: AudioItem, trim_start: float, trim_end: float):
        """音频块裁剪完成"""
        self._update_status()
        self._status_label.setText(f"已裁剪: 开头 {trim_start:.2f}s, 结尾 {trim_end:.2f}s")

    def _on_item_moved(self, track_index: int, audio_item: AudioItem, new_start_time: float):
        """音频块移动完成"""
        self._update_status()
        self._status_label.setText(
            f"已移动: 轨道{track_index}, 位置 {new_start_time:.2f}s"
        )

    def _on_item_selected(self, audio_item: AudioItem):
        """音频块被选中"""
        self._update_status()

    def _on_fade_changed(self, audio_item: AudioItem, duration: float, is_fade_in: bool):
        """淡入淡出变化"""
        fade_type = "淡入" if is_fade_in else "淡出"
        self._status_label.setText(f"{fade_type}时长: {duration:.2f}s")

    # ════════════════════════════════════════════════
    # 编辑操作
    # ════════════════════════════════════════════════

    def _on_split(self):
        """在播放指针位置分割选中的音频块"""
        playhead = self._current_playhead_time
        found = False

        for widget in self.track_widgets:
            for block in widget.editor._block_items:
                if block.isSelected():
                    item = block.audio_item
                    if item.start_time < playhead < item.end_time:
                        self._split_item(item, playhead)
                        found = True
                        break
            if found:
                break

        if not found:
            # 尝试在当前播放指针位置分割任何块
            for widget in self.track_widgets:
                for block in widget.editor._block_items:
                    item = block.audio_item
                    if item.start_time < playhead < item.end_time:
                        self._split_item(item, playhead)
                        found = True
                        break
                if found:
                    break

        if not found:
            self._status_label.setText("播放指针位置没有音频块")

    def _split_item(self, item: AudioItem, split_time: float):
        """在 split_time 处分割音频块"""
        if item.audio_data is None:
            return

        track = item.track
        if track is None:
            return

        split_pos = split_time - item.start_time  # 相对于块起始的位置（秒）

        # 至少保留 0.1 秒
        if split_pos < 0.1 or split_pos > item.duration - 0.1:
            self._status_label.setText("分割位置太靠近边缘")
            return

        # 保存原始裁剪参数
        orig_trim_start = item._trim_start_sec
        orig_trim_end = item._trim_end_sec
        full_audio = item._original_audio or item.audio_data
        original_duration = len(full_audio) / 1000.0

        # 分割点相对于原始音频的偏移（毫秒）
        split_ms = int((orig_trim_start + split_pos) * 1000)

        # 更新原块为左半部分（从 orig_trim_start 到 split 点）
        item._trim_end_sec = original_duration - (orig_trim_start + split_pos)
        item._update_audio_data()

        # 创建右半部分（从 split 点 到 orig_trim_end）
        right_item = AudioItem(
            audio_data=full_audio[split_ms:int((original_duration - orig_trim_end) * 1000)],
            _original_audio=full_audio,
            _trim_start_sec=orig_trim_start + split_pos,
            _trim_end_sec=orig_trim_end,
            track=track,
            start_time=split_time,
            fade_in_duration=0.0,
            fade_out_duration=item.fade_out_duration,
            fade_in_type=item.fade_in_type,
            fade_out_type=item.fade_out_type,
            gain=item.gain,
            name=item.name + " (分割)",
        )

        # 添加到轨道
        track.add_item(right_item)

        # 更新 UI
        track_index = track.index
        track_widget = self.track_widgets[track_index]

        # 移除原块图形
        for block in track_widget.editor._block_items[:]:
            if block.audio_item is item:
                track_widget.editor._block_items.remove(block)
                track_widget.editor._scene.removeItem(block)
                break

        # 重新添加原块（已更新尺寸）
        track_widget.add_audio_block(item)
        # 添加新块
        track_widget.add_audio_block(right_item)

        self._update_status()
        self._status_label.setText(f"已在 {self._format_time(split_time)} 处分割")

    def _on_merge(self):
        """合并同一轨道上选中的音频块"""
        # 收集所有选中的音频块，按轨道分组
        track_items: dict = {}
        for widget in self.track_widgets:
            for block in widget.editor._block_items:
                if block.isSelected():
                    item = block.audio_item
                    tid = item.track.index if item.track else -1
                    if tid not in track_items:
                        track_items[tid] = []
                    track_items[tid].append(item)

        if not track_items:
            self._status_label.setText("请先选中要合并的音频块")
            return

        for tid, items in track_items.items():
            if len(items) < 2:
                continue

            # 按起始时间排序
            items.sort(key=lambda x: x.start_time)

            track = items[0].track
            if track is None:
                continue

            track_widget = self.track_widgets[tid]

            # 合并音频数据
            from pydub import AudioSegment
            merged = AudioSegment.silent(duration=0, frame_rate=44100)

            first = items[0]
            last = items[-1]
            merged_start = first.start_time
            merged_end = last.end_time

            # 按顺序拼接，间隙填充静音
            current_pos = first.start_time
            for item in items:
                gap = item.start_time - current_pos
                if gap > 0.01:
                    merged += AudioSegment.silent(
                        duration=int(gap * 1000),
                        frame_rate=44100,
                    )
                # 获取裁剪后的音频
                audio = item.audio_data
                if audio is not None:
                    merged += audio
                current_pos = item.end_time

            # 创建合并后的新块
            merged_item = AudioItem(
                audio_data=merged,
                _original_audio=merged,
                track=track,
                start_time=merged_start,
                fade_in_duration=first.fade_in_duration,
                fade_out_duration=last.fade_out_duration,
                fade_in_type=first.fade_in_type,
                fade_out_type=last.fade_out_type,
                gain=first.gain,
                name=f"{first.name} + ...",
            )

            # 移除旧块
            for item in items:
                track.remove_item(item)
                for block in track_widget.editor._block_items[:]:
                    if block.audio_item is item:
                        track_widget.editor._block_items.remove(block)
                        track_widget.editor._scene.removeItem(block)
                        break

            # 添加新块
            track_widget.add_audio_block(merged_item)

        self._update_status()
        self._status_label.setText("音频块已合并")

    def _on_delete_selected(self):
        """删除选中的音频块"""
        for widget in self.track_widgets:
            scene = widget.editor._scene
            for item in scene.selectedItems():
                if isinstance(item, AudioBlockItem):
                    widget.editor.remove_audio_block(item)
        self._update_status()
        self._status_label.setText("已删除选中音频块")

    def _on_select_all(self):
        """全选当前轨道"""
        for widget in self.track_widgets:
            for block in widget.editor._block_items:
                block.setSelected(True)
        self._status_label.setText("已全选")

    def _on_deselect_all(self):
        """取消选择"""
        for widget in self.track_widgets:
            for block in widget.editor._block_items:
                block.setSelected(False)
        self._status_label.setText("已取消选择")

    def _apply_fade_to_selected(self, is_fade_in: bool):
        for widget in self.track_widgets:
            scene = widget.editor._scene
            for item in scene.selectedItems():
                if isinstance(item, AudioBlockItem):
                    audio_item = item.audio_item
                    if is_fade_in:
                        audio_item.fade_in_duration = min(2.0, audio_item.duration / 4)
                        apply_fade_in(audio_item.audio_data,
                                      audio_item.fade_in_duration,
                                      audio_item.fade_in_type)
                    else:
                        audio_item.fade_out_duration = min(2.0, audio_item.duration / 4)
                        apply_fade_out(audio_item.audio_data,
                                       audio_item.fade_out_duration,
                                       audio_item.fade_out_type)
                    item.update()
        self._status_label.setText(f"已应用{'淡入' if is_fade_in else '淡出'}效果")

    # ════════════════════════════════════════════════
    # 缩放
    # ════════════════════════════════════════════════

    def _zoom_in(self):
        self.px_per_sec = min(self.MAX_PX_PER_SEC, self.px_per_sec * 1.5)
        self._update_all_tracks_zoom()

    def _zoom_out(self):
        self.px_per_sec = max(self.MIN_PX_PER_SEC, self.px_per_sec / 1.5)
        self._update_all_tracks_zoom()

    def _zoom_fit(self):
        width = self._editor_scroll.viewport().width()
        if self.project_duration > 0 and width > 0:
            self.px_per_sec = max(self.MIN_PX_PER_SEC,
                                  min(self.MAX_PX_PER_SEC, width / self.project_duration))
            self._update_all_tracks_zoom()

    def _toggle_snap(self):
        self._snap_enabled = not self._snap_enabled
        self._status_label.setText(f"吸附{'已开启' if self._snap_enabled else '已关闭'}")

    # ════════════════════════════════════════════════
    # 撤销/重做（EditHistory）
    # ════════════════════════════════════════════════

    def _on_undo(self):
        action = self._history.undo()
        if action is None:
            self._status_label.setText("无可撤销操作")
            return
        # 此处执行具体的撤销恢复逻辑（由具体操作类型决定）
        self._status_label.setText(f"已撤销: {self._history.undo_description()}")

    def _on_redo(self):
        action = self._history.redo()
        if action is None:
            self._status_label.setText("无可重做操作")
            return
        self._status_label.setText(f"已重做: {self._history.redo_description()}")

    # ════════════════════════════════════════════════
    # 项目保存/加载
    # ════════════════════════════════════════════════

    def _on_new_project(self):
        """新建项目"""
        if len(self.tracks) > 3 or any(t.items for t in self.tracks):
            reply = QMessageBox.question(
                self, "新建项目", "当前项目未保存，是否继续？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
            )
            if reply != QMessageBox.StandardButton.Yes:
                return

        # 清空所有轨道
        for widget in list(self.track_widgets):
            widget.editor.clear_blocks()
        for track in self.tracks:
            track.items.clear()
        self._history.clear()
        self._project_name = "未命名项目"
        self._project_file_path = None
        self.setWindowTitle("多轨音频编辑器 - 未命名项目")
        self._update_status()
        self._status_label.setText("已新建项目")

    def _on_open_project(self):
        """打开项目文件"""
        file_path, _ = QFileDialog.getOpenFileName(
            self, "打开项目", ProjectIO.default_project_dir(),
            ProjectIO.FILE_FILTER,
        )
        if not file_path:
            return

        project = ProjectIO.load_project(file_path)
        if project is None:
            return

        project_dir = os.path.dirname(file_path)
        ok, missing = ProjectIO.resolve_audio_files(project, project_dir)
        reloc: Dict[str, str] = {}
        if not ok:
            reloc = ProjectIO.show_relocate_dialog(missing, self)
            if reloc is None:
                return  # 用户取消

        # 清空当前项目
        self._on_new_project()

        # 加载轨道
        self._project_name = project.name
        self._project_file_path = file_path
        self.setWindowTitle(f"多轨音频编辑器 - {project.name}")

        # 确保有足够轨道
        while len(self.tracks) < len(project.tracks):
            self._add_track()

        # 加载每个轨道的数据
        from pydub import AudioSegment

        for ti, track_info in enumerate(project.tracks):
            if ti >= len(self.tracks):
                break
            track = self.tracks[ti]
            track.name = track_info.name
            track.volume = track_info.volume
            track.pan = track_info.pan
            track.muted = track_info.muted
            track.solo = track_info.solo

            # 加载轨道上的音频块
            for item_info in track_info.items:
                audio_path = ""
                if item_info.audio_file:
                    # 尝试已定位的路径
                    if item_info.audio_file in reloc:
                        audio_path = reloc[item_info.audio_file]
                    else:
                        audio_path = os.path.join(project_dir, item_info.audio_file)

                if audio_path and os.path.isfile(audio_path):
                    try:
                        audio = AudioSegment.from_file(audio_path)
                    except Exception:
                        audio = AudioSegment.silent(duration=1000)
                else:
                    audio = AudioSegment.silent(duration=1000)

                # 应用裁剪（从原始音频中截取片段）
                trim_start_ms = int(item_info.trim_start * 1000)
                trim_end_ms = int((len(audio) / 1000.0 - item_info.trim_end) * 1000)
                if trim_end_ms > trim_start_ms:
                    visible_audio = audio[trim_start_ms:trim_end_ms]
                else:
                    visible_audio = audio

                if item_info.fade_in.duration > 0:
                    visible_audio = visible_audio.fade_in(
                        int(item_info.fade_in.duration * 1000))
                if item_info.fade_out.duration > 0:
                    visible_audio = visible_audio.fade_out(
                        int(item_info.fade_out.duration * 1000))

                from track_item import FadeType
                fade_type_map = {
                    "linear": FadeType.LINEAR,
                    "exponential": FadeType.EXPONENTIAL,
                    "logarithmic": FadeType.LOGARITHMIC,
                    "s_curve": FadeType.S_CURVE,
                }

                item = AudioItem(
                    audio_data=visible_audio,
                    _original_audio=audio,
                    track=track,
                    start_time=item_info.start_time,
                    fade_in_duration=item_info.fade_in.duration,
                    fade_out_duration=item_info.fade_out.duration,
                    fade_in_type=fade_type_map.get(
                        item_info.fade_in.type, FadeType.LINEAR),
                    fade_out_type=fade_type_map.get(
                        item_info.fade_out.type, FadeType.LINEAR),
                    gain=item_info.gain,
                    name=item_info.name,
                    muted=item_info.muted,
                )
                item._source_file = audio_path if os.path.isfile(audio_path) else ""
                item._trim_start_sec = item_info.trim_start
                item._trim_end_sec = item_info.trim_end
                track.add_item(item)
                self.track_widgets[ti].add_audio_block(item)

        self._update_status()
        self._status_label.setText(f"已加载项目: {project.name}")

    def _on_save_project(self):
        """保存项目"""
        if self._project_file_path:
            ok = ProjectIO.save_project(
                self.tracks, self._project_name,
                self._project_file_path,
                bpm=self._bpm_spin.value(),
            )
            if ok:
                self._status_label.setText(f"已保存: {self._project_name}")
        else:
            self._on_save_project_as()

    def _on_save_project_as(self):
        """另存为"""
        default_name = f"{self._project_name}.mep"
        file_path, _ = QFileDialog.getSaveFileName(
            self, "保存项目",
            os.path.join(ProjectIO.default_project_dir(), default_name),
            ProjectIO.FILE_FILTER,
        )
        if not file_path:
            return

        self._project_file_path = file_path
        name = os.path.splitext(os.path.basename(file_path))[0]
        self._project_name = name
        self.setWindowTitle(f"多轨音频编辑器 - {name}")

        ok = ProjectIO.save_project(
            self.tracks, name, file_path,
            bpm=self._bpm_spin.value(),
        )
        if ok:
            self._status_label.setText(f"已保存: {file_path}")

    # ════════════════════════════════════════════════
    # 混音面板
    # ════════════════════════════════════════════════

    def _open_mixer_panel(self):
        """打开混音面板"""
        if self._mixer_panel is None:
            self._mixer_panel = MixerPanel(self.tracks, self)
            self._mixer_panel.muteToggled.connect(self._on_track_mute)
            self._mixer_panel.soloToggled.connect(self._on_track_solo)
            self._mixer_panel.volumeChanged.connect(self._on_track_volume)
            self._mixer_panel.panChanged.connect(self._on_track_pan)
            self._mixer_panel.masterVolumeChanged.connect(
                self._on_master_volume_changed)
        self._mixer_panel.show()
        self._mixer_panel.raise_()
        self._mixer_panel.activateWindow()
        self._mixer_panel.sync_all()

    def _on_master_volume_changed(self, volume: float):
        """主音量变化"""
        self._master_vol.setValue(int(volume * 100))
        self._status_label.setText(f"主音量: {int(volume * 100)}%")

    # ════════════════════════════════════════════════
    # 键盘快捷键
    # ════════════════════════════════════════════════

    def keyPressEvent(self, event):
        key = event.key()
        mod = event.modifiers()

        # Space: 播放/暂停
        if key == Qt.Key.Key_Space:
            self._on_play_pause()
            event.accept()
            return

        # S: 分割
        if key == Qt.Key.Key_S and not mod:
            self._on_split()
            event.accept()
            return

        # J: 合并
        if key == Qt.Key.Key_J and not mod:
            self._on_merge()
            event.accept()
            return

        # Delete: 删除
        if key == Qt.Key.Key_Delete or key == Qt.Key.Key_Backspace:
            self._on_delete_selected()
            event.accept()
            return

        # M: 静音当前轨道
        if key == Qt.Key.Key_M and not mod:
            for widget in self.track_widgets:
                if widget.track.items:
                    widget.track.muted = not widget.track.muted
                    widget.sync_from_track()
                    self._status_label.setText(
                        f"轨道 {widget.track.index + 1} {'静音' if widget.track.muted else '取消静音'}"
                    )
                    break
            event.accept()
            return

        # ← → : 移动播放指针
        if key == Qt.Key.Key_Left and not mod:
            self._move_playhead(-1.0)
            event.accept()
            return
        if key == Qt.Key.Key_Right and not mod:
            self._move_playhead(1.0)
            event.accept()
            return
        if key == Qt.Key.Key_Left and mod & Qt.KeyboardModifier.ShiftModifier:
            self._move_playhead(-0.1)
            event.accept()
            return
        if key == Qt.Key.Key_Right and mod & Qt.KeyboardModifier.ShiftModifier:
            self._move_playhead(0.1)
            event.accept()
            return

        # Home/End: 跳转到开头/末尾
        if key == Qt.Key.Key_Home:
            self._on_seek(0)
            event.accept()
            return
        if key == Qt.Key.Key_End:
            self._on_seek(int(self.project_duration * 1000))
            event.accept()
            return

        # ↑↓: 切换轨道选择
        if key == Qt.Key.Key_Up and not mod:
            self._status_label.setText("请使用鼠标选择轨道")
            event.accept()
            return
        if key == Qt.Key.Key_Down and not mod:
            self._status_label.setText("请使用鼠标选择轨道")
            event.accept()
            return

        super().keyPressEvent(event)

    # ════════════════════════════════════════════════
    # 工具方法
    # ════════════════════════════════════════════════

    def _create_action(self, text: str, slot, shortcut=None) -> QAction:
        action = QAction(text, self)
        action.triggered.connect(slot)
        if shortcut:
            action.setShortcut(QKeySequence(shortcut))
        return action

    @staticmethod
    def _format_time(sec: float) -> str:
        if sec < 0:
            sec = 0
        m = int(sec // 60)
        s = int(sec % 60)
        ms = int((sec % 1) * 10)
        return f"{m:02d}:{s:02d}.{ms}"

    def _show_about(self):
        QMessageBox.about(self, "关于",
            "<h3>多轨音频编辑器</h3>"
            "<p>基于 PyQt6 + pydub + numpy 的多轨音频编辑工具</p>"
            "<p>支持：多轨道编辑、淡入淡出、混音导出、撤销/重做</p>"
            "<p>项目保存/加载 (.mep)、混音面板、键盘快捷键</p>"
            "<p>快捷键: Space=播放 S=分割 J=合并 Delete=删除</p>"
        )

    def closeEvent(self, event):
        if self._is_playing:
            self._pause()
        if self._mixer_panel:
            self._mixer_panel.close()
        super().closeEvent(event)


# ═══════════════════════════════════════════════════════
# 入口
# ═══════════════════════════════════════════════════════

def main():
    import sys
    app = QApplication(sys.argv)
    app.setStyle("Fusion")

    from PyQt6.QtGui import QPalette
    palette = QPalette()
    palette.setColor(QPalette.ColorRole.Window, QColor(26, 26, 26))
    palette.setColor(QPalette.ColorRole.WindowText, QColor(255, 255, 255))
    palette.setColor(QPalette.ColorRole.Base, QColor(26, 26, 26))
    palette.setColor(QPalette.ColorRole.Text, QColor(255, 255, 255))
    palette.setColor(QPalette.ColorRole.Button, QColor(42, 42, 42))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor(255, 255, 255))
    palette.setColor(QPalette.ColorRole.Highlight, QColor(255, 107, 107))
    palette.setColor(QPalette.ColorRole.HighlightedText, QColor(255, 255, 255))
    palette.setColor(QPalette.ColorRole.ToolTipBase, QColor(42, 42, 42))
    palette.setColor(QPalette.ColorRole.ToolTipText, QColor(255, 255, 255))
    app.setPalette(palette)

    window = AudioEditorWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()