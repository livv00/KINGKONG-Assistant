"""
设置对话框

左侧分类导航，右侧显示对应配置页。
包含"洛雪音源"配置页，支持 API 地址测试连接。
"""

import os
import threading
from typing import Optional

from PyQt6.QtCore import Qt, pyqtSignal, QTimer
from PyQt6.QtGui import QFont, QColor, QIcon
from PyQt6.QtWidgets import (
    QDialog, QWidget, QHBoxLayout, QVBoxLayout,
    QListWidget, QListWidgetItem, QStackedWidget,
    QLabel, QLineEdit, QComboBox, QCheckBox,
    QPushButton, QSpinBox, QFileDialog, QFormLayout,
    QGroupBox, QFrame, QSizePolicy, QMessageBox,
    QScrollArea, QApplication,
)

from config import Config, get_config, SOURCE_MAP, SOURCE_NAMES, QUALITY_OPTIONS
from lxmusic_client import LxMusicClient, LxMusicError

import requests


# ──────────────────────────────────────────────
# 导航项
# ──────────────────────────────────────────────

NAV_ITEMS = [
    ("general", "⚙ 通用"),
    ("lxmusic", "🎵 洛雪音源"),
    ("audio", "🔊 音频"),
    ("remote", "🌐 远程控制"),
    ("about", "ℹ 关于"),
]


# ──────────────────────────────────────────────
# 洛雪音源配置页
# ──────────────────────────────────────────────

class LxMusicSettingsPage(QWidget):
    """洛雪音源配置页"""

    def __init__(self, config: Config, parent=None):
        super().__init__(parent)
        self._config = config
        self._setup_ui()
        self._load_config()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(24, 20, 24, 20)

        # ── 标题 ──
        title = QLabel("洛雪音源设置")
        title.setStyleSheet("font-size: 18px; font-weight: bold; color: #ffffff;")
        layout.addWidget(title)

        desc = QLabel("对接 lx-music-source 服务，提供全网音乐搜索和下载功能")
        desc.setStyleSheet("color: #888888; font-size: 12px; margin-bottom: 8px;")
        desc.setWordWrap(True)
        layout.addWidget(desc)

        # ── API 服务地址 ──
        api_group = QGroupBox("API 服务")
        api_group.setStyleSheet("""
            QGroupBox {
                color: #cccccc;
                font-size: 13px;
                font-weight: bold;
                border: 1px solid #444444;
                border-radius: 6px;
                margin-top: 10px;
                padding: 16px 12px 12px 12px;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                subcontrol-position: top left;
                padding: 0 6px;
                background-color: #1a1a1a;
            }
        """)
        api_layout = QVBoxLayout(api_group)
        api_layout.setSpacing(8)

        api_input_layout = QHBoxLayout()
        self._api_input = QLineEdit()
        self._api_input.setPlaceholderText("http://localhost:3100")
        self._api_input.setStyleSheet("""
            QLineEdit {
                background-color: #3a3a3a;
                color: #ffffff;
                border: 1px solid #555555;
                border-radius: 4px;
                padding: 8px 12px;
                font-size: 13px;
            }
            QLineEdit:focus {
                border-color: #2196F3;
            }
        """)
        api_input_layout.addWidget(self._api_input, 1)

        self._test_btn = QPushButton("测试连接")
        self._test_btn.setFixedWidth(100)
        self._test_btn.setStyleSheet("""
            QPushButton {
                background-color: #2196F3;
                color: white;
                border: none;
                border-radius: 4px;
                padding: 8px 16px;
                font-size: 13px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #1976D2;
            }
            QPushButton:pressed {
                background-color: #1565C0;
            }
            QPushButton:disabled {
                background-color: #555555;
                color: #888888;
            }
        """)
        self._test_btn.clicked.connect(self._on_test_connection)
        api_input_layout.addWidget(self._test_btn)
        api_layout.addLayout(api_input_layout)

        self._test_result = QLabel("")
        self._test_result.setStyleSheet("font-size: 12px;")
        self._test_result.setWordWrap(True)
        self._test_result.setVisible(False)
        api_layout.addWidget(self._test_result)

        layout.addWidget(api_group)

        # ── 搜索设置 ──
        search_group = QGroupBox("搜索设置")
        search_group.setStyleSheet(api_group.styleSheet())
        search_layout = QFormLayout(search_group)
        search_layout.setSpacing(10)
        search_layout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        # 默认搜索平台
        self._source_combo = QComboBox()
        self._source_combo.addItems(list(SOURCE_MAP.values()))
        self._source_combo.setStyleSheet("""
            QComboBox {
                background-color: #3a3a3a;
                color: #ffffff;
                border: 1px solid #555555;
                border-radius: 4px;
                padding: 6px 10px;
                font-size: 13px;
                min-width: 120px;
            }
            QComboBox::drop-down { border: none; width: 20px; }
            QComboBox::down-arrow {
                image: none;
                border-left: 5px solid transparent;
                border-right: 5px solid transparent;
                border-top: 5px solid #888888;
                margin-right: 4px;
            }
            QComboBox QAbstractItemView {
                background-color: #3a3a3a;
                color: #ffffff;
                selection-background-color: #2196F3;
                border: 1px solid #555555;
            }
        """)
        search_layout.addRow("默认搜索平台:", self._source_combo)

        layout.addWidget(search_group)

        # ── 下载设置 ──
        dl_group = QGroupBox("下载设置")
        dl_group.setStyleSheet(api_group.styleSheet())
        dl_layout = QFormLayout(dl_group)
        dl_layout.setSpacing(10)
        dl_layout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        # 默认下载音质
        self._quality_combo = QComboBox()
        quality_labels = {"128k": "标准 (128k)", "320k": "高品 (320k)", "flac": "无损 (FLAC)", "flac24bit": "Hi-Res (24bit)"}
        for q in QUALITY_OPTIONS:
            self._quality_combo.addItem(quality_labels.get(q, q), q)
        self._quality_combo.setStyleSheet(self._source_combo.styleSheet())
        dl_layout.addRow("默认下载音质:", self._quality_combo)

        # 下载保存路径
        path_layout = QHBoxLayout()
        self._path_input = QLineEdit()
        self._path_input.setStyleSheet("""
            QLineEdit {
                background-color: #3a3a3a;
                color: #ffffff;
                border: 1px solid #555555;
                border-radius: 4px;
                padding: 6px 10px;
                font-size: 13px;
            }
            QLineEdit:focus {
                border-color: #2196F3;
            }
        """)
        path_layout.addWidget(self._path_input, 1)

        self._browse_btn = QPushButton("浏览...")
        self._browse_btn.setFixedWidth(80)
        self._browse_btn.setStyleSheet("""
            QPushButton {
                background-color: #555555;
                color: #ffffff;
                border: none;
                border-radius: 4px;
                padding: 6px 12px;
                font-size: 13px;
            }
            QPushButton:hover {
                background-color: #666666;
            }
        """)
        self._browse_btn.clicked.connect(self._on_browse_path)
        path_layout.addWidget(self._browse_btn)
        dl_layout.addRow("下载保存路径:", path_layout)

        # 自动添加到本地库
        self._auto_add_check = QCheckBox("下载后自动添加到本地音乐库")
        self._auto_add_check.setStyleSheet("""
            QCheckBox {
                color: #cccccc;
                font-size: 13px;
                spacing: 6px;
            }
            QCheckBox::indicator {
                width: 16px;
                height: 16px;
                border: 1px solid #555555;
                border-radius: 3px;
                background-color: #3a3a3a;
            }
            QCheckBox::indicator:checked {
                background-color: #2196F3;
                border-color: #2196F3;
            }
        """)
        dl_layout.addRow("", self._auto_add_check)

        # 最大同时下载数
        self._concurrent_spin = QSpinBox()
        self._concurrent_spin.setRange(1, 10)
        self._concurrent_spin.setValue(3)
        self._concurrent_spin.setStyleSheet("""
            QSpinBox {
                background-color: #3a3a3a;
                color: #ffffff;
                border: 1px solid #555555;
                border-radius: 4px;
                padding: 6px 10px;
                font-size: 13px;
                min-width: 80px;
            }
            QSpinBox:focus {
                border-color: #2196F3;
            }
            QSpinBox::up-button, QSpinBox::down-button {
                border: none;
                width: 20px;
            }
            QSpinBox::up-arrow {
                image: none;
                border-left: 4px solid transparent;
                border-right: 4px solid transparent;
                border-bottom: 6px solid #888888;
                margin-bottom: 2px;
            }
            QSpinBox::down-arrow {
                image: none;
                border-left: 4px solid transparent;
                border-right: 4px solid transparent;
                border-top: 6px solid #888888;
                margin-top: 2px;
            }
        """)
        dl_layout.addRow("最大同时下载数:", self._concurrent_spin)

        layout.addWidget(dl_group)

        # 弹性空间
        layout.addStretch(1)

    # ── 加载 / 保存配置 ─────────────────────────

    def _load_config(self):
        """从配置加载值到 UI"""
        self._api_input.setText(self._config.get("lxmusic.api_base", "http://localhost:3100"))

        default_source = self._config.get("lxmusic.default_source", "kw")
        source_index = SOURCE_NAMES.index(default_source) if default_source in SOURCE_NAMES else 0
        self._source_combo.setCurrentIndex(source_index)

        default_quality = self._config.get("lxmusic.download_quality", "320k")
        quality_index = self._quality_combo.findData(default_quality)
        if quality_index >= 0:
            self._quality_combo.setCurrentIndex(quality_index)

        self._path_input.setText(self._config.get("lxmusic.download_path", ""))
        self._auto_add_check.setChecked(self._config.get("lxmusic.auto_add_to_library", True))
        self._concurrent_spin.setValue(self._config.get("lxmusic.max_concurrent_downloads", 3))

    def save_config(self):
        """将 UI 值保存到配置"""
        source_index = self._source_combo.currentIndex()
        source = SOURCE_NAMES[source_index] if 0 <= source_index < len(SOURCE_NAMES) else "kw"

        quality_index = self._quality_combo.currentIndex()
        quality = self._quality_combo.itemData(quality_index) or "320k"

        items = {
            "lxmusic.api_base": self._api_input.text().strip().rstrip("/"),
            "lxmusic.default_source": source,
            "lxmusic.download_quality": quality,
            "lxmusic.download_path": self._path_input.text().strip(),
            "lxmusic.auto_add_to_library": self._auto_add_check.isChecked(),
            "lxmusic.max_concurrent_downloads": self._concurrent_spin.value(),
        }
        self._config.set_batch(items)

    # ── 事件处理 ────────────────────────────────

    def _on_test_connection(self):
        """测试连接按钮"""
        api_base = self._api_input.text().strip().rstrip("/")
        if not api_base:
            self._show_test_result("请输入 API 服务地址", "red")
            return

        self._test_btn.setEnabled(False)
        self._test_btn.setText("测试中...")
        self._test_result.setVisible(False)

        def _test():
            try:
                client = LxMusicClient(api_base=api_base, timeout=5)
                # 先尝试搜索一首歌验证服务
                result = client.search("test", source="kw", page=1, limit=1)
                total = result.get("total", 0)
                QTimer.singleShot(0, lambda: self._show_test_result(
                    f"连接成功，已找到 {total} 个可用音源", "green"
                ))
            except Exception as e:
                QTimer.singleShot(0, lambda: self._show_test_result(
                    f"连接失败: {str(e)}", "red"
                ))
            finally:
                QTimer.singleShot(0, lambda: self._test_btn.setEnabled(True))
                QTimer.singleShot(0, lambda: self._test_btn.setText("测试连接"))

        thread = threading.Thread(target=_test, daemon=True)
        thread.start()

    def _show_test_result(self, message: str, color: str):
        self._test_result.setText(message)
        color_map = {"green": "#4CAF50", "red": "#f44336"}
        self._test_result.setStyleSheet(f"color: {color_map.get(color, '#888888')}; font-size: 12px;")
        self._test_result.setVisible(True)

    def _on_browse_path(self):
        """浏览文件夹"""
        current = self._path_input.text().strip() or os.path.expanduser("~")
        folder = QFileDialog.getExistingDirectory(self, "选择下载保存路径", current)
        if folder:
            self._path_input.setText(folder)


# ──────────────────────────────────────────────
# 设置对话框
# ──────────────────────────────────────────────

class SettingsDialog(QDialog):
    """
    设置对话框

    左侧导航列表，右侧堆叠页面。
    支持 "洛雪音源"、"通用"、"音频"、"远程控制"、"关于" 等页面。
    """

    settings_changed = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._config = get_config()
        self.setWindowTitle("设置")
        self.setMinimumSize(720, 520)
        self.setStyleSheet("""
            QDialog {
                background-color: #1a1a1a;
                color: #ffffff;
            }
        """)

        self._setup_ui()
        self._load_settings()

    def _setup_ui(self):
        main_layout = QHBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)

        # ── 左侧导航 ──
        self._nav_list = QListWidget()
        self._nav_list.setFixedWidth(180)
        self._nav_list.setStyleSheet("""
            QListWidget {
                background-color: #222222;
                border: none;
                border-right: 1px solid #3a3a3a;
                outline: none;
            }
            QListWidget::item {
                padding: 12px 16px;
                color: #aaaaaa;
                font-size: 13px;
                border: none;
            }
            QListWidget::item:selected {
                background-color: #333333;
                color: #2196F3;
                border-left: 3px solid #2196F3;
            }
            QListWidget::item:hover {
                background-color: #2a2a2a;
                color: #cccccc;
            }
        """)
        self._nav_list.itemClicked.connect(self._on_nav_clicked)
        main_layout.addWidget(self._nav_list)

        # ── 右侧页面 ──
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet("QScrollArea { background-color: #1a1a1a; border: none; }")

        self._stack = QStackedWidget()
        self._stack.setStyleSheet("background-color: #1a1a1a;")
        scroll.setWidget(self._stack)
        main_layout.addWidget(scroll, 1)

        # ── 页面 ──
        self._pages = {}
        self._lxmusic_page = None

        for nav_id, nav_label in NAV_ITEMS:
            item = QListWidgetItem(nav_label)
            item.setData(Qt.ItemDataRole.UserRole, nav_id)
            self._nav_list.addItem(item)

            if nav_id == "lxmusic":
                page = LxMusicSettingsPage(self._config)
                self._lxmusic_page = page
                self._pages[nav_id] = page
                self._stack.addWidget(page)
            elif nav_id == "general":
                page = self._create_general_page()
                self._pages[nav_id] = page
                self._stack.addWidget(page)
            elif nav_id == "audio":
                page = self._create_audio_page()
                self._pages[nav_id] = page
                self._stack.addWidget(page)
            elif nav_id == "remote":
                page = self._create_remote_page()
                self._pages[nav_id] = page
                self._stack.addWidget(page)
            elif nav_id == "about":
                page = self._create_about_page()
                self._pages[nav_id] = page
                self._stack.addWidget(page)

        # 默认选中第一个
        self._nav_list.setCurrentRow(0)
        self._stack.setCurrentIndex(0)

        # ── 底部按钮栏 ──
        btn_layout = QHBoxLayout()
        btn_layout.setContentsMargins(12, 8, 12, 8)
        btn_layout.addStretch(1)

        self._save_btn = QPushButton("保存设置")
        self._save_btn.setStyleSheet("""
            QPushButton {
                background-color: #2196F3;
                color: white;
                border: none;
                border-radius: 4px;
                padding: 8px 24px;
                font-size: 13px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #1976D2;
            }
        """)
        self._save_btn.clicked.connect(self._on_save)
        btn_layout.addWidget(self._save_btn)

        self._cancel_btn = QPushButton("取消")
        self._cancel_btn.setStyleSheet("""
            QPushButton {
                background-color: #555555;
                color: #ffffff;
                border: none;
                border-radius: 4px;
                padding: 8px 24px;
                font-size: 13px;
            }
            QPushButton:hover {
                background-color: #666666;
            }
        """)
        self._cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(self._cancel_btn)

        # 将按钮栏放在底部
        outer_layout = QVBoxLayout()
        outer_layout.setContentsMargins(0, 0, 0, 0)
        outer_layout.setSpacing(0)
        outer_layout.addWidget(scroll, 1)
        outer_layout.addLayout(btn_layout)
        main_layout.addLayout(outer_layout)

    # ── 其他页面 ────────────────────────────────

    def _create_general_page(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(24, 20, 24, 20)

        title = QLabel("通用设置")
        title.setStyleSheet("font-size: 18px; font-weight: bold; color: #ffffff;")
        layout.addWidget(title)
        layout.addStretch(1)
        return page

    def _create_audio_page(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(24, 20, 24, 20)

        title = QLabel("音频设置")
        title.setStyleSheet("font-size: 18px; font-weight: bold; color: #ffffff;")
        layout.addWidget(title)
        layout.addStretch(1)
        return page

    def _create_remote_page(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(24, 20, 24, 20)

        title = QLabel("远程控制设置")
        title.setStyleSheet("font-size: 18px; font-weight: bold; color: #ffffff;")
        layout.addWidget(title)
        layout.addStretch(1)
        return page

    def _create_about_page(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(24, 20, 24, 20)

        title = QLabel("关于")
        title.setStyleSheet("font-size: 18px; font-weight: bold; color: #ffffff;")
        layout.addWidget(title)

        info = QLabel("直播助手 v1.0.0\n\n基于 Electron 的音乐播放与控制工具")
        info.setStyleSheet("color: #aaaaaa; font-size: 13px; line-height: 1.8;")
        info.setWordWrap(True)
        layout.addWidget(info)
        layout.addStretch(1)
        return page

    # ── 事件 ────────────────────────────────────

    def _on_nav_clicked(self, item: QListWidgetItem):
        nav_id = item.data(Qt.ItemDataRole.UserRole)
        page = self._pages.get(nav_id)
        if page:
            index = self._stack.indexOf(page)
            self._stack.setCurrentIndex(index)

    def _on_save(self):
        """保存所有页面配置"""
        if self._lxmusic_page:
            self._lxmusic_page.save_config()
        self._config.save_if_dirty()
        self.settings_changed.emit()
        self.accept()

    def _load_settings(self):
        """加载配置到各页面"""
        pass  # 各页面在 __init__ 中自行加载

    # ── 静态方法 ────────────────────────────────

    @staticmethod
    def open_settings(parent=None) -> bool:
        """
        打开设置对话框

        Returns:
            True 如果用户点击了保存，False 如果取消
        """
        dialog = SettingsDialog(parent)
        result = dialog.exec()
        return result == QDialog.DialogCode.Accepted