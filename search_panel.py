"""
搜索面板组件

改造 QLineEdit 搜索框，支持本地和在线两种模式。
在线模式集成洛雪音乐搜索 API，带 500ms 防抖、平台选择、加载动画。
"""

import re
from enum import Enum
from typing import Optional, Callable

from PyQt6.QtCore import Qt, QTimer, pyqtSignal
from PyQt6.QtGui import QFont, QColor, QPalette, QIcon, QPixmap, QPainter
from PyQt6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QLineEdit, QComboBox,
    QLabel, QPushButton, QFrame, QSizePolicy, QSpacerItem,
)

from config import Config, get_config, SOURCE_MAP, SOURCE_NAMES
from lxmusic_client import LxMusicClient, LxMusicError


# ──────────────────────────────────────────────
# 搜索模式
# ──────────────────────────────────────────────

class SearchMode(Enum):
    LOCAL = "本地音乐"
    ONLINE = "在线搜索"


# ──────────────────────────────────────────────
# 加载动画标签
# ──────────────────────────────────────────────

class LoadingLabel(QLabel):
    """旋转加载动画"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._angle = 0
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._rotate)
        self.setFixedSize(20, 20)
        self.setVisible(False)

    def start(self):
        self._angle = 0
        self.setVisible(True)
        self._timer.start(80)

    def stop(self):
        self._timer.stop()
        self.setVisible(False)
        self.update()

    def _rotate(self):
        self._angle = (self._angle + 30) % 360
        self.update()

    def paintEvent(self, event):
        if not self.isVisible():
            return
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.translate(10, 10)
        painter.rotate(self._angle)

        pen = painter.pen()
        pen.setWidth(3)
        pen.setColor(QColor("#2196F3"))
        painter.setPen(pen)
        painter.drawArc(-8, -8, 16, 16, 0, 270 * 16)


# ──────────────────────────────────────────────
# 搜索面板
# ──────────────────────────────────────────────

class SearchPanel(QWidget):
    """
    搜索面板组件

    包含模式选择、搜索框、平台选择，提供防抖自动搜索和回车搜索。

    信号:
        search_mode_changed(mode: SearchMode)          # 搜索模式切换
        local_search_requested(keyword: str)            # 本地搜索请求
        online_search_requested(keyword: str, source: str)  # 在线搜索请求
        search_cleared()                                # 搜索清空
    """

    search_mode_changed = pyqtSignal(object)             # SearchMode
    local_search_requested = pyqtSignal(str)             # keyword
    online_search_requested = pyqtSignal(str, str)       # keyword, source
    search_cleared = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._config = get_config()
        self._debounce_timer = QTimer(self)
        self._debounce_timer.setSingleShot(True)
        self._debounce_timer.timeout.connect(self._on_debounce_timeout)

        self._mode = SearchMode.LOCAL
        self._is_searching = False

        self._setup_ui()
        self._connect_signals()

    # ── UI 构建 ─────────────────────────────────

    def _setup_ui(self):
        self.setStyleSheet("""
            SearchPanel {
                background-color: #2a2a2a;
                border-bottom: 1px solid #3a3a3a;
            }
        """)

        main_layout = QHBoxLayout(self)
        main_layout.setContentsMargins(8, 6, 8, 6)
        main_layout.setSpacing(6)

        # ── 模式选择 ──
        self._mode_combo = QComboBox()
        self._mode_combo.addItems([m.value for m in SearchMode])
        self._mode_combo.setFixedWidth(100)
        self._mode_combo.setStyleSheet("""
            QComboBox {
                background-color: #3a3a3a;
                color: #ffffff;
                border: 1px solid #555555;
                border-radius: 4px;
                padding: 6px 10px;
                font-size: 13px;
            }
            QComboBox:hover {
                border-color: #2196F3;
            }
            QComboBox::drop-down {
                border: none;
                width: 20px;
            }
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
        main_layout.addWidget(self._mode_combo)

        # ── 搜索框 ──
        self._search_input = QLineEdit()
        self._search_input.setPlaceholderText("搜索本地音乐...")
        self._search_input.setStyleSheet("""
            QLineEdit {
                background-color: #3a3a3a;
                color: #ffffff;
                border: 1px solid #555555;
                border-radius: 4px;
                padding: 6px 12px;
                font-size: 13px;
            }
            QLineEdit:focus {
                border-color: #2196F3;
            }
            QLineEdit:disabled {
                background-color: #333333;
                color: #666666;
            }
        """)
        self._search_input.setMinimumWidth(200)
        main_layout.addWidget(self._search_input, 1)

        # ── 加载动画（默认隐藏） ──
        self._loading_label = LoadingLabel()
        main_layout.addWidget(self._loading_label)

        # ── 平台选择（默认隐藏） ──
        self._source_combo = QComboBox()
        self._source_combo.addItems(list(SOURCE_MAP.values()))
        # 设置默认平台
        default_source = self._config.get("lxmusic.default_source", "kw")
        default_index = SOURCE_NAMES.index(default_source) if default_source in SOURCE_NAMES else 0
        self._source_combo.setCurrentIndex(default_index)
        self._source_combo.setFixedWidth(80)
        self._source_combo.setStyleSheet("""
            QComboBox {
                background-color: #3a3a3a;
                color: #ffffff;
                border: 1px solid #555555;
                border-radius: 4px;
                padding: 6px 10px;
                font-size: 13px;
            }
            QComboBox:hover {
                border-color: #2196F3;
            }
            QComboBox::drop-down {
                border: none;
                width: 20px;
            }
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
        self._source_combo.setVisible(False)
        main_layout.addWidget(self._source_combo)

        # 清空按钮
        self._clear_btn = QPushButton("✕")
        self._clear_btn.setFixedSize(24, 24)
        self._clear_btn.setStyleSheet("""
            QPushButton {
                background-color: transparent;
                color: #888888;
                border: none;
                border-radius: 12px;
                font-size: 14px;
            }
            QPushButton:hover {
                color: #ffffff;
                background-color: #555555;
            }
        """)
        self._clear_btn.setVisible(False)
        self._clear_btn.clicked.connect(self._on_clear_clicked)
        main_layout.addWidget(self._clear_btn)

    # ── 信号连接 ─────────────────────────────────

    def _connect_signals(self):
        self._mode_combo.currentTextChanged.connect(self._on_mode_changed)
        self._search_input.textChanged.connect(self._on_text_changed)
        self._search_input.returnPressed.connect(self._on_return_pressed)

    # ── 公开方法 ────────────────────────────────

    def set_mode(self, mode: SearchMode):
        """设置搜索模式"""
        self._mode_combo.setCurrentText(mode.value)

    def get_mode(self) -> SearchMode:
        return self._mode

    def get_source(self) -> str:
        """获取当前选择的平台代号"""
        index = self._source_combo.currentIndex()
        if 0 <= index < len(SOURCE_NAMES):
            return SOURCE_NAMES[index]
        return "kw"

    def get_keyword(self) -> str:
        return self._search_input.text().strip()

    def set_searching(self, searching: bool):
        """设置搜索状态（显示/隐藏加载动画）"""
        self._is_searching = searching
        self._search_input.setEnabled(not searching)
        if searching:
            self._loading_label.start()
        else:
            self._loading_label.stop()

    def is_searching(self) -> bool:
        return self._is_searching

    def clear_search(self):
        """清空搜索"""
        self._search_input.clear()
        self._clear_btn.setVisible(False)
        self.search_cleared.emit()

    def set_placeholder(self, text: str):
        self._search_input.setPlaceholderText(text)

    def focus_search(self):
        """聚焦搜索框"""
        self._search_input.setFocus()
        self._search_input.selectAll()

    # ── 内部事件 ────────────────────────────────

    def _on_mode_changed(self, text: str):
        """模式切换"""
        new_mode = SearchMode.LOCAL if text == SearchMode.LOCAL.value else SearchMode.ONLINE

        if new_mode == self._mode:
            return

        self._mode = new_mode
        self._clear_btn.setVisible(False)

        if new_mode == SearchMode.ONLINE:
            self._search_input.setPlaceholderText("搜索全网歌曲...")
            self._source_combo.setVisible(True)
        else:
            self._search_input.setPlaceholderText("搜索本地音乐...")
            self._source_combo.setVisible(False)

        # 清空搜索状态
        self._search_input.clear()
        self.search_mode_changed.emit(new_mode)

    def _on_text_changed(self, text: str):
        """输入文本变化 → 防抖"""
        self._clear_btn.setVisible(bool(text))

        if self._mode == SearchMode.LOCAL:
            # 本地搜索实时过滤
            self._debounce_timer.stop()
            self.local_search_requested.emit(text.strip())
        else:
            # 在线搜索 500ms 防抖
            if text.strip():
                self._debounce_timer.start(500)
            else:
                self._debounce_timer.stop()
                self.search_cleared.emit()

    def _on_return_pressed(self):
        """回车键 → 立即搜索"""
        keyword = self._search_input.text().strip()
        if not keyword:
            return

        self._debounce_timer.stop()

        if self._mode == SearchMode.LOCAL:
            self.local_search_requested.emit(keyword)
        else:
            source = self.get_source()
            self.online_search_requested.emit(keyword, source)

    def _on_debounce_timeout(self):
        """防抖超时 → 执行在线搜索"""
        keyword = self._search_input.text().strip()
        if not keyword:
            return

        source = self.get_source()
        self.online_search_requested.emit(keyword, source)

    def _on_clear_clicked(self):
        self.clear_search()


# ──────────────────────────────────────────────
# 搜索结果状态栏
# ──────────────────────────────────────────────

class SearchStatusBar(QWidget):
    """
    搜索状态栏组件

    显示在歌曲列表底部，展示搜索统计信息、错误提示等。
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self._setup_ui()

    def _setup_ui(self):
        self.setFixedHeight(28)
        self.setStyleSheet("""
            SearchStatusBar {
                background-color: #222222;
                border-top: 1px solid #3a3a3a;
            }
        """)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 0, 12, 0)

        self._status_label = QLabel("")
        self._status_label.setStyleSheet("color: #888888; font-size: 11px;")
        layout.addWidget(self._status_label, 1)

        self._error_label = QLabel("")
        self._error_label.setStyleSheet("color: #f44336; font-size: 11px;")
        self._error_label.setVisible(False)
        layout.addWidget(self._error_label)

    # ── 公开方法 ────────────────────────────────

    def show_online_result(self, source: str, count: int):
        """显示在线搜索结果统计"""
        platform = SOURCE_MAP.get(source, source)
        self._status_label.setText(f"在 {platform} 找到 {count} 首歌曲")
        self._status_label.setStyleSheet("color: #4CAF50; font-size: 11px;")
        self._error_label.setVisible(False)

    def show_local_result(self, count: int):
        """显示本地搜索结果统计"""
        self._status_label.setText(f"找到 {count} 首本地歌曲")
        self._status_label.setStyleSheet("color: #888888; font-size: 11px;")
        self._error_label.setVisible(False)

    def show_error(self, message: str):
        """显示错误信息"""
        self._error_label.setText(message)
        self._error_label.setVisible(True)
        self._status_label.setText("")

    def show_loading(self, source: str):
        """显示搜索中"""
        platform = SOURCE_MAP.get(source, source)
        self._status_label.setText(f"正在从 {platform} 搜索...")
        self._status_label.setStyleSheet("color: #2196F3; font-size: 11px;")
        self._error_label.setVisible(False)

    def show_idle(self):
        """显示空闲状态"""
        self._status_label.setText("")
        self._error_label.setVisible(False)

    def show_empty(self, keyword: str):
        """显示空结果"""
        self._status_label.setText(f"未找到相关歌曲，试试其他关键词或平台")
        self._status_label.setStyleSheet("color: #888888; font-size: 11px;")
        self._error_label.setVisible(False)


# ──────────────────────────────────────────────
# 错误处理工具
# ──────────────────────────────────────────────

def format_search_error(error: Exception, source: str) -> str:
    """
    格式化搜索错误为人类可读的消息

    Args:
        error: 捕获的异常
        source: 平台代号

    Returns:
        用户友好的错误提示字符串
    """
    platform = SOURCE_MAP.get(source, source)

    if isinstance(error, TimeoutError):
        return "搜索超时，请检查网络连接或 API 地址"

    if isinstance(error, ConnectionError):
        return f"无法连接到搜索服务，请确认 lx-music-source 已启动"

    if hasattr(error, 'code'):
        code = error.code
        if code == 502:
            return f"{platform} 暂时不可用，建议切换其他平台"
        elif code == 500:
            return "服务异常，请稍后重试"
        elif code == 400:
            return "搜索参数错误"
        elif code == -1:
            return str(error)

    return f"搜索失败: {str(error)}"