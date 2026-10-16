"""
多轨音频编辑器 - 轨道组件

每个轨道是一个水平条，包含：
  - TrackControlWidget: 左侧控制区（150px）- 名称、M/S按钮、音量/声像滑块
  - TrackEditorWidget:  右侧编辑区 - QGraphicsScene 显示音频块、支持拖入文件
  - TrackWidget:        组合以上两者
"""

from typing import Optional, List

from PyQt6.QtCore import Qt, pyqtSignal, QRectF, QPointF, QSize
from PyQt6.QtGui import QColor, QPen, QBrush, QPainter, QFont, QDragEnterEvent, QDropEvent
from PyQt6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QLabel, QPushButton, QSlider,
    QLineEdit, QGraphicsScene, QGraphicsView, QGraphicsRectItem,
    QGraphicsLineItem, QMenu, QSizePolicy, QFrame,
)

from track_item import AudioTrack, AudioItem, AudioBlockItem, TrackColor, FadeType


# ═══════════════════════════════════════════════════════
# 轨道控制区（左侧）
# ═══════════════════════════════════════════════════════

class TrackControlWidget(QFrame):
    """
    轨道控制区（左侧固定 150px）。

    包含：轨道名称、静音/独奏按钮、音量/声像滑块、颜色标识。
    """

    CONTROL_WIDTH = 150

    # 信号
    muteToggled = pyqtSignal(int, bool)     # (track_index, muted)
    soloToggled = pyqtSignal(int, bool)     # (track_index, solo)
    volumeChanged = pyqtSignal(int, float)  # (track_index, volume)
    panChanged = pyqtSignal(int, float)     # (track_index, pan)
    nameChanged = pyqtSignal(int, str)      # (track_index, new_name)
    colorChangeRequested = pyqtSignal(int)  # (track_index)

    def __init__(self, track: AudioTrack, parent=None):
        super().__init__(parent)
        self.track = track
        self._editing_name = False

        self.setFixedWidth(self.CONTROL_WIDTH)
        self.setFixedHeight(80)  # 与 TrackEditorWidget.TRACK_HEIGHT 对齐
        self.setMinimumHeight(80)
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self._update_bg_color()

        layout = QVBoxLayout(self)
        layout.setContentsMargins(6, 4, 6, 4)
        layout.setSpacing(3)

        # ── 轨道名称 + 颜色标识 ──
        name_row = QHBoxLayout()
        name_row.setSpacing(4)

        self._color_label = QLabel("●")
        self._color_label.setFixedWidth(14)
        self._color_label.setStyleSheet(
            f"color: rgb({track.color.red()},{track.color.green()},{track.color.blue()});"
            "font-size: 14px;"
        )
        self._color_label.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._color_label.customContextMenuRequested.connect(
            lambda: self.colorChangeRequested.emit(self.track.index)
        )
        name_row.addWidget(self._color_label)

        self._name_edit = QLineEdit(track.name)
        self._name_edit.setStyleSheet(
            "QLineEdit { background: transparent; border: none; color: #ddd;"
            "  font-size: 12px; padding: 0; }"
            "QLineEdit:focus { border: 1px solid #555; background: #333; }"
        )
        self._name_edit.returnPressed.connect(self._on_name_committed)
        self._name_edit.editingFinished.connect(self._on_name_committed)
        name_row.addWidget(self._name_edit, 1)

        layout.addLayout(name_row)

        # ── M / S 按钮 ──
        btn_row = QHBoxLayout()
        btn_row.setSpacing(4)

        self._mute_btn = QPushButton("M")
        self._mute_btn.setFixedSize(28, 22)
        self._mute_btn.setCheckable(True)
        self._mute_btn.setToolTip("静音 (Mute)")
        self._mute_btn.clicked.connect(self._on_mute_toggled)
        self._style_mute_button(False)
        btn_row.addWidget(self._mute_btn)

        self._solo_btn = QPushButton("S")
        self._solo_btn.setFixedSize(28, 22)
        self._solo_btn.setCheckable(True)
        self._solo_btn.setToolTip("独奏 (Solo)")
        self._solo_btn.clicked.connect(self._on_solo_toggled)
        self._style_solo_button(False)
        btn_row.addWidget(self._solo_btn)

        btn_row.addStretch()
        layout.addLayout(btn_row)

        # ── 音量滑块 ──
        vol_row = QHBoxLayout()
        vol_label = QLabel("音量")
        vol_label.setFixedWidth(24)
        vol_label.setStyleSheet("color: #999; font-size: 10px;")
        vol_row.addWidget(vol_label)

        self._vol_slider = QSlider(Qt.Orientation.Horizontal)
        self._vol_slider.setRange(0, 200)
        self._vol_slider.setValue(int(track.volume * 100))
        self._vol_slider.valueChanged.connect(self._on_volume_changed)
        vol_row.addWidget(self._vol_slider, 1)

        self._vol_label = QLabel(f"{int(track.volume * 100)}%")
        self._vol_label.setFixedWidth(32)
        self._vol_label.setStyleSheet("color: #999; font-size: 10px;")
        vol_row.addWidget(self._vol_label)
        layout.addLayout(vol_row)

        # ── 声像滑块 ──
        pan_row = QHBoxLayout()
        pan_label = QLabel("声像")
        pan_label.setFixedWidth(24)
        pan_label.setStyleSheet("color: #999; font-size: 10px;")
        pan_row.addWidget(pan_label)

        self._pan_slider = QSlider(Qt.Orientation.Horizontal)
        self._pan_slider.setRange(-100, 100)
        self._pan_slider.setValue(int(track.pan * 100))
        self._pan_slider.valueChanged.connect(self._on_pan_changed)
        pan_row.addWidget(self._pan_slider, 1)

        self._pan_label = QLabel(self._pan_text(track.pan))
        self._pan_label.setFixedWidth(32)
        self._pan_label.setStyleSheet("color: #999; font-size: 10px;")
        pan_row.addWidget(self._pan_label)
        layout.addLayout(pan_row)

        layout.addStretch()

    def _update_bg_color(self):
        """根据轨道颜色设置背景"""
        c = self.track.color
        self.setStyleSheet(
            f"TrackControlWidget {{ background: rgba({c.red()},{c.green()},{c.blue()},20);"
            f"  border-right: 1px solid #333; border-bottom: 1px solid #333; }}"
        )

    def _style_mute_button(self, active: bool):
        if active:
            self._mute_btn.setStyleSheet(
                "QPushButton { background: #ff3b30; color: white; font-weight: bold;"
                "  border-radius: 3px; }"
            )
        else:
            self._mute_btn.setStyleSheet(
                "QPushButton { background: #444; color: #ccc; border-radius: 3px; }"
                "QPushButton:hover { background: #555; }"
            )

    def _style_solo_button(self, active: bool):
        if active:
            self._solo_btn.setStyleSheet(
                "QPushButton { background: #ffcc00; color: black; font-weight: bold;"
                "  border-radius: 3px; }"
            )
        else:
            self._solo_btn.setStyleSheet(
                "QPushButton { background: #444; color: #ccc; border-radius: 3px; }"
                "QPushButton:hover { background: #555; }"
            )

    def _pan_text(self, pan: float) -> str:
        if abs(pan) < 0.01:
            return "C"
        if pan < 0:
            return f"L{int(abs(pan) * 100)}"
        return f"R{int(pan * 100)}"

    # ── 事件处理 ──

    def _on_mute_toggled(self):
        self.track.muted = self._mute_btn.isChecked()
        self._style_mute_button(self.track.muted)
        self.muteToggled.emit(self.track.index, self.track.muted)

    def _on_solo_toggled(self):
        self.track.solo = self._solo_btn.isChecked()
        self._style_solo_button(self.track.solo)
        self.soloToggled.emit(self.track.index, self.track.solo)

    def _on_volume_changed(self, value: int):
        self.track.volume = value / 100.0
        self._vol_label.setText(f"{value}%")
        self.volumeChanged.emit(self.track.index, self.track.volume)

    def _on_pan_changed(self, value: int):
        self.track.pan = value / 100.0
        self._pan_label.setText(self._pan_text(self.track.pan))
        self.panChanged.emit(self.track.index, self.track.pan)

    def _on_name_committed(self):
        new_name = self._name_edit.text().strip()
        if new_name and new_name != self.track.name:
            self.track.name = new_name
            self.nameChanged.emit(self.track.index, new_name)
        else:
            self._name_edit.setText(self.track.name)

    # ── 公开方法 ──

    def update_track_color(self, color: QColor):
        self.track.color = color
        self._color_label.setStyleSheet(
            f"color: rgb({color.red()},{color.green()},{color.blue()}); font-size: 14px;"
        )
        self._update_bg_color()

    def sync_from_track(self):
        """从数据模型同步 UI 状态"""
        self._name_edit.setText(self.track.name)
        self._mute_btn.setChecked(self.track.muted)
        self._style_mute_button(self.track.muted)
        self._solo_btn.setChecked(self.track.solo)
        self._style_solo_button(self.track.solo)
        self._vol_slider.setValue(int(self.track.volume * 100))
        self._pan_slider.setValue(int(self.track.pan * 100))


# ═══════════════════════════════════════════════════════
# 轨道编辑区（右侧）
# ═══════════════════════════════════════════════════════

class TrackEditorWidget(QGraphicsView):
    """
    轨道编辑区（右侧）。

    使用 QGraphicsScene/QGraphicsView 显示音频块。
    支持拖入音频文件、显示波形、播放指针。
    """

    TRACK_HEIGHT = 80

    # 信号
    audioDropped = pyqtSignal(int, str, float)  # (track_index, file_path, start_time)
    itemMoved = pyqtSignal(int, object, float)  # (track_index, audio_item, new_start_time)
    itemSelected = pyqtSignal(object)           # (audio_item)
    splitRequested = pyqtSignal(object, float)  # (audio_item, split_time)
    deleteRequested = pyqtSignal(object)        # (audio_item)
    blockDragToTrack = pyqtSignal(object, float)  # (audio_item, global_y)
    blockTrimmed = pyqtSignal(object, float, float)  # (item, trim_start, trim_end)
    fadeChanged = pyqtSignal(object, float, bool)  # (audio_item, duration, is_fade_in)

    def __init__(self, track: AudioTrack, px_per_sec: float = 50.0,
                 get_playhead_time=None, parent=None):
        super().__init__(parent)
        self.track = track
        self.px_per_sec = px_per_sec
        self._get_playhead_time = get_playhead_time or (lambda: 0.0)
        self._block_items: List[AudioBlockItem] = []

        # 场景
        self._scene = QGraphicsScene(self)
        self._scene.setSceneRect(0, 0, 10000, self.TRACK_HEIGHT + 20)
        self.setScene(self._scene)

        # 视图设置
        self.setRenderHint(QPainter.RenderHint.Antialiasing)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setAcceptDrops(True)
        self.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        self.setStyleSheet(
            "QGraphicsView { border: none; background: #1a1a1a; }"
            "QGraphicsView::viewport { background: #1a1a1a; }"
        )

        # 背景
        self._bg_rect = QGraphicsRectItem()
        self._bg_rect.setZValue(-1)
        self._scene.addItem(self._bg_rect)

        # 播放指针
        self._playhead = QGraphicsLineItem()
        self._playhead.setPen(QPen(QColor(255, 107, 107), 1))
        self._playhead.setZValue(200)
        self._scene.addItem(self._playhead)
        self._playhead.setVisible(False)

        self.update_track_height()

    def update_track_height(self):
        """更新轨道高度"""
        height = self.TRACK_HEIGHT
        self.setFixedHeight(height)
        self.setMinimumHeight(height)
        self._bg_rect.setRect(0, 0, 10000, height)

        # 交替背景色 - 使用中性灰色系
        bg_color = QColor(38, 38, 38) if self.track.index % 2 == 0 else QColor(42, 42, 42)
        self._bg_rect.setBrush(QBrush(bg_color))
        self._bg_rect.setPen(QPen(QColor(51, 51, 51)))

    def set_px_per_sec(self, px_per_sec: float):
        """更新缩放级别"""
        self.px_per_sec = px_per_sec
        for block in self._block_items:
            block.set_px_per_sec(px_per_sec)
        self._update_playhead()
        # 更新场景矩形以适应放大的内容
        max_x = 10000
        for block in self._block_items:
            x = block.pos().x() + block.rect().width()
            if x > max_x:
                max_x = x + 500
        self._scene.setSceneRect(0, 0, max_x, self.TRACK_HEIGHT + 20)

    def add_audio_block(self, item: AudioItem):
        """添加音频块到轨道"""
        self.track.add_item(item)
        block = AudioBlockItem(item, self.px_per_sec,
                               get_playhead_time=self._get_playhead_time)
        # 存储 track_widget 引用以便剪贴板操作
        block._track_widget_ref = self
        self._scene.addItem(block)
        self._block_items.append(block)

        # 扩展场景矩形以容纳新块
        block_right = block.pos().x() + block.rect().width()
        if block_right > self._scene.sceneRect().width():
            new_width = block_right + 2000
            self._scene.setSceneRect(0, 0, new_width, self.TRACK_HEIGHT + 20)

        # 设置回调（替代 pyqtSignal，因为 QGraphicsRectItem 不是 QObject）
        block.on_split_requested = lambda i, t: self.splitRequested.emit(i, t)
        block.on_delete_requested = lambda i: self.deleteRequested.emit(i)
        block.on_block_drag_to_track = lambda i, y: self.blockDragToTrack.emit(i, y)
        block.on_block_trimmed = lambda i, ts, te: self.blockTrimmed.emit(i, ts, te)
        block.on_block_moved = lambda i, t: self.itemMoved.emit(self.track.index, i, t)
        block.on_block_selected = lambda i: self.itemSelected.emit(i)
        block.on_fade_changed = lambda i, d, fi: self.fadeChanged.emit(i, d, fi)

    def remove_audio_block(self, block: AudioBlockItem):
        """移除音频块"""
        if block in self._block_items:
            self._block_items.remove(block)
        if block.audio_item.track:
            block.audio_item.track.remove_item(block.audio_item)
        self._scene.removeItem(block)

    def clear_blocks(self):
        """清空所有音频块"""
        for block in self._block_items:
            self._scene.removeItem(block)
        self._block_items.clear()
        self.track.items.clear()

    def set_playhead_position(self, time_sec: float):
        """设置播放指针位置"""
        x = time_sec * self.px_per_sec
        self._playhead.setLine(x, 0, x, self.TRACK_HEIGHT)
        self._playhead.setVisible(True)

    def hide_playhead(self):
        self._playhead.setVisible(False)

    def _update_playhead(self):
        """更新播放指针长度"""
        line = self._playhead.line()
        self._playhead.setLine(line.x1(), 0, line.x1(), self.TRACK_HEIGHT)

    # ── 拖放支持 ──

    VALID_EXTS = ('.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a')

    @staticmethod
    def _extract_paths_from_mime(mime_data):
        """从 QMimeData 中安全提取文件路径（兼容 PyQt6 的 Windows URL 问题）"""
        paths = []
        if not mime_data.hasUrls():
            return paths
        for url in mime_data.urls():
            path = url.toLocalFile()
            if not path:
                # 降级方案：手动解析 file:// URL
                url_str = url.toString()
                if url_str.startswith('file://'):
                    from urllib.parse import unquote
                    if url_str.startswith('file:///'):
                        raw = url_str[8:]
                    else:
                        raw = url_str[7:]
                    path = unquote(raw)
                    # Windows 盘符修复：/C:/xxx -> C:/xxx
                    if len(path) >= 3 and path[0] == '/' and path[2] == ':':
                        path = path[1:]
                    # 形式如 /D/... 改为 D:/...
                    if (len(path) >= 3 and path[0].isalpha()
                            and path[1] in ('/', '\\') and ':' not in path[:3]):
                        path = path[0] + ':' + path[1:]
            if path:
                import os
                path = os.path.normpath(path.strip().strip('\x00'))
                paths.append(path)
        return paths

    def dragEnterEvent(self, event: QDragEnterEvent):
        paths = self._extract_paths_from_mime(event.mimeData())
        for p in paths:
            if p.lower().endswith(self.VALID_EXTS):
                event.acceptProposedAction()
                return
        event.ignore()

    def dragMoveEvent(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event: QDropEvent):
        """处理音频文件拖放"""
        loaded = False
        paths = self._extract_paths_from_mime(event.mimeData())
        for path in paths:
            if path.lower().endswith(self.VALID_EXTS):
                drop_pos = self.mapToScene(event.position().toPoint())
                start_time = max(0, drop_pos.x() / self.px_per_sec)
                self.audioDropped.emit(self.track.index, path, start_time)
                loaded = True
        if loaded:
            event.acceptProposedAction()
        else:
            event.ignore()


# ═══════════════════════════════════════════════════════
# 轨道组件（组合控制区 + 编辑区）
# ═══════════════════════════════════════════════════════

class TrackWidget(QWidget):
    """
    完整的轨道组件 = 控制区 + 编辑区。

    信号转发：将子组件的信号统一转发给主窗口。
    """

    # 转发信号
    muteToggled = pyqtSignal(int, bool)
    soloToggled = pyqtSignal(int, bool)
    volumeChanged = pyqtSignal(int, float)
    panChanged = pyqtSignal(int, float)
    nameChanged = pyqtSignal(int, str)
    colorChangeRequested = pyqtSignal(int)
    audioDropped = pyqtSignal(int, str, float)
    itemMoved = pyqtSignal(int, object, float)
    itemSelected = pyqtSignal(object)
    splitRequested = pyqtSignal(object, float)
    deleteRequested = pyqtSignal(object)
    blockDragToTrack = pyqtSignal(object, float)
    blockTrimmed = pyqtSignal(object, float, float)
    fadeChanged = pyqtSignal(object, float, bool)

    def __init__(self, track: AudioTrack, px_per_sec: float = 50.0,
                 get_playhead_time=None, parent=None):
        super().__init__(parent)
        self.track = track
        self.px_per_sec = px_per_sec

        # 整体使用固定高度，确保左右对齐
        self.setFixedHeight(TrackEditorWidget.TRACK_HEIGHT)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setStyleSheet("background: #1a1a1a;")

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # 控制区
        self.control = TrackControlWidget(track)
        self.control.setFixedHeight(TrackEditorWidget.TRACK_HEIGHT)
        layout.addWidget(self.control)

        # 编辑区
        self.editor = TrackEditorWidget(track, px_per_sec,
                                        get_playhead_time=get_playhead_time)
        self.editor.setFixedHeight(TrackEditorWidget.TRACK_HEIGHT)
        layout.addWidget(self.editor, 1)

        # 连接信号
        self.control.muteToggled.connect(self.muteToggled)
        self.control.soloToggled.connect(self.soloToggled)
        self.control.volumeChanged.connect(self.volumeChanged)
        self.control.panChanged.connect(self.panChanged)
        self.control.nameChanged.connect(self.nameChanged)
        self.control.colorChangeRequested.connect(self.colorChangeRequested)

        self.editor.audioDropped.connect(self.audioDropped)
        self.editor.splitRequested.connect(self.splitRequested)
        self.editor.deleteRequested.connect(self.deleteRequested)
        self.editor.blockDragToTrack.connect(self.blockDragToTrack)
        self.editor.blockTrimmed.connect(self.blockTrimmed)
        self.editor.itemMoved.connect(self.itemMoved)
        self.editor.itemSelected.connect(self.itemSelected)
        self.editor.fadeChanged.connect(self.fadeChanged)

    def set_px_per_sec(self, px_per_sec: float):
        """更新缩放级别"""
        self.px_per_sec = px_per_sec
        self.editor.set_px_per_sec(px_per_sec)

    def set_playhead_position(self, time_sec: float):
        self.editor.set_playhead_position(time_sec)

    def hide_playhead(self):
        self.editor.hide_playhead()

    def add_audio_block(self, item: AudioItem):
        self.editor.add_audio_block(item)

    def update_track_color(self, color: QColor):
        self.control.update_track_color(color)
        # 更新音频块颜色
        for block in self.editor._block_items:
            c = color
            block.setBrush(QBrush(QColor(c.red(), c.green(), c.blue(), 160)))
            block.setPen(QPen(c.darker(150), 1))
            block.update()

    def sync_from_track(self):
        self.control.sync_from_track()
