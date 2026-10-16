"""
多轨音频编辑器 - 混音面板

浮动混音台窗口，包含：
  - 每个轨道的音量推子（垂直滑块）
  - 声像旋钮/滑块
  - M/S 按钮
  - 主输出推子
  - 实时同步轨道数据
"""

from typing import List, Optional, Callable

from PyQt6.QtCore import Qt, pyqtSignal, QTimer
from PyQt6.QtGui import QColor, QFont, QPainter, QPen, QBrush
from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QSlider,
    QWidget, QScrollArea, QFrame, QSizePolicy, QGridLayout,
)

from track_item import AudioTrack


# ═══════════════════════════════════════════════════════
# 单个轨道通道条
# ═══════════════════════════════════════════════════════

class MixerChannel(QFrame):
    """
    混音台单个轨道通道条。

    包含：垂直推子、声像旋钮、M/S 按钮、轨道名称。
    """

    muteToggled = pyqtSignal(int, bool)     # (track_index, muted)
    soloToggled = pyqtSignal(int, bool)     # (track_index, solo)
    volumeChanged = pyqtSignal(int, float)  # (track_index, volume)
    panChanged = pyqtSignal(int, float)     # (track_index, pan)

    CHANNEL_WIDTH = 80
    FADER_HEIGHT = 200

    def __init__(self, track: AudioTrack, parent=None):
        super().__init__(parent)
        self.track = track
        self.setFixedWidth(self.CHANNEL_WIDTH)
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self._update_style()

        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 6, 4, 6)
        layout.setSpacing(4)
        layout.setAlignment(Qt.AlignmentFlag.AlignCenter)

        # 轨道名称
        self._name_label = QLabel(track.name)
        self._name_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._name_label.setStyleSheet(
            "color: #ddd; font-size: 10px; font-weight: bold;"
            " padding: 2px 0;"
        )
        layout.addWidget(self._name_label)

        # 音量推子（垂直）
        fader_container = QWidget()
        fader_container.setFixedHeight(self.FADER_HEIGHT)
        fader_layout = QVBoxLayout(fader_container)
        fader_layout.setContentsMargins(0, 0, 0, 0)
        fader_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)

        # 顶部电平指示
        self._level_label = QLabel("0")
        self._level_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._level_label.setStyleSheet("color: #888; font-size: 8px;")
        fader_layout.addWidget(self._level_label)

        # 垂直滑块
        self._fader = QSlider(Qt.Orientation.Vertical)
        self._fader.setRange(0, 200)
        self._fader.setValue(int(track.volume * 100))
        self._fader.setFixedHeight(self.FADER_HEIGHT - 40)
        self._fader.setTickPosition(QSlider.TickPosition.TicksRight)
        self._fader.setTickInterval(50)
        self._fader.valueChanged.connect(self._on_fader_changed)
        self._fader.setStyleSheet("""
            QSlider::groove:vertical { width: 6px; background: #444;
                                       border-radius: 3px; }
            QSlider::handle:vertical { background: #ff6b6b; width: 16px;
                                       height: 20px; margin: 0 -5px;
                                       border-radius: 4px; }
            QSlider::sub-page:vertical { background: #ff6b6b;
                                         border-radius: 3px; }
            QSlider::add-page:vertical { background: #444;
                                         border-radius: 3px; }
        """)
        fader_layout.addWidget(self._fader, 0, Qt.AlignmentFlag.AlignCenter)

        # 底部音量百分比
        self._vol_label = QLabel(f"{int(track.volume * 100)}%")
        self._vol_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._vol_label.setStyleSheet("color: #ccc; font-size: 10px; font-weight: bold;")
        fader_layout.addWidget(self._vol_label)

        layout.addWidget(fader_container)

        # 声像滑块
        pan_row = QHBoxLayout()
        pan_row.setSpacing(2)
        pan_label = QLabel("PAN")
        pan_label.setStyleSheet("color: #888; font-size: 8px;")
        pan_row.addWidget(pan_label)

        self._pan_slider = QSlider(Qt.Orientation.Horizontal)
        self._pan_slider.setRange(-100, 100)
        self._pan_slider.setValue(int(track.pan * 100))
        self._pan_slider.valueChanged.connect(self._on_pan_changed)
        self._pan_slider.setFixedWidth(60)
        self._pan_slider.setStyleSheet("""
            QSlider::groove:horizontal { height: 4px; background: #444;
                                         border-radius: 2px; }
            QSlider::handle:horizontal { background: #ff6b6b; width: 10px;
                                         height: 10px; margin: -3px 0;
                                         border-radius: 5px; }
        """)
        pan_row.addWidget(self._pan_slider)

        self._pan_label = QLabel(self._pan_text(track.pan))
        self._pan_label.setFixedWidth(20)
        self._pan_label.setStyleSheet("color: #ccc; font-size: 8px;")
        pan_row.addWidget(self._pan_label)

        layout.addLayout(pan_row)

        # M/S 按钮
        btn_row = QHBoxLayout()
        btn_row.setSpacing(4)
        btn_row.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self._mute_btn = QPushButton("M")
        self._mute_btn.setFixedSize(28, 22)
        self._mute_btn.setCheckable(True)
        self._mute_btn.setChecked(track.muted)
        self._mute_btn.clicked.connect(self._on_mute)
        self._style_mute(track.muted)
        btn_row.addWidget(self._mute_btn)

        self._solo_btn = QPushButton("S")
        self._solo_btn.setFixedSize(28, 22)
        self._solo_btn.setCheckable(True)
        self._solo_btn.setChecked(track.solo)
        self._solo_btn.clicked.connect(self._on_solo)
        self._style_solo(track.solo)
        btn_row.addWidget(self._solo_btn)

        layout.addLayout(btn_row)

    def _update_style(self):
        """根据轨道颜色更新背景"""
        c = self.track.color
        self.setStyleSheet(
            f"MixerChannel {{ background: rgba({c.red()},{c.green()},{c.blue()},20);"
            f"  border: 1px solid rgba({c.red()},{c.green()},{c.blue()},80);"
            f"  border-radius: 4px; }}"
        )

    def _pan_text(self, pan: float) -> str:
        if abs(pan) < 0.01:
            return "C"
        return f"L{int(abs(pan)*100)}" if pan < 0 else f"R{int(pan*100)}"

    def _style_mute(self, active: bool):
        if active:
            self._mute_btn.setStyleSheet(
                "QPushButton { background: #ff3b30; color: white;"
                "  font-weight: bold; border-radius: 3px; }"
            )
        else:
            self._mute_btn.setStyleSheet(
                "QPushButton { background: #444; color: #ccc;"
                "  border-radius: 3px; }"
                "QPushButton:hover { background: #555; }"
            )

    def _style_solo(self, active: bool):
        if active:
            self._solo_btn.setStyleSheet(
                "QPushButton { background: #ffcc00; color: black;"
                "  font-weight: bold; border-radius: 3px; }"
            )
        else:
            self._solo_btn.setStyleSheet(
                "QPushButton { background: #444; color: #ccc;"
                "  border-radius: 3px; }"
                "QPushButton:hover { background: #555; }"
            )

    def _on_fader_changed(self, value: int):
        self.track.volume = value / 100.0
        self._vol_label.setText(f"{value}%")
        self.volumeChanged.emit(self.track.index, self.track.volume)

    def _on_pan_changed(self, value: int):
        self.track.pan = value / 100.0
        self._pan_label.setText(self._pan_text(self.track.pan))
        self.panChanged.emit(self.track.index, self.track.pan)

    def _on_mute(self):
        self.track.muted = self._mute_btn.isChecked()
        self._style_mute(self.track.muted)
        self.muteToggled.emit(self.track.index, self.track.muted)

    def _on_solo(self):
        self.track.solo = self._solo_btn.isChecked()
        self._style_solo(self.track.solo)
        self.soloToggled.emit(self.track.index, self.track.solo)

    def sync_from_track(self):
        """从轨道数据同步 UI"""
        self._fader.setValue(int(self.track.volume * 100))
        self._pan_slider.setValue(int(self.track.pan * 100))
        self._mute_btn.setChecked(self.track.muted)
        self._style_mute(self.track.muted)
        self._solo_btn.setChecked(self.track.solo)
        self._style_solo(self.track.solo)


# ═══════════════════════════════════════════════════════
# 混音面板（主窗口）
# ═══════════════════════════════════════════════════════

class MixerPanel(QDialog):
    """
    浮动混音台窗口。

    用法:
        panel = MixerPanel(tracks, parent=self)
        panel.show()
    """

    muteToggled = pyqtSignal(int, bool)
    soloToggled = pyqtSignal(int, bool)
    volumeChanged = pyqtSignal(int, float)
    panChanged = pyqtSignal(int, float)
    masterVolumeChanged = pyqtSignal(float)

    def __init__(self, tracks: List[AudioTrack], parent=None):
        super().__init__(parent)
        self.tracks = tracks
        self._channels: List[MixerChannel] = []
        self.master_volume = 1.0

        self.setWindowTitle("混音台")
        self.setMinimumWidth(500)
        self.setMinimumHeight(450)
        self.setStyleSheet("""
            QDialog { background: #1a1a1a; color: #fff; }
        """)

        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(8)

        # 标题
        title = QLabel("混音台")
        title.setStyleSheet(
            "color: #fff; font-size: 14px; font-weight: bold;"
            " padding: 4px 0; border-bottom: 1px solid #333;"
        )
        layout.addWidget(title)

        # 滚动区域（轨道通道条）
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setStyleSheet(
            "QScrollArea { border: none; background: #1a1a1a; }"
            "QScrollArea::viewport { background: #1a1a1a; }"
        )

        channel_container = QWidget()
        channel_container.setStyleSheet("background: #1a1a1a;")
        self._channel_layout = QHBoxLayout(channel_container)
        self._channel_layout.setContentsMargins(0, 0, 0, 0)
        self._channel_layout.setSpacing(4)
        self._channel_layout.setAlignment(Qt.AlignmentFlag.AlignLeft)

        self._rebuild_channels()

        scroll.setWidget(channel_container)
        layout.addWidget(scroll, 1)

        # 分隔线
        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.HLine)
        sep.setStyleSheet("background: #333; max-height: 1px;")
        layout.addWidget(sep)

        # 主输出
        master_row = QHBoxLayout()
        master_row.setSpacing(12)

        master_label = QLabel("主输出")
        master_label.setStyleSheet("color: #fff; font-size: 12px; font-weight: bold;")
        master_row.addWidget(master_label)

        self._master_fader = QSlider(Qt.Orientation.Horizontal)
        self._master_fader.setRange(0, 200)
        self._master_fader.setValue(100)
        self._master_fader.setFixedWidth(200)
        self._master_fader.valueChanged.connect(self._on_master_changed)
        self._master_fader.setStyleSheet("""
            QSlider::groove:horizontal { height: 6px; background: #444;
                                         border-radius: 3px; }
            QSlider::handle:horizontal { background: #ff6b6b; width: 16px;
                                         height: 16px; margin: -5px 0;
                                         border-radius: 8px; }
            QSlider::sub-page:horizontal { background: #ff6b6b;
                                           border-radius: 3px; }
        """)
        master_row.addWidget(self._master_fader)

        self._master_vol_label = QLabel("100%")
        self._master_vol_label.setFixedWidth(40)
        self._master_vol_label.setStyleSheet("color: #fff; font-size: 11px; font-weight: bold;")
        master_row.addWidget(self._master_vol_label)

        master_row.addStretch()

        # 锁定按钮
        self._lock_btn = QPushButton("锁定面板")
        self._lock_btn.setCheckable(True)
        self._lock_btn.setStyleSheet("""
            QPushButton { background: #444; color: #ccc; border: none;
                         border-radius: 4px; padding: 4px 12px; }
            QPushButton:checked { background: #ffcc00; color: black; }
            QPushButton:hover { background: #555; }
        """)
        master_row.addWidget(self._lock_btn)

        layout.addLayout(master_row)

    def _rebuild_channels(self):
        """重建所有通道条"""
        for ch in self._channels:
            self._channel_layout.removeWidget(ch)
            ch.deleteLater()
        self._channels.clear()

        for track in self.tracks:
            channel = MixerChannel(track)
            channel.muteToggled.connect(self.muteToggled.emit)
            channel.soloToggled.connect(self.soloToggled.emit)
            channel.volumeChanged.connect(self.volumeChanged.emit)
            channel.panChanged.connect(self.panChanged.emit)
            self._channel_layout.addWidget(channel)
            self._channels.append(channel)

    def _on_master_changed(self, value: int):
        self.master_volume = value / 100.0
        self._master_vol_label.setText(f"{value}%")
        self.masterVolumeChanged.emit(self.master_volume)

    def sync_all(self):
        """同步所有通道 UI 到轨道数据"""
        for ch in self._channels:
            ch.sync_from_track()

    def set_master_volume(self, volume: float):
        self.master_volume = max(0, min(2.0, volume))
        self._master_fader.setValue(int(self.master_volume * 100))
        self._master_vol_label.setText(f"{int(self.master_volume * 100)}%")

    def closeEvent(self, event):
        """关闭时隐藏而非销毁"""
        self.hide()
        event.ignore()