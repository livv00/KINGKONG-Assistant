"""
多轨音频编辑器 - 导出对话框

支持：导出范围选择、格式/音质/采样率设置、保存路径浏览。
"""

import os
from typing import Optional, List

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QColor, QFont
from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QLineEdit, QPushButton,
    QComboBox, QCheckBox, QRadioButton, QButtonGroup, QFileDialog,
    QDialogButtonBox, QGroupBox, QFormLayout, QMessageBox, QSpacerItem,
    QSlider, QFrame,
)

from track_item import AudioTrack


class ExportDialog(QDialog):
    """
    导出对话框。

    用法:
        dialog = ExportDialog(tracks, duration, parent=self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            params = dialog.get_export_params()
    """

    # 音质选项
    BITRATES = {
        "MP3": ["128 kbps", "192 kbps", "256 kbps", "320 kbps"],
        "WAV": ["16-bit PCM", "24-bit PCM", "32-bit float"],
        "FLAC": ["0 (最小)", "5 (默认)", "8 (最大压缩)"],
        "OGG": ["64 kbps", "128 kbps", "192 kbps", "256 kbps"],
    }

    DEFAULT_BITRATES = {
        "MP3": "320 kbps",
        "WAV": "16-bit PCM",
        "FLAC": "5 (默认)",
        "OGG": "192 kbps",
    }

    SAMPLE_RATES = ["44100 Hz", "48000 Hz", "96000 Hz", "192000 Hz"]

    def __init__(self, tracks: List[AudioTrack], project_duration: float,
                 parent=None):
        super().__init__(parent)
        self.tracks = tracks
        self.project_duration = project_duration
        self._export_dir = os.path.expanduser("~/Music/导出")

        self.setWindowTitle("导出音频")
        self.setMinimumWidth(480)
        self.setStyleSheet("""
            QDialog { background: #1a1a1a; color: #fff; }
            QLabel { color: #ccc; font-size: 12px; }
            QGroupBox { color: #fff; border: 1px solid #333;
                        border-radius: 6px; margin-top: 12px;
                        font-size: 12px; font-weight: bold; }
            QGroupBox::title { subcontrol-origin: margin;
                              left: 10px; padding: 0 6px; }
            QLineEdit { background: #2a2a2a; color: #fff; border: 1px solid #4a4a4a;
                       border-radius: 4px; padding: 4px 8px; }
            QComboBox { background: #2a2a2a; color: #fff; border: 1px solid #4a4a4a;
                       border-radius: 4px; padding: 4px 8px; }
            QComboBox::drop-down { border: none; }
            QComboBox QAbstractItemView { background: #2a2a2a; color: #fff;
                                         selection-background-color: #ff6b6b; }
            QPushButton { background: #2a2a2a; color: #fff; border: none;
                         border-radius: 4px; padding: 6px 16px; }
            QPushButton:hover { background: #3a3a3a; }
            QPushButton#exportBtn { background: #ff6b6b; color: white;
                                   font-weight: bold; padding: 8px 24px; }
            QPushButton#exportBtn:hover { background: #ff5252; }
            QRadioButton { color: #ccc; font-size: 12px; }
            QCheckBox { color: #ccc; font-size: 12px; }
            QSlider::groove:horizontal { height: 4px; background: #444;
                                        border-radius: 2px; }
            QSlider::handle:horizontal { background: #ff6b6b; width: 14px;
                                        height: 14px; margin: -5px 0;
                                        border-radius: 7px; }
            QFrame#separator { background: #333; max-height: 1px; }
        """)

        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(12)
        layout.setContentsMargins(20, 16, 20, 16)

        # ── 导出范围 ──
        range_group = QGroupBox("导出范围")
        range_layout = QVBoxLayout(range_group)

        self._range_group = QButtonGroup(self)

        self._range_all = QRadioButton("全部项目（从开始到最后一个音频块）")
        self._range_all.setChecked(True)
        self._range_group.addButton(self._range_all, 0)
        range_layout.addWidget(self._range_all)

        self._range_loop = QRadioButton("循环选区")
        self._range_group.addButton(self._range_loop, 1)
        range_layout.addWidget(self._range_loop)

        self._range_custom = QRadioButton("自定义范围")
        self._range_group.addButton(self._range_custom, 2)
        range_layout.addWidget(self._range_custom)

        custom_row = QHBoxLayout()
        custom_row.addSpacing(20)
        self._range_start = QLineEdit("00:00")
        self._range_start.setFixedWidth(60)
        self._range_start.setAlignment(Qt.AlignmentFlag.AlignCenter)
        custom_row.addWidget(self._range_start)
        custom_row.addWidget(QLabel("至"))
        self._range_end = QLineEdit(self._format_time(self.project_duration))
        self._range_end.setFixedWidth(60)
        self._range_end.setAlignment(Qt.AlignmentFlag.AlignCenter)
        custom_row.addWidget(self._range_end)
        custom_row.addStretch()
        range_layout.addLayout(custom_row)

        layout.addWidget(range_group)

        # ── 文件设置 ──
        file_group = QGroupBox("文件设置")
        file_layout = QFormLayout(file_group)
        file_layout.setSpacing(8)

        # 文件名
        name_row = QHBoxLayout()
        self._file_name = QLineEdit("混音输出")
        self._file_name.setPlaceholderText("输入文件名")
        name_row.addWidget(self._file_name, 1)

        self._format_combo = QComboBox()
        self._format_combo.addItems(["MP3", "WAV", "FLAC", "OGG"])
        self._format_combo.currentTextChanged.connect(self._on_format_changed)
        name_row.addWidget(self._format_combo)
        file_layout.addRow("文件名:", name_row)

        # 音质
        self._quality_combo = QComboBox()
        self._update_quality_options("MP3")
        file_layout.addRow("音质:", self._quality_combo)

        # 采样率
        self._sample_rate_combo = QComboBox()
        self._sample_rate_combo.addItems(self.SAMPLE_RATES)
        self._sample_rate_combo.setCurrentText("44100 Hz")
        file_layout.addRow("采样率:", self._sample_rate_combo)

        # 保存路径
        path_row = QHBoxLayout()
        self._save_path = QLineEdit(self._export_dir)
        path_row.addWidget(self._save_path, 1)
        browse_btn = QPushButton("浏览...")
        browse_btn.clicked.connect(self._on_browse)
        path_row.addWidget(browse_btn)
        file_layout.addRow("保存路径:", path_row)

        layout.addWidget(file_group)

        # ── 导出选项 ──
        opt_group = QGroupBox("导出选项")
        opt_layout = QVBoxLayout(opt_group)

        self._auto_play = QCheckBox("导出后自动播放")
        self._auto_play.setChecked(True)
        opt_layout.addWidget(self._auto_play)

        self._add_to_library = QCheckBox("添加到本地音乐库")
        self._add_to_library.setChecked(True)
        opt_layout.addWidget(self._add_to_library)

        self._export_stems = QCheckBox("导出分轨（每个轨道单独文件）")
        opt_layout.addWidget(self._export_stems)

        self._include_empty = QCheckBox("包含空白轨道")
        opt_layout.addWidget(self._include_empty)

        layout.addWidget(opt_group)

        # ── 分隔线 ──
        sep = QFrame()
        sep.setObjectName("separator")
        sep.setFrameShape(QFrame.Shape.HLine)
        layout.addWidget(sep)

        # ── 按钮 ──
        btn_row = QHBoxLayout()
        btn_row.addStretch()

        self._cancel_btn = QPushButton("取消")
        self._cancel_btn.clicked.connect(self.reject)
        btn_row.addWidget(self._cancel_btn)

        self._export_btn = QPushButton("导出")
        self._export_btn.setObjectName("exportBtn")
        self._export_btn.clicked.connect(self._on_export_clicked)
        btn_row.addWidget(self._export_btn)

        layout.addLayout(btn_row)

    def _on_format_changed(self, fmt: str):
        """格式改变时更新音质选项"""
        self._update_quality_options(fmt)

    def _update_quality_options(self, fmt: str):
        self._quality_combo.clear()
        options = self.BITRATES.get(fmt, ["320 kbps"])
        self._quality_combo.addItems(options)
        default = self.DEFAULT_BITRATES.get(fmt, options[0])
        if default in options:
            self._quality_combo.setCurrentText(default)

    def _on_browse(self):
        """浏览保存目录"""
        directory = QFileDialog.getExistingDirectory(
            self, "选择保存目录", self._save_path.text()
        )
        if directory:
            self._save_path.setText(directory)

    def _on_export_clicked(self):
        """验证参数并接受对话框"""
        dir_path = self._save_path.text().strip()
        if not dir_path or not os.path.isdir(dir_path):
            QMessageBox.warning(self, "提示", "请选择有效的保存路径")
            return

        name = self._file_name.text().strip()
        if not name:
            QMessageBox.warning(self, "提示", "请输入文件名")
            return

        # 验证自定义范围格式
        if self._range_custom.isChecked():
            try:
                start = self._parse_time(self._range_start.text())
                end = self._parse_time(self._range_end.text())
                if end <= start:
                    raise ValueError("结束时间必须大于开始时间")
            except ValueError as e:
                QMessageBox.warning(self, "提示", f"时间格式错误: {e}")
                return

        self.accept()

    def get_export_params(self) -> dict:
        """
        获取导出参数。

        Returns:
            dict: {
                "file_path": str,          # 完整导出路径
                "file_name": str,          # 文件名
                "format": str,             # mp3/wav/flac/ogg
                "quality": str,            # 音质字符串
                "sample_rate": int,        # 采样率
                "start_time": float,       # 起始时间（秒）
                "end_time": float,         # 结束时间
                "auto_play": bool,
                "add_to_library": bool,
                "export_stems": bool,
                "include_empty": bool,
            }
        """
        fmt = self._format_combo.currentText().lower()
        name = self._file_name.text().strip()
        dir_path = self._save_path.text().strip()
        ext = {"mp3": ".mp3", "wav": ".wav", "flac": ".flac", "ogg": ".ogg"}
        file_path = os.path.join(dir_path, name + ext.get(fmt, ".wav"))

        if self._range_all.isChecked():
            start_time = 0.0
            end_time = self.project_duration
        elif self._range_loop.isChecked():
            start_time = 0.0
            end_time = self.project_duration
        else:
            start_time = self._parse_time(self._range_start.text())
            end_time = self._parse_time(self._range_end.text())

        sr_text = self._sample_rate_combo.currentText()
        sample_rate = int(sr_text.replace(" Hz", ""))

        return {
            "file_path": file_path,
            "file_name": name,
            "format": fmt,
            "quality": self._quality_combo.currentText(),
            "sample_rate": sample_rate,
            "start_time": start_time,
            "end_time": end_time,
            "duration": end_time - start_time,
            "auto_play": self._auto_play.isChecked(),
            "add_to_library": self._add_to_library.isChecked(),
            "export_stems": self._export_stems.isChecked(),
            "include_empty": self._include_empty.isChecked(),
        }

    @staticmethod
    def _parse_time(text: str) -> float:
        """解析时间字符串（mm:ss 或 mm:ss.x）为秒数"""
        text = text.strip()
        parts = text.split(":")
        if len(parts) == 2:
            minutes = int(parts[0])
            sec_parts = parts[1].split(".")
            seconds = int(sec_parts[0])
            millis = int(sec_parts[1]) if len(sec_parts) > 1 else 0
            return minutes * 60 + seconds + millis / 10.0
        return float(text)

    @staticmethod
    def _format_time(sec: float) -> str:
        if sec < 0:
            sec = 0
        m = int(sec // 60)
        s = int(sec % 60)
        return f"{m:02d}:{s:02d}"