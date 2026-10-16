"""
多轨音频编辑器 - 数据结构与淡入淡出功能

包含：
  - AudioTrack:  音频轨道数据
  - AudioItem:   轨道上的音频块（支持非破坏性裁剪）
  - FadeType:    淡入淡出曲线类型枚举
  - 淡入淡出包络生成与应用（numpy）
  - FadeHandle:  QGraphicsItem 淡入淡出控制柄
  - AudioBlockItem: 音频块图形项（拖拽、裁剪、多选、右键菜单）
"""

from enum import Enum
from dataclasses import dataclass, field
from typing import Optional, List, Callable

import numpy as np
from PyQt6.QtCore import Qt, QRectF, QPointF, QLineF
from PyQt6.QtGui import (
    QColor, QPen, QBrush, QPainter, QPainterPath, QFont, QCursor, QAction,
)
from PyQt6.QtWidgets import (
    QGraphicsItem, QGraphicsRectItem, QGraphicsSceneMouseEvent, QMenu,
)


# ═══════════════════════════════════════════════════════
# 枚举
# ═══════════════════════════════════════════════════════

class FadeType(Enum):
    """淡入淡出曲线类型"""
    LINEAR = "线性"
    EXPONENTIAL = "指数"
    LOGARITHMIC = "对数"
    S_CURVE = "S曲线"


class EdgeType(Enum):
    """鼠标在音频块上的位置区域"""
    NONE = 0
    LEFT_EDGE = 1   # 左边缘裁剪
    RIGHT_EDGE = 2  # 右边缘裁剪
    BODY = 3        # 主体拖拽
    TOP_EDGE = 4    # 垂直拖拽（移出轨道）


class TrackColor:
    """轨道默认颜色池"""
    POOL = [
        QColor(86, 156, 214),    # 蓝
        QColor(78, 201, 176),    # 青绿
        QColor(220, 163, 90),    # 橙
        QColor(197, 134, 192),   # 紫
        QColor(220, 120, 120),   # 红
        QColor(181, 206, 168),   # 浅绿
        QColor(206, 145, 120),   # 棕
        QColor(120, 183, 220),   # 浅蓝
    ]

    @classmethod
    def get(cls, index: int) -> QColor:
        return cls.POOL[index % len(cls.POOL)]


# ═══════════════════════════════════════════════════════
# 数据结构
# ═══════════════════════════════════════════════════════

@dataclass
class AudioItem:
    """轨道上的音频块（支持非破坏性裁剪）"""
    audio_data: object = None         # pydub.AudioSegment 对象（当前可见部分）
    track: Optional['AudioTrack'] = None
    start_time: float = 0.0           # 在时间轴上的起始时间（秒）
    fade_in_duration: float = 0.0     # 淡入时长（秒）
    fade_out_duration: float = 0.0    # 淡出时长（秒）
    fade_in_type: FadeType = FadeType.LINEAR
    fade_out_type: FadeType = FadeType.LINEAR
    gain: float = 1.0                 # 独立增益（0-2.0）
    name: str = ""
    muted: bool = False               # 音频块静音

    # 非破坏性裁剪
    _original_audio: object = field(default=None, repr=False)
    _trim_start_sec: float = 0.0      # 从开头裁剪掉的秒数
    _trim_end_sec: float = 0.0        # 从结尾裁剪掉的秒数

    # 缓存的波形缩略图（用于绘制）
    _waveform_cache: Optional[np.ndarray] = field(default=None, repr=False)

    def __post_init__(self):
        if self._original_audio is None and self.audio_data is not None:
            self._original_audio = self.audio_data

    @property
    def original_duration(self) -> float:
        """原始音频全长（秒）"""
        if self._original_audio is not None:
            return len(self._original_audio) / 1000.0
        if self.audio_data is not None:
            return len(self.audio_data) / 1000.0
        return 0.0

    @property
    def duration(self) -> float:
        """音频块当前可见时长（秒）"""
        return max(0.001, self.original_duration - self._trim_start_sec - self._trim_end_sec)

    @property
    def end_time(self) -> float:
        """结束时间（秒）"""
        return self.start_time + self.duration

    @property
    def max_trim_start(self) -> float:
        """最大可向左裁剪量（不可超过原始长度的一半）"""
        return self.original_duration - self.duration - self._trim_end_sec

    def set_trim_start(self, sec: float):
        """设置从开头裁剪掉的时间（非破坏性）"""
        max_trim = self.original_duration - self.duration - self._trim_end_sec
        self._trim_start_sec = max(0, min(sec, max_trim))
        self._update_audio_data()

    def set_trim_end(self, sec: float):
        """设置从结尾裁剪掉的时间（非破坏性）"""
        max_trim = self.original_duration - self._trim_start_sec - 0.001
        self._trim_end_sec = max(0, min(sec, max_trim))
        self._update_audio_data()

    def _update_audio_data(self):
        """根据裁剪参数更新 audio_data"""
        if self._original_audio is None:
            return
        start_ms = int(self._trim_start_sec * 1000)
        end_ms = int((self.original_duration - self._trim_end_sec) * 1000)
        self.audio_data = self._original_audio[start_ms:end_ms]
        self._waveform_cache = None  # 清除缓存

    def get_waveform(self, samples: int = 200) -> np.ndarray:
        """
        获取降采样波形数据（用于绘制缩略图）。
        返回 shape=(samples,) 的振幅数组（0-1）。
        """
        if self._waveform_cache is not None and len(self._waveform_cache) == samples:
            return self._waveform_cache

        if self.audio_data is None:
            return np.zeros(samples)

        # 提取原始采样数据
        raw = np.array(self.audio_data.get_array_of_samples(), dtype=np.float64)

        # 多声道取平均值
        if self.audio_data.channels > 1:
            raw = raw.reshape(-1, self.audio_data.channels).mean(axis=1)

        # 归一化
        max_val = float(self.audio_data.max_possible_amplitude)
        if max_val > 0:
            raw = raw / max_val

        # 降采样到目标采样数
        if len(raw) > samples:
            chunk = len(raw) // samples
            waveform = np.array([
                np.max(np.abs(raw[i * chunk:(i + 1) * chunk]))
                for i in range(samples)
            ])
        else:
            x_old = np.linspace(0, 1, len(raw))
            x_new = np.linspace(0, 1, samples)
            waveform = np.interp(x_new, x_old, np.abs(raw))

        self._waveform_cache = waveform
        return waveform


@dataclass
class AudioTrack:
    """音频轨道"""
    name: str = ""
    index: int = 0
    color: QColor = field(default_factory=lambda: QColor(86, 156, 214))
    muted: bool = False
    solo: bool = False
    volume: float = 1.0               # 0-2.0
    pan: float = 0.0                  # -1.0（左）到 1.0（右）
    items: List[AudioItem] = field(default_factory=list)

    def add_item(self, item: AudioItem):
        item.track = self
        self.items.append(item)

    def remove_item(self, item: AudioItem):
        if item in self.items:
            self.items.remove(item)
        item.track = None

    @property
    def duration(self) -> float:
        """轨道总时长（最后一个音频块的结束时间）"""
        if not self.items:
            return 0.0
        return max(item.end_time for item in self.items)


# ═══════════════════════════════════════════════════════
# 淡入淡出包络生成与应用
# ═══════════════════════════════════════════════════════

def generate_fade_envelope(fade_type: FadeType, num_samples: int) -> np.ndarray:
    """
    生成淡入淡出包络曲线。

    Args:
        fade_type:   曲线类型
        num_samples: 采样数

    Returns:
        shape=(num_samples,) 的 0→1 包络数组
    """
    if num_samples <= 0:
        return np.ones(0)

    n = num_samples

    if fade_type == FadeType.LINEAR:
        return np.linspace(0, 1, n)

    elif fade_type == FadeType.EXPONENTIAL:
        return np.linspace(0, 1, n) ** 2

    elif fade_type == FadeType.LOGARITHMIC:
        return np.logspace(-2, 0, n)

    elif fade_type == FadeType.S_CURVE:
        t = np.linspace(0, 1, n)
        return 0.5 - 0.5 * np.cos(np.pi * t)

    return np.linspace(0, 1, n)


def apply_fade_in(audio_data, fade_duration: float, fade_type: FadeType):
    """在音频数据上应用淡入效果（直接修改原始数据）"""
    if fade_duration <= 0 or audio_data is None:
        return
    sample_rate = audio_data.frame_rate
    channels = audio_data.channels
    fade_samples = int(fade_duration * sample_rate)
    total_samples = len(audio_data.get_array_of_samples()) // channels
    if fade_samples >= total_samples:
        fade_samples = total_samples
    if fade_samples <= 0:
        return
    envelope = generate_fade_envelope(fade_type, fade_samples)
    raw = np.array(audio_data.get_array_of_samples(), dtype=np.float64)
    if channels > 1:
        raw = raw.reshape(-1, channels)
        for ch in range(channels):
            raw[:fade_samples, ch] *= envelope
        raw = raw.flatten()
    else:
        raw[:fade_samples] *= envelope
    raw = raw.astype(audio_data.array_type)
    from pydub import AudioSegment
    new_audio = AudioSegment(
        raw.tobytes(), frame_rate=sample_rate,
        sample_width=audio_data.sample_width, channels=channels,
    )
    audio_data._data = new_audio._data


def apply_fade_out(audio_data, fade_duration: float, fade_type: FadeType):
    """在音频数据上应用淡出效果（直接修改原始数据）"""
    if fade_duration <= 0 or audio_data is None:
        return
    sample_rate = audio_data.frame_rate
    channels = audio_data.channels
    fade_samples = int(fade_duration * sample_rate)
    total_samples = len(audio_data.get_array_of_samples()) // channels
    if fade_samples >= total_samples:
        fade_samples = total_samples
    if fade_samples <= 0:
        return
    envelope = generate_fade_envelope(fade_type, fade_samples)[::-1]
    raw = np.array(audio_data.get_array_of_samples(), dtype=np.float64)
    if channels > 1:
        raw = raw.reshape(-1, channels)
        start_idx = total_samples - fade_samples
        for ch in range(channels):
            raw[start_idx:, ch] *= envelope
        raw = raw.flatten()
    else:
        start_idx = total_samples - fade_samples
        raw[start_idx:] *= envelope
    raw = raw.astype(audio_data.array_type)
    from pydub import AudioSegment
    new_audio = AudioSegment(
        raw.tobytes(), frame_rate=sample_rate,
        sample_width=audio_data.sample_width, channels=channels,
    )
    audio_data._data = new_audio._data


# ═══════════════════════════════════════════════════════
# 淡入淡出控制柄（QGraphicsItem）
# ═══════════════════════════════════════════════════════

class FadeHandle(QGraphicsRectItem):
    """
    淡入/淡出控制柄。

    可在音频块上方拖拽，调整淡入/淡出时长。
    拖拽时绘制半透明三角形覆盖显示淡入/淡出区域。
    
    使用回调函数而非 pyqtSignal（因为 QGraphicsRectItem 不是 QObject）。
    """

    HANDLE_SIZE = 10

    def __init__(self, item: AudioItem, is_fade_in: bool, parent=None):
        super().__init__(parent)
        self.audio_item = item
        self.is_fade_in = is_fade_in
        self._dragging = False
        self._start_pos = QPointF()
        self.on_fade_changed: Optional[Callable] = None

        self.setRect(0, 0, self.HANDLE_SIZE, self.HANDLE_SIZE)
        self.setBrush(QBrush(QColor(200, 200, 200, 200)))
        self.setPen(QPen(QColor(120, 120, 120), 1))
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges, True)
        self.setCursor(Qt.CursorShape.SizeHorCursor)
        self.setZValue(100)

        self._overlay = QGraphicsRectItem(parent)
        self._overlay.setBrush(QBrush(QColor(255, 255, 255, 60)))
        self._overlay.setPen(QPen(Qt.PenStyle.NoPen))
        self._overlay.setZValue(50)
        self._overlay.setVisible(False)

        self._update_position()

    def _update_position(self):
        parent = self.parentItem()
        if parent is None:
            return
        rect = parent.boundingRect()
        px_per_sec = rect.width() / max(self.audio_item.duration, 0.001)
        if self.is_fade_in:
            fade_px = self.audio_item.fade_in_duration * px_per_sec
            self.setPos(fade_px - self.HANDLE_SIZE / 2, 0)
            self._overlay.setRect(0, 0, fade_px, rect.height())
        else:
            fade_px = self.audio_item.fade_out_duration * px_per_sec
            self.setPos(rect.width() - fade_px - self.HANDLE_SIZE / 2, 0)
            self._overlay.setRect(rect.width() - fade_px, 0, fade_px, rect.height())

    def itemChange(self, change, value):
        if change == QGraphicsItem.GraphicsItemChange.ItemPositionChange and self._dragging:
            new_x = value.x()
            new_y = self._start_pos.y()
            value = QPointF(new_x, new_y)
            parent = self.parentItem()
            if parent:
                rect = parent.boundingRect()
                px_per_sec = rect.width() / max(self.audio_item.duration, 0.001)
                if self.is_fade_in:
                    max_x = rect.width() - self.audio_item.fade_out_duration * px_per_sec
                    new_x = max(0, min(new_x, max_x - self.HANDLE_SIZE / 2))
                    fade_duration = (new_x + self.HANDLE_SIZE / 2) / px_per_sec
                else:
                    min_x = self.audio_item.fade_in_duration * px_per_sec
                    new_x = max(min_x, min(new_x, rect.width() - self.HANDLE_SIZE / 2))
                    fade_duration = (rect.width() - new_x - self.HANDLE_SIZE / 2) / px_per_sec
                value = QPointF(new_x, new_y)
                if self.is_fade_in:
                    self.audio_item.fade_in_duration = max(0, fade_duration)
                else:
                    self.audio_item.fade_out_duration = max(0, fade_duration)
                self._update_position()
        return super().itemChange(change, value)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._dragging = True
            self._start_pos = self.pos()
            self._overlay.setVisible(True)
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event):
        if self._dragging:
            self._dragging = False
            duration = (self.audio_item.fade_in_duration
                        if self.is_fade_in else self.audio_item.fade_out_duration)
            if self.on_fade_changed:
                self.on_fade_changed(self.audio_item, duration, self.is_fade_in)
        super().mouseReleaseEvent(event)

    def contextMenuEvent(self, event):
        from PyQt6.QtWidgets import QMenu
        from PyQt6.QtGui import QAction
        menu = QMenu()
        current_type = (self.audio_item.fade_in_type
                        if self.is_fade_in else self.audio_item.fade_out_type)
        for ft in FadeType:
            action = QAction(ft.value, menu)
            action.setCheckable(True)
            action.setChecked(ft == current_type)
            action.triggered.connect(lambda checked, f=ft: self._set_fade_type(f))
            menu.addAction(action)
        menu.exec(event.screenPos())

    def _set_fade_type(self, fade_type: FadeType):
        if self.is_fade_in:
            self.audio_item.fade_in_type = fade_type
        else:
            self.audio_item.fade_out_type = fade_type
        duration = (self.audio_item.fade_in_duration
                    if self.is_fade_in else self.audio_item.fade_out_duration)
        if self.on_fade_changed:
            self.on_fade_changed(self.audio_item, duration, self.is_fade_in)


# ═══════════════════════════════════════════════════════
# 音频块图形项（QGraphicsItem）
# ═══════════════════════════════════════════════════════

class AudioBlockItem(QGraphicsRectItem):
    """
    轨道上的音频块图形项。

    增强功能：
      - 水平拖拽（移动时间位置，支持吸附）
      - 边缘拖拽（非破坏性裁剪）
      - 垂直拖拽（移出轨道信号）
      - Ctrl+Click 多选，Shift+Click 范围选择
      - 右键菜单（分割/复制/删除/淡入淡出/归一化/反转相位）
    
    使用回调函数而非 pyqtSignal（因为 QGraphicsRectItem 不是 QObject）。
    回调函数由 TrackEditorWidget 在 add_audio_block 时设置。
    """

    EDGE_THRESHOLD = 6       # 边缘检测像素阈值
    MIN_WIDTH = 30
    WAVEFORM_SAMPLES = 200
    SNAP_THRESHOLD = 8       # 吸附像素阈值
    GRID_INTERVAL = 1.0      # 网格吸附间隔（秒）

    def __init__(self, audio_item: AudioItem, px_per_sec: float,
                 get_playhead_time: Optional[Callable] = None, parent=None):
        super().__init__(parent)
        self.audio_item = audio_item
        self.px_per_sec = px_per_sec
        self._get_playhead_time = get_playhead_time or (lambda: 0.0)

        # 回调函数（由 TrackEditorWidget 设置）
        self.on_block_moved: Optional[Callable] = None
        self.on_block_selected: Optional[Callable] = None
        self.on_block_trimmed: Optional[Callable] = None
        self.on_block_drag_to_track: Optional[Callable] = None
        self.on_split_requested: Optional[Callable] = None
        self.on_delete_requested: Optional[Callable] = None
        self.on_fade_changed: Optional[Callable] = None  # 淡入淡出变化回调

        # 拖拽状态
        self._drag_mode = EdgeType.NONE
        self._dragging = False
        self._drag_start_scene_pos = QPointF()
        self._drag_start_item_pos = QPointF()
        self._drag_start_time = 0.0
        self._drag_start_trim = 0.0
        self._drag_snap_line = None  # 吸附指示线
        self._snap_enabled_for_drag = True

        # 外观
        color = audio_item.track.color if audio_item.track else QColor(86, 156, 214)
        self.setBrush(QBrush(QColor(color.red(), color.green(), color.blue(), 160)))
        self.setPen(QPen(color.darker(150), 1))
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges, True)
        self.setAcceptHoverEvents(True)

        # 更新尺寸和位置
        self.update_geometry()

        # 淡入/淡出控制柄
        self._fade_in_handle = FadeHandle(audio_item, is_fade_in=True, parent=self)
        self._fade_out_handle = FadeHandle(audio_item, is_fade_in=False, parent=self)

        # 设置淡入淡出回调 -> 转发到 AudioBlockItem 的 on_fade_changed
        self._fade_in_handle.on_fade_changed = (
            lambda item, dur, is_in: self._handle_fade_changed(item, dur, is_in)
        )
        self._fade_out_handle.on_fade_changed = (
            lambda item, dur, is_in: self._handle_fade_changed(item, dur, is_in)
        )

    def _handle_fade_changed(self, item, duration, is_fade_in):
        """处理淡入淡出变化，更新几何并通知外部"""
        self.update_geometry()
        self._fade_in_handle._update_position()
        self._fade_out_handle._update_position()
        if self.on_fade_changed:
            self.on_fade_changed(item, duration, is_fade_in)

    # ── 几何更新 ──

    def update_geometry(self):
        """根据 px_per_sec 和音频块数据更新矩形尺寸和位置"""
        width = max(self.MIN_WIDTH, self.audio_item.duration * self.px_per_sec)
        height = 80
        self.setRect(0, 0, width, height)
        self.setPos(self.audio_item.start_time * self.px_per_sec, 0)

    def set_px_per_sec(self, px_per_sec: float):
        self.px_per_sec = px_per_sec
        self.update_geometry()
        self._fade_in_handle._update_position()
        self._fade_out_handle._update_position()

    def boundingRect(self) -> QRectF:
        return self.rect()

    # ── 绘制 ──

    def paint(self, painter: QPainter, option, widget=None):
        rect = self.rect()

        # 始终先绘制默认背景（brush）
        super().paint(painter, option, widget)

        # 选中高亮覆盖
        if self.isSelected():
            painter.save()
            highlight = QColor(255, 107, 107, 60)
            painter.setPen(QPen(QColor(255, 107, 107), 2))
            painter.setBrush(QBrush(highlight))
            painter.drawRect(rect)
            painter.restore()

        # 波形
        waveform = self.audio_item.get_waveform(self.WAVEFORM_SAMPLES)
        if len(waveform) > 0:
            painter.save()
            painter.setClipRect(rect)
            mid_y = rect.height() / 2
            bar_width = rect.width() / len(waveform)
            color = self.audio_item.track.color if self.audio_item.track else QColor(86, 156, 214)
            painter.setPen(QPen(color.darker(120), 1))
            for i, amp in enumerate(waveform):
                x = i * bar_width
                h = amp * mid_y * 0.9 * self.audio_item.gain
                if h > 0:
                    painter.drawLine(QPointF(x, mid_y - h), QPointF(x, mid_y + h))
            painter.restore()

        # 名称
        painter.setPen(QPen(QColor(255, 255, 255, 220)))
        font = QFont("Microsoft YaHei", 8)
        painter.setFont(font)
        name = self.audio_item.name or "音频块"
        painter.drawText(QRectF(4, 2, rect.width() - 8, 16), Qt.AlignmentFlag.AlignLeft, name)

        # 时长
        painter.setPen(QPen(QColor(255, 255, 255, 140)))
        font.setPointSize(7)
        painter.setFont(font)
        dur_text = f"{self.audio_item.duration:.1f}s"
        painter.drawText(QRectF(4, rect.height() - 14, rect.width() - 8, 12),
                         Qt.AlignmentFlag.AlignRight, dur_text)

        # 音频块静音标识
        if self.audio_item.muted:
            painter.fillRect(rect, QBrush(QColor(0, 0, 0, 100)))
            painter.setPen(QPen(QColor(255, 100, 100), 1, Qt.PenStyle.DashLine))
            painter.drawLine(QPointF(0, 0), QPointF(rect.width(), rect.height()))
            painter.drawLine(QPointF(0, rect.height()), QPointF(rect.width(), 0))

        # 淡入淡出覆盖
        if self.audio_item.fade_in_duration > 0:
            self._draw_fade_overlay(painter, rect, self.audio_item.fade_in_duration, is_fade_in=True)
        if self.audio_item.fade_out_duration > 0:
            self._draw_fade_overlay(painter, rect, self.audio_item.fade_out_duration, is_fade_in=False)

    def _draw_fade_overlay(self, painter: QPainter, rect: QRectF, duration: float, is_fade_in: bool):
        fade_px = duration * self.px_per_sec
        path = QPainterPath()
        if is_fade_in:
            path.moveTo(0, 0)
            path.lineTo(fade_px, rect.height())
            path.lineTo(0, rect.height())
            path.closeSubpath()
        else:
            path.moveTo(rect.width(), 0)
            path.lineTo(rect.width() - fade_px, rect.height())
            path.lineTo(rect.width(), rect.height())
            path.closeSubpath()
        painter.fillPath(path, QBrush(QColor(0, 0, 0, 80)))
        painter.setPen(QPen(QColor(255, 255, 255, 150), 1, Qt.PenStyle.DashLine))
        if is_fade_in:
            painter.drawLine(QPointF(0, 0), QPointF(fade_px, rect.height()))
        else:
            painter.drawLine(QPointF(rect.width(), 0), QPointF(rect.width() - fade_px, rect.height()))

    # ── 边缘检测 ──

    def _detect_edge(self, pos: QPointF) -> EdgeType:
        """检测鼠标在音频块上的位置区域"""
        rect = self.rect()
        if pos.x() < self.EDGE_THRESHOLD:
            return EdgeType.LEFT_EDGE
        if pos.x() > rect.width() - self.EDGE_THRESHOLD:
            return EdgeType.RIGHT_EDGE
        if pos.y() < -10 or pos.y() > rect.height() + 10:
            return EdgeType.TOP_EDGE
        return EdgeType.BODY

    # ── 吸附 ──

    def _snap_value(self, value: float, snap_enabled: bool = True,
                    other_blocks: list = None, playhead_time: float = None) -> float:
        """吸附到网格线、其他块边缘、播放指针"""
        if not snap_enabled:
            return value

        snapped = value
        min_dist = self.SNAP_THRESHOLD / self.px_per_sec

        # 网格吸附
        grid_snapped = round(value / self.GRID_INTERVAL) * self.GRID_INTERVAL
        if abs(grid_snapped - value) < min_dist:
            snapped = grid_snapped
            min_dist = abs(grid_snapped - value)

        # 播放指针吸附
        if playhead_time is not None:
            dist = abs(playhead_time - value)
            if dist < min_dist:
                snapped = playhead_time
                min_dist = dist

        # 其他块边缘吸附
        if other_blocks:
            for block in other_blocks:
                if block is self:
                    continue
                for edge in [block.audio_item.start_time, block.audio_item.end_time]:
                    dist = abs(edge - value)
                    if dist < min_dist:
                        snapped = edge
                        min_dist = dist

        return snapped

    # ── 事件处理 ──

    def hoverMoveEvent(self, event):
        """改变光标形状：边缘↔，主体🖐"""
        pos = event.pos()
        edge = self._detect_edge(pos)
        if edge == EdgeType.LEFT_EDGE or edge == EdgeType.RIGHT_EDGE:
            self.setCursor(Qt.CursorShape.SizeHorCursor)
        elif edge == EdgeType.TOP_EDGE:
            self.setCursor(Qt.CursorShape.SizeAllCursor)
        else:
            self.setCursor(Qt.CursorShape.SizeAllCursor)
        super().hoverMoveEvent(event)

    def mousePressEvent(self, event: QGraphicsSceneMouseEvent):
        if event.button() != Qt.MouseButton.LeftButton:
            super().mousePressEvent(event)
            return

        self._drag_mode = self._detect_edge(event.pos())
        self._dragging = True
        self._drag_start_scene_pos = event.scenePos()
        self._drag_start_item_pos = self.pos()
        self._drag_start_time = self.audio_item.start_time
        self._drag_start_trim = (self.audio_item._trim_start_sec
                                 if self._drag_mode == EdgeType.LEFT_EDGE
                                 else self.audio_item._trim_end_sec)

        # Ctrl+Click 切换选择（不取消其他选中）
        modifiers = event.modifiers()
        if modifiers & Qt.KeyboardModifier.ControlModifier:
            self.setSelected(not self.isSelected())
            event.accept()
            return

        # Shift+Click 范围选择
        if modifiers & Qt.KeyboardModifier.ShiftModifier and self.scene():
            self.setSelected(True)
            event.accept()
            return

        # 普通点击：选中当前，取消其他
        if not self.isSelected():
            if self.scene():
                for item in self.scene().selectedItems():
                    item.setSelected(False)
            self.setSelected(True)
            if self.on_block_selected:
                self.on_block_selected(self.audio_item)

        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QGraphicsSceneMouseEvent):
        if not self._dragging:
            super().mouseMoveEvent(event)
            return

        delta = event.scenePos() - self._drag_start_scene_pos
        dx = delta.x()
        dy = delta.y()

        if self._drag_mode == EdgeType.LEFT_EDGE:
            # 裁剪左边缘
            trim_delta = -dx / self.px_per_sec
            old_trim = self.audio_item._trim_start_sec
            max_trim = self.audio_item.original_duration - 0.001
            self.audio_item._trim_start_sec = max(0, min(
                self._drag_start_trim + trim_delta, max_trim
            ))
            self.audio_item._update_audio_data()
            self.update_geometry()
            self._fade_in_handle._update_position()

        elif self._drag_mode == EdgeType.RIGHT_EDGE:
            # 裁剪右边缘
            trim_delta = dx / self.px_per_sec
            old_trim = self.audio_item._trim_end_sec
            max_trim = self.audio_item.original_duration - 0.001
            self.audio_item._trim_end_sec = max(0, min(
                self._drag_start_trim + trim_delta, max_trim
            ))
            self.audio_item._update_audio_data()
            self.update_geometry()
            self._fade_out_handle._update_position()

        elif self._drag_mode == EdgeType.TOP_EDGE and abs(dy) > 20:
            # 垂直拖拽到其他轨道：计算全局Y坐标
            global_y = 0
            if self.scene() and self.scene().views():
                view = self.scene().views()[0]
                view_pos = view.mapFromScene(event.scenePos())
                global_pos = view.mapToGlobal(view_pos)
                global_y = global_pos.y()
            if self.on_block_drag_to_track:
                self.on_block_drag_to_track(self.audio_item, float(global_y))
            self._dragging = False

        else:
            # 水平拖拽
            new_x = self._drag_start_item_pos.x() + dx
            new_x = max(0, new_x)  # 不能小于 0

            # 吸附
            if hasattr(self, '_snap_enabled_for_drag') and self._snap_enabled_for_drag:
                playhead = self._get_playhead_time()
                other_blocks = []
                if self.scene():
                    other_blocks = [it for it in self.scene().items()
                                    if isinstance(it, AudioBlockItem) and it is not self]
                new_time = self._snap_value(
                    new_x / self.px_per_sec,
                    snap_enabled=True,
                    other_blocks=other_blocks,
                    playhead_time=playhead,
                )
                new_x = new_time * self.px_per_sec

            self.audio_item.start_time = max(0, new_x / self.px_per_sec)
            self.setPos(new_x, 0)

        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QGraphicsSceneMouseEvent):
        if not self._dragging:
            super().mouseReleaseEvent(event)
            return

        self._dragging = False

        if self._drag_mode == EdgeType.LEFT_EDGE or self._drag_mode == EdgeType.RIGHT_EDGE:
            if self.on_block_trimmed:
                self.on_block_trimmed(
                    self.audio_item,
                    self.audio_item._trim_start_sec,
                    self.audio_item._trim_end_sec,
                )
        elif self._drag_mode == EdgeType.BODY:
            if self.on_block_moved:
                self.on_block_moved(self.audio_item, self.audio_item.start_time)

        self._drag_mode = EdgeType.NONE
        super().mouseReleaseEvent(event)

    # ── 右键菜单 ──

    def contextMenuEvent(self, event):
        menu = QMenu()

        # 分割
        split_action = QAction("✂ 分割（在播放指针处）", menu)
        split_action.triggered.connect(self._on_split)
        menu.addAction(split_action)

        menu.addSeparator()

        # 复制
        copy_action = QAction("📋 复制", menu)
        copy_action.setShortcut("Ctrl+C")
        copy_action.triggered.connect(self._on_copy)
        menu.addAction(copy_action)

        # 粘贴（仅当剪贴板有内容）
        paste_action = QAction("📋 粘贴", menu)
        paste_action.setShortcut("Ctrl+V")
        paste_action.triggered.connect(self._on_paste)
        menu.addAction(paste_action)

        menu.addSeparator()

        # 删除
        delete_action = QAction("🗑 删除", menu)
        delete_action.setShortcut("Delete")
        delete_action.triggered.connect(self._on_delete)
        menu.addAction(delete_action)

        # 静音此块
        mute_action = QAction("🔇 静音此块" if not self.audio_item.muted else "🔊 取消静音", menu)
        mute_action.triggered.connect(self._on_toggle_mute)
        menu.addAction(mute_action)

        menu.addSeparator()

        # 效果子菜单
        effect_menu = menu.addMenu("🎛 效果")

        normalize_action = QAction("归一化音量", effect_menu)
        normalize_action.triggered.connect(self._on_normalize)
        effect_menu.addAction(normalize_action)

        invert_action = QAction("反转相位", effect_menu)
        invert_action.triggered.connect(self._on_invert_phase)
        effect_menu.addAction(invert_action)

        menu.addSeparator()

        # 淡入设置子菜单
        fade_in_menu = menu.addMenu("淡入设置")
        for ft in FadeType:
            action = QAction(ft.value, fade_in_menu)
            action.setCheckable(True)
            action.setChecked(ft == self.audio_item.fade_in_type)
            action.triggered.connect(lambda checked, f=ft: self._set_fade_in_type(f))
            fade_in_menu.addAction(action)

        # 淡出设置子菜单
        fade_out_menu = menu.addMenu("淡出设置")
        for ft in FadeType:
            action = QAction(ft.value, fade_out_menu)
            action.setCheckable(True)
            action.setChecked(ft == self.audio_item.fade_out_type)
            action.triggered.connect(lambda checked, f=ft: self._set_fade_out_type(f))
            fade_out_menu.addAction(action)

        menu.addSeparator()

        # 属性
        prop_action = QAction("📄 属性...", menu)
        prop_action.triggered.connect(self._on_properties)
        menu.addAction(prop_action)

        menu.exec(event.screenPos())

    def _on_split(self):
        playhead = self._get_playhead_time()
        if self.on_split_requested:
            self.on_split_requested(self.audio_item, playhead)

    def _on_copy(self):
        """复制音频块到剪贴板"""
        scene = self.scene()
        if scene and scene.views():
            view = scene.views()[0]
            # 将音频块信息存入全局剪贴板（通过父窗口）
            clip_data = {
                "audio_item": self.audio_item,
                "original": self.audio_item._original_audio,
                "trim_start": self.audio_item._trim_start_sec,
                "trim_end": self.audio_item._trim_end_sec,
                "fade_in_duration": self.audio_item.fade_in_duration,
                "fade_out_duration": self.audio_item.fade_out_duration,
                "fade_in_type": self.audio_item.fade_in_type,
                "fade_out_type": self.audio_item.fade_out_type,
                "gain": self.audio_item.gain,
                "name": self.audio_item.name,
            }
            view._clipboard_data = clip_data

    def _on_paste(self):
        """粘贴音频块"""
        scene = self.scene()
        if scene and scene.views():
            view = scene.views()[0]
            clip_data = getattr(view, '_clipboard_data', None)
            if clip_data and clip_data.get("audio_item"):
                from pydub import AudioSegment
                original = clip_data["original"]
                if original:
                    new_item = AudioItem(
                        audio_data=original[
                            int(clip_data["trim_start"] * 1000):
                            int((len(original) / 1000 - clip_data["trim_end"]) * 1000)
                        ],
                        _original_audio=original,
                        _trim_start_sec=0,
                        _trim_end_sec=0,
                        start_time=self.audio_item.start_time + 0.5,
                        fade_in_duration=clip_data["fade_in_duration"],
                        fade_out_duration=clip_data["fade_out_duration"],
                        fade_in_type=clip_data["fade_in_type"],
                        fade_out_type=clip_data["fade_out_type"],
                        gain=clip_data["gain"],
                        name=clip_data["name"] + " (副本)",
                    )
                    self._add_cloned_item(new_item)

    def _add_cloned_item(self, new_item: AudioItem):
        """将克隆的音频块添加到场景"""
        if hasattr(self, '_track_widget_ref') and self._track_widget_ref:
            self._track_widget_ref.add_audio_block(new_item)
        else:
            scene = self.scene()
            if scene and scene.views():
                view = scene.views()[0]
                if hasattr(view, 'track_widget') and view.track_widget:
                    view.track_widget.add_audio_block(new_item)

    def _on_delete(self):
        if self.on_delete_requested:
            self.on_delete_requested(self.audio_item)

    def _on_toggle_mute(self):
        self.audio_item.muted = not self.audio_item.muted
        self.update()

    def _on_normalize(self):
        """归一化音量：将峰值调整到 0dB"""
        if self.audio_item.audio_data is None:
            return
        try:
            from pydub.effects import normalize
            self.audio_item.audio_data = normalize(self.audio_item.audio_data)
            if self.audio_item._original_audio is not None:
                self.audio_item._original_audio = normalize(
                    self.audio_item._original_audio
                )
            self.update()
        except Exception:
            pass

    def _on_invert_phase(self):
        """反转相位"""
        if self.audio_item.audio_data is None:
            return
        raw = np.array(self.audio_item.audio_data.get_array_of_samples(), dtype=np.float64)
        raw = -raw
        from pydub import AudioSegment
        self.audio_item.audio_data = AudioSegment(
            raw.astype(self.audio_item.audio_data.array_type).tobytes(),
            frame_rate=self.audio_item.audio_data.frame_rate,
            sample_width=self.audio_item.audio_data.sample_width,
            channels=self.audio_item.audio_data.channels,
        )
        if self.audio_item._original_audio is not None:
            raw_orig = np.array(self.audio_item._original_audio.get_array_of_samples(), dtype=np.float64)
            raw_orig = -raw_orig
            self.audio_item._original_audio = AudioSegment(
                raw_orig.astype(self.audio_item._original_audio.array_type).tobytes(),
                frame_rate=self.audio_item._original_audio.frame_rate,
                sample_width=self.audio_item._original_audio.sample_width,
                channels=self.audio_item._original_audio.channels,
            )
        self.update()

    def _set_fade_in_type(self, fade_type: FadeType):
        self.audio_item.fade_in_type = fade_type
        self.update()

    def _set_fade_out_type(self, fade_type: FadeType):
        self.audio_item.fade_out_type = fade_type
        self.update()

    def _on_properties(self):
        """显示音频块属性对话框"""
        from PyQt6.QtWidgets import QDialog, QVBoxLayout, QHBoxLayout, QLabel, \
            QLineEdit, QDialogButtonBox, QFormLayout
        dialog = QDialog()
        dialog.setWindowTitle("音频块属性")
        dialog.setStyleSheet("""
            QDialog { background: #1a1a1a; color: #eee; }
            QLabel { color: #ccc; }
            QLineEdit { background: #2a2a2a; color: #eee; border: 1px solid #4a4a4a;
                       border-radius: 4px; padding: 4px 8px; }
            QPushButton { background: #ff6b6b; color: white; border: none;
                         border-radius: 4px; padding: 6px 16px; }
            QPushButton:hover { background: #ff5252; }
        """)
        layout = QFormLayout(dialog)

        name_edit = QLineEdit(self.audio_item.name)
        layout.addRow("名称:", name_edit)

        start_label = QLabel(f"{self.audio_item.start_time:.2f}s")
        layout.addRow("起始时间:", start_label)

        dur_label = QLabel(f"{self.audio_item.duration:.2f}s")
        layout.addRow("时长:", dur_label)

        trim_label = QLabel(
            f"裁剪: 开头 {self.audio_item._trim_start_sec:.2f}s, "
            f"结尾 {self.audio_item._trim_end_sec:.2f}s"
        )
        layout.addRow("裁剪:", trim_label)

        fade_label = QLabel(
            f"淡入 {self.audio_item.fade_in_duration:.2f}s ({self.audio_item.fade_in_type.value}), "
            f"淡出 {self.audio_item.fade_out_duration:.2f}s ({self.audio_item.fade_out_type.value})"
        )
        layout.addRow("淡入淡出:", fade_label)

        gain_label = QLabel(f"{self.audio_item.gain:.2f}")
        layout.addRow("增益:", gain_label)

        btns = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok |
            QDialogButtonBox.StandardButton.Cancel
        )
        btns.accepted.connect(lambda: self._on_properties_ok(dialog, name_edit.text()))
        btns.rejected.connect(dialog.reject)
        layout.addRow(btns)

        dialog.setLayout(layout)
        dialog.exec()

    def _on_properties_ok(self, dialog, new_name: str):
        if new_name.strip():
            self.audio_item.name = new_name.strip()
            self.update()
        dialog.accept()

    # ── 键盘事件 ──

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_Delete:
            self._on_delete()
        elif event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            if event.key() == Qt.Key.Key_C:
                self._on_copy()
            elif event.key() == Qt.Key.Key_V:
                self._on_paste()
        super().keyPressEvent(event)

    # ── 销毁 ──

    def _delete_self(self):
        if self.audio_item.track:
            self.audio_item.track.remove_item(self.audio_item)
        if self.scene():
            self.scene().removeItem(self)