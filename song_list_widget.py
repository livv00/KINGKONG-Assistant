"""
在线歌曲列表组件

支持两种显示模式：
- 本地歌曲行：封面 | 歌名-歌手 | 专辑 · 时长 | 收藏
- 在线歌曲行：封面 | 歌名-歌手 | 专辑 · 时长 | 音质标签 | 下载按钮

集成 DownloadManager，实时显示下载进度。
"""

import os
import time
from enum import Enum
from typing import Optional, Callable

import requests
from PyQt6.QtCore import (
    Qt, QSize, QRect, QTimer, pyqtSignal, QThread,
)
from PyQt6.QtGui import (
    QPixmap, QFont, QColor, QPalette, QPainter,
    QBrush, QPen, QAction, QIcon, QFontMetrics,
    QLinearGradient, QCursor,
)
from PyQt6.QtWidgets import (
    QListWidget, QListWidgetItem, QWidget, QHBoxLayout,
    QVBoxLayout, QLabel, QPushButton, QProgressBar,
    QMenu, QDialog, QDialogButtonBox, QFormLayout,
    QApplication, QFrame, QSizePolicy,
)

from download_manager import DownloadManager, DownloadTask, DownloadStatus


# ──────────────────────────────────────────────
# 常量
# ──────────────────────────────────────────────

QUALITY_COLORS = {
    "128k": QColor("#4CAF50"),    # 绿色
    "320k": QColor("#2196F3"),    # 蓝色
    "flac": QColor("#FFD700"),    # 金色
    "flac24bit": QColor("#9C27B0"),  # 紫色
}

QUALITY_LABELS = {
    "128k": "标准",
    "320k": "高品",
    "flac": "无损",
    "flac24bit": "Hi-Res",
}

COVER_SIZE = 60


# ──────────────────────────────────────────────
# 封面加载线程
# ──────────────────────────────────────────────

class CoverLoader(QThread):
    """异步加载封面图片"""

    cover_loaded = pyqtSignal(str, QPixmap)  # song_id, pixmap

    def __init__(self, parent=None):
        super().__init__(parent)
        self._queue: list[tuple[str, str]] = []
        self._mutex = __import__("threading").Lock()
        self._running = True

    def load(self, song_id: str, url: str):
        with self._mutex:
            self._queue.append((song_id, url))

    def stop(self):
        self._running = False

    def run(self):
        session = requests.Session()
        session.headers.update({"User-Agent": "CoverLoader/1.0"})
        while self._running:
            item = None
            with self._mutex:
                if self._queue:
                    item = self._queue.pop(0)
            if item:
                song_id, url = item
                if url:
                    try:
                        resp = session.get(url, timeout=5)
                        if resp.status_code == 200:
                            pixmap = QPixmap()
                            pixmap.loadFromData(resp.content)
                            if not pixmap.isNull():
                                pixmap = pixmap.scaled(
                                    COVER_SIZE, COVER_SIZE,
                                    Qt.AspectRatioMode.KeepAspectRatio,
                                    Qt.TransformationMode.SmoothTransformation,
                                )
                                self.cover_loaded.emit(song_id, pixmap)
                    except Exception:
                        pass
            else:
                self.msleep(100)
        session.close()


# ──────────────────────────────────────────────
# 音质标签
# ──────────────────────────────────────────────

class QualityLabel(QLabel):
    """显示音质的小标签，带颜色背景"""

    def __init__(self, quality: str, parent=None):
        super().__init__(parent)
        self._quality = quality
        label = QUALITY_LABELS.get(quality, quality.upper())
        self.setText(label)
        color = QUALITY_COLORS.get(quality, QColor("#888888"))
        self.setStyleSheet(f"""
            QLabel {{
                color: white;
                background-color: {color.name()};
                border-radius: 3px;
                padding: 1px 6px;
                font-size: 11px;
                font-weight: bold;
            }}
        """)
        self.setFixedHeight(20)
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)


# ──────────────────────────────────────────────
# 歌曲项 Widget
# ──────────────────────────────────────────────

class SongItemWidget(QWidget):
    """歌曲列表项的自定义 Widget"""

    download_clicked = pyqtSignal(str)       # song_id
    quality_selected = pyqtSignal(str, str)  # song_id, quality
    favorite_clicked = pyqtSignal(str)       # song_id
    preview_clicked = pyqtSignal(str)        # song_id
    detail_clicked = pyqtSignal(str)         # song_id

    def __init__(
        self,
        song_id: str,
        song_name: str,
        singer: str,
        album: str,
        duration: str,
        cover_url: str = "",
        qualities: Optional[dict] = None,
        is_online: bool = False,
        parent=None,
    ):
        super().__init__(parent)
        self.song_id = song_id
        self.song_name = song_name
        self.singer = singer
        self.album = album
        self.duration = duration
        self.cover_url = cover_url
        self.qualities = qualities or {}
        self.is_online = is_online

        # 运行时状态
        self._cover_pixmap: Optional[QPixmap] = None
        self._is_downloading = False
        self._is_downloaded = False
        self._download_progress = 0.0

        self._setup_ui()

    def _setup_ui(self):
        layout = QHBoxLayout(self)
        layout.setContentsMargins(4, 4, 8, 4)
        layout.setSpacing(8)

        # ── 封面 ──
        self._cover_label = QLabel()
        self._cover_label.setFixedSize(COVER_SIZE, COVER_SIZE)
        self._cover_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._cover_label.setStyleSheet("""
            QLabel {
                background-color: #2a2a2a;
                border-radius: 4px;
            }
        """)
        # 默认占位图标
        self._cover_label.setText("🎵")
        layout.addWidget(self._cover_label)

        # ── 信息区域 ──
        info_layout = QVBoxLayout()
        info_layout.setSpacing(2)

        # 第一行：歌名 - 歌手
        self._title_label = QLabel(f"{self.song_name} - {self.singer}")
        self._title_label.setStyleSheet("color: #ffffff; font-size: 13px; font-weight: bold;")
        self._title_label.setWordWrap(False)
        fm = QFontMetrics(self._title_label.font())
        elided = fm.elidedText(self._title_label.text(), Qt.TextElideMode.ElideRight, 400)
        self._title_label.setText(elided)
        info_layout.addWidget(self._title_label)

        # 第二行：专辑 · 时长
        sub_text = f"{self.album} · {self.duration}" if self.album else self.duration
        self._subtitle_label = QLabel(sub_text)
        self._subtitle_label.setStyleSheet("color: #999999; font-size: 11px;")
        info_layout.addWidget(self._subtitle_label)

        layout.addLayout(info_layout, 1)

        # ── 右侧操作区 ──
        right_layout = QHBoxLayout()
        right_layout.setSpacing(6)
        right_layout.setAlignment(Qt.AlignmentFlag.AlignVCenter)

        if self.is_online:
            # 音质标签
            best_q = DownloadTask.best_quality(self.qualities) if hasattr(DownloadTask, 'best_quality') else "320k"
            if best_q:
                self._quality_label = QualityLabel(best_q)
                right_layout.addWidget(self._quality_label)

            # 下载按钮 / 进度条
            self._download_btn = QPushButton("⬇ 下载")
            self._download_btn.setFixedSize(60, 26)
            self._download_btn.setStyleSheet("""
                QPushButton {
                    background-color: #2196F3;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: bold;
                }
                QPushButton:hover {
                    background-color: #1976D2;
                }
                QPushButton:pressed {
                    background-color: #1565C0;
                }
            """)
            self._download_btn.clicked.connect(self._on_download_clicked)
            right_layout.addWidget(self._download_btn)

            # 下载进度条（初始隐藏）
            self._progress_bar = QProgressBar()
            self._progress_bar.setFixedSize(60, 16)
            self._progress_bar.setTextVisible(True)
            self._progress_bar.setStyleSheet("""
                QProgressBar {
                    background-color: #333333;
                    border: 1px solid #555555;
                    border-radius: 3px;
                    text-align: center;
                    font-size: 9px;
                    color: white;
                }
                QProgressBar::chunk {
                    background-color: #2196F3;
                    border-radius: 2px;
                }
            """)
            self._progress_bar.hide()
            right_layout.addWidget(self._progress_bar)
        else:
            # 收藏按钮
            self._fav_btn = QPushButton("♡")
            self._fav_btn.setFixedSize(30, 26)
            self._fav_btn.setStyleSheet("""
                QPushButton {
                    background-color: transparent;
                    color: #999999;
                    border: 1px solid #555555;
                    border-radius: 4px;
                    font-size: 14px;
                }
                QPushButton:hover {
                    color: #ff6b6b;
                    border-color: #ff6b6b;
                }
            """)
            self._fav_btn.clicked.connect(lambda: self.favorite_clicked.emit(self.song_id))
            right_layout.addWidget(self._fav_btn)

        layout.addLayout(right_layout)

        # 整体样式
        self.setStyleSheet("""
            SongItemWidget {
                background-color: transparent;
                border-bottom: 1px solid #333333;
            }
            SongItemWidget:hover {
                background-color: #2a2a2a;
            }
        """)

    # ── 公开方法 ────────────────────────────────

    def set_cover(self, pixmap: QPixmap):
        self._cover_pixmap = pixmap
        self._cover_label.setPixmap(pixmap)

    def set_download_progress(self, progress: float):
        """设置下载进度 0.0 ~ 1.0"""
        self._is_downloading = True
        self._download_progress = progress
        self._download_btn.hide()
        self._progress_bar.show()
        self._progress_bar.setValue(int(progress * 100))

    def set_download_completed(self):
        """标记为已下载"""
        self._is_downloading = False
        self._is_downloaded = True
        self._progress_bar.hide()
        self._download_btn.setText("✓ 已下载")
        self._download_btn.setStyleSheet("""
            QPushButton {
                background-color: #4CAF50;
                color: white;
                border: none;
                border-radius: 4px;
                font-size: 11px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #388E3C;
            }
        """)
        self._download_btn.show()
        self._download_btn.setEnabled(False)

    def set_download_error(self, error_msg: str):
        """下载失败"""
        self._is_downloading = False
        self._progress_bar.hide()
        self._download_btn.setText("重试")
        self._download_btn.setStyleSheet("""
            QPushButton {
                background-color: #f44336;
                color: white;
                border: none;
                border-radius: 4px;
                font-size: 11px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #d32f2f;
            }
        """)
        self._download_btn.setEnabled(True)
        self._download_btn.show()
        # 重新绑定点击事件
        self._download_btn.clicked.disconnect()
        self._download_btn.clicked.connect(self._on_retry_clicked)

    def set_selected(self, selected: bool):
        """选中高亮"""
        if selected:
            self.setStyleSheet("""
                SongItemWidget {
                    background-color: #3a3a3a;
                    border-bottom: 1px solid #333333;
                }
            """)
        else:
            self.setStyleSheet("""
                SongItemWidget {
                    background-color: transparent;
                    border-bottom: 1px solid #333333;
                }
                SongItemWidget:hover {
                    background-color: #2a2a2a;
                }
            """)

    # ── 内部方法 ────────────────────────────────

    def _on_download_clicked(self):
        """点击下载按钮 → 弹出音质选择"""
        if not self.qualities:
            # 没有音质信息，直接使用默认
            self.quality_selected.emit(self.song_id, "320k")
            return

        # 构建音质选择菜单
        menu = QMenu(self)
        menu.setStyleSheet("""
            QMenu {
                background-color: #2a2a2a;
                border: 1px solid #555555;
                padding: 4px;
            }
            QMenu::item {
                padding: 6px 20px;
                color: #ffffff;
            }
            QMenu::item:selected {
                background-color: #2196F3;
            }
        """)

        for q_key in ("flac", "320k", "128k"):
            if q_key in self.qualities:
                q_info = self.qualities[q_key]
                size = q_info.get("size", "")
                label = QUALITY_LABELS.get(q_key, q_key.upper())
                text = f"{label} ({size})" if size else label
                action = menu.addAction(text)
                action.setData(q_key)

        selected = menu.exec(QCursor.pos())
        if selected:
            quality = selected.data()
            self.quality_selected.emit(self.song_id, quality)

    def _on_retry_clicked(self):
        """重试下载"""
        self._download_btn.setText("⬇ 下载")
        self._download_btn.setStyleSheet("""
            QPushButton {
                background-color: #2196F3;
                color: white;
                border: none;
                border-radius: 4px;
                font-size: 11px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #1976D2;
            }
        """)
        self._download_btn.clicked.disconnect()
        self._download_btn.clicked.connect(self._on_download_clicked)
        self.download_clicked.emit(self.song_id)


# ──────────────────────────────────────────────
# 主列表组件
# ──────────────────────────────────────────────

class SongListWidget(QListWidget):
    """
    歌曲列表组件

    支持本地和在线两种模式，通过 add_local_song / add_online_song 添加。
    集成 DownloadManager 信号，自动更新下载进度。

    信号:
        song_double_clicked(song_id, is_online)
        download_requested(song_id, quality)
        preview_requested(song_id)
        detail_requested(song_id)
        favorite_requested(song_id)
    """

    song_double_clicked = pyqtSignal(str, bool)  # song_id, is_online
    download_requested = pyqtSignal(str, str)     # song_id, quality
    preview_requested = pyqtSignal(str)           # song_id
    detail_requested = pyqtSignal(str)            # song_id
    favorite_requested = pyqtSignal(str)          # song_id

    def __init__(self, download_manager: Optional[DownloadManager] = None, parent=None):
        super().__init__(parent)
        self._download_manager = download_manager
        self._cover_loader = CoverLoader(self)
        self._cover_loader.cover_loaded.connect(self._on_cover_loaded)
        self._cover_loader.start()

        # 存储: song_id → widget
        self._widgets: dict[str, SongItemWidget] = {}
        # 存储: song_id → item (QListWidgetItem)
        self._items: dict[str, QListWidgetItem] = {}
        # 音乐数据缓存
        self._song_data: dict[str, dict] = {}

        self._setup_ui()

        # 连接 DownloadManager 信号
        if self._download_manager:
            self._download_manager.download_progress.connect(self._on_download_progress)
            self._download_manager.download_finished.connect(self._on_download_finished)
            self._download_manager.download_error.connect(self._on_download_error)

    def set_download_manager(self, dm: DownloadManager):
        """设置下载管理器（可在初始化后绑定）"""
        self._download_manager = dm
        self._download_manager.download_progress.connect(self._on_download_progress)
        self._download_manager.download_finished.connect(self._on_download_finished)
        self._download_manager.download_error.connect(self._on_download_error)

    # ── 添加歌曲 ────────────────────────────────

    def add_local_song(
        self,
        song_id: str,
        song_name: str,
        singer: str,
        album: str,
        duration: str,
        cover_url: str = "",
    ):
        """添加本地歌曲到列表"""
        self._add_song(
            song_id=song_id,
            song_name=song_name,
            singer=singer,
            album=album,
            duration=duration,
            cover_url=cover_url,
            is_online=False,
        )

    def add_online_song(
        self,
        song_id: str,
        song_name: str,
        singer: str,
        album: str,
        duration: str,
        cover_url: str = "",
        qualities: Optional[dict] = None,
    ):
        """添加在线歌曲到列表"""
        self._add_song(
            song_id=song_id,
            song_name=song_name,
            singer=singer,
            album=album,
            duration=duration,
            cover_url=cover_url,
            qualities=qualities,
            is_online=True,
        )

    def add_online_songs(self, songs: list[dict]):
        """批量添加在线歌曲"""
        for song in songs:
            self.add_online_song(
                song_id=song.get("hash") or song.get("songmid", ""),
                song_name=song.get("name", ""),
                singer=song.get("singer", ""),
                album=song.get("album", ""),
                duration=song.get("interval", "00:00"),
                cover_url=song.get("img", ""),
                qualities=song.get("quality", {}),
            )

    def clear_songs(self):
        """清空所有歌曲"""
        self.clear()
        self._widgets.clear()
        self._items.clear()
        self._song_data.clear()

    def get_song_data(self, song_id: str) -> Optional[dict]:
        """获取缓存的歌曲数据"""
        return self._song_data.get(song_id)

    # ── 更新下载状态 ────────────────────────────

    def set_download_progress(self, song_id: str, progress: float, speed: float, remaining: float):
        """更新下载进度"""
        widget = self._widgets.get(song_id)
        if widget:
            widget.set_download_progress(progress)

    def set_download_finished(self, song_id: str, file_path: str):
        """标记下载完成"""
        widget = self._widgets.get(song_id)
        if widget:
            widget.set_download_completed()

    def set_download_error(self, song_id: str, error_msg: str):
        """标记下载失败"""
        widget = self._widgets.get(song_id)
        if widget:
            widget.set_download_error(error_msg)

    # ── 内部方法 ────────────────────────────────

    def _setup_ui(self):
        self.setStyleSheet("""
            QListWidget {
                background-color: #1a1a1a;
                border: none;
                outline: none;
            }
            QListWidget::item {
                background-color: transparent;
                border-bottom: 1px solid #2a2a2a;
            }
            QListWidget::item:selected {
                background-color: #3a3a3a;
            }
            QListWidget::item:hover {
                background-color: #2a2a2a;
            }
        """)
        self.setVerticalScrollMode(QListWidget.ScrollMode.ScrollPerPixel)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setSelectionMode(QListWidget.SelectionMode.SingleSelection)
        self.setSpacing(0)
        self.setWordWrap(False)

        # 双击事件
        self.itemDoubleClicked.connect(self._on_item_double_clicked)
        # 右键菜单
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.customContextMenuRequested.connect(self._on_context_menu)

    def _add_song(
        self,
        song_id: str,
        song_name: str,
        singer: str,
        album: str,
        duration: str,
        cover_url: str = "",
        qualities: Optional[dict] = None,
        is_online: bool = False,
    ):
        # 去重
        if song_id in self._widgets:
            return

        # 缓存数据
        self._song_data[song_id] = {
            "song_id": song_id,
            "song_name": song_name,
            "singer": singer,
            "album": album,
            "duration": duration,
            "cover_url": cover_url,
            "qualities": qualities,
            "is_online": is_online,
        }

        # 创建 Widget
        widget = SongItemWidget(
            song_id=song_id,
            song_name=song_name,
            singer=singer,
            album=album,
            duration=duration,
            cover_url=cover_url,
            qualities=qualities,
            is_online=is_online,
        )

        # 连接信号
        if is_online:
            widget.download_clicked.connect(self._on_download_clicked)
            widget.quality_selected.connect(self._on_quality_selected)
        else:
            widget.favorite_clicked.connect(self._on_favorite_clicked)

        # 创建项
        item = QListWidgetItem(self)
        item.setData(Qt.ItemDataRole.UserRole, song_id)
        item.setSizeHint(QSize(0, COVER_SIZE + 8))

        self.addItem(item)
        self.setItemWidget(item, widget)

        self._widgets[song_id] = widget
        self._items[song_id] = item

        # 加载封面
        if cover_url:
            self._cover_loader.load(song_id, cover_url)

    def _on_cover_loaded(self, song_id: str, pixmap: QPixmap):
        widget = self._widgets.get(song_id)
        if widget:
            widget.set_cover(pixmap)

    def _on_item_double_clicked(self, item: QListWidgetItem):
        song_id = item.data(Qt.ItemDataRole.UserRole)
        data = self._song_data.get(song_id)
        if data:
            self.song_double_clicked.emit(song_id, data.get("is_online", False))

    def _on_context_menu(self, pos):
        item = self.itemAt(pos)
        if not item:
            return
        song_id = item.data(Qt.ItemDataRole.UserRole)
        data = self._song_data.get(song_id)
        if not data:
            return

        is_online = data.get("is_online", False)
        menu = QMenu(self)
        menu.setStyleSheet("""
            QMenu {
                background-color: #2a2a2a;
                border: 1px solid #555555;
                padding: 4px;
            }
            QMenu::item {
                padding: 6px 20px;
                color: #ffffff;
            }
            QMenu::item:selected {
                background-color: #2196F3;
            }
            QMenu::separator {
                height: 1px;
                background: #444444;
                margin: 4px 8px;
            }
        """)

        if is_online:
            # 下载子菜单
            dl_menu = menu.addMenu("⬇ 下载")
            qualities = data.get("qualities", {})
            if qualities:
                for q_key in ("flac", "320k", "128k"):
                    if q_key in qualities:
                        q_info = qualities[q_key]
                        size = q_info.get("size", "")
                        label = QUALITY_LABELS.get(q_key, q_key.upper())
                        text = f"{label} ({size})" if size else label
                        action = dl_menu.addAction(text)
                        action.setData({"song_id": song_id, "quality": q_key})
                dl_menu.addSeparator()
                action = dl_menu.addAction("全部下载")
                action.setData({"song_id": song_id, "quality": "all"})
            else:
                action = dl_menu.addAction("默认音质")
                action.setData({"song_id": song_id, "quality": "320k"})

            menu.addSeparator()
            action = menu.addAction("▶ 试听（30秒）")
            action.setData({"action": "preview", "song_id": song_id})
            menu.addSeparator()
            action = menu.addAction("ℹ 查看详情")
            action.setData({"action": "detail", "song_id": song_id})
        else:
            action = menu.addAction("♡ 收藏")
            action.setData({"action": "favorite", "song_id": song_id})

        selected = menu.exec(self.mapToGlobal(pos))
        if selected:
            data = selected.data()
            if isinstance(data, dict):
                action = data.get("action")
                if action == "preview":
                    self.preview_requested.emit(song_id)
                elif action == "detail":
                    self.detail_requested.emit(song_id)
                elif action == "favorite":
                    self.favorite_requested.emit(song_id)
                elif "quality" in data:
                    quality = data["quality"]
                    if quality == "all":
                        # 逐个发送所有音质
                        qualities = self._song_data.get(song_id, {}).get("qualities", {})
                        for q_key in ("flac", "320k", "128k"):
                            if q_key in qualities:
                                self.download_requested.emit(song_id, q_key)
                    else:
                        self.download_requested.emit(song_id, quality)

    def _on_download_clicked(self, song_id: str):
        self.download_requested.emit(song_id, "320k")

    def _on_quality_selected(self, song_id: str, quality: str):
        self.download_requested.emit(song_id, quality)

    def _on_favorite_clicked(self, song_id: str):
        self.favorite_requested.emit(song_id)

    # ── DownloadManager 信号连接 ────────────────

    def _on_download_progress(self, song_id: str, progress: float, speed: float, remaining: float):
        self.set_download_progress(song_id, progress, speed, remaining)

    def _on_download_finished(self, song_id: str, file_path: str):
        self.set_download_finished(song_id, file_path)

    def _on_download_error(self, song_id: str, error_msg: str):
        self.set_download_error(song_id, error_msg)

    # ── 清理 ────────────────────────────────────

    def cleanup(self):
        """清理资源"""
        self._cover_loader.stop()
        self._cover_loader.wait(1000)


# ──────────────────────────────────────────────
# 歌曲详情对话框
# ──────────────────────────────────────────────

class SongDetailDialog(QDialog):
    """歌曲详情信息面板"""

    def __init__(self, song_data: dict, parent=None):
        super().__init__(parent)
        self.setWindowTitle("歌曲详情")
        self.setMinimumSize(400, 300)
        self.setStyleSheet("""
            QDialog {
                background-color: #1a1a1a;
                color: #ffffff;
            }
            QLabel {
                color: #ffffff;
            }
        """)

        layout = QVBoxLayout(self)
        layout.setSpacing(12)

        # 标题
        title = QLabel(f"<b>{song_data.get('song_name', '')}</b>")
        title.setStyleSheet("font-size: 18px;")
        layout.addWidget(title)

        # 信息表单
        form = QFormLayout()
        form.setSpacing(8)
        form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        labels = [
            ("歌手", song_data.get("singer", "")),
            ("专辑", song_data.get("album", "")),
            ("时长", song_data.get("duration", "")),
        ]

        for name, value in labels:
            label = QLabel(value)
            label.setStyleSheet("color: #cccccc; font-size: 13px;")
            form.addRow(f"{name}:", label)

        # 音质信息
        qualities = song_data.get("qualities", {})
        if qualities:
            q_text = "、".join(
                f"{QUALITY_LABELS.get(q, q)} ({info.get('size', '?')})"
                for q, info in qualities.items()
            )
            q_label = QLabel(q_text)
            q_label.setStyleSheet("color: #cccccc; font-size: 13px;")
            form.addRow("可用音质:", q_label)

        layout.addLayout(form)

        # 按钮
        btn_box = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        btn_box.rejected.connect(self.reject)
        btn_box.setStyleSheet("""
            QPushButton {
                background-color: #2196F3;
                color: white;
                border: none;
                border-radius: 4px;
                padding: 6px 16px;
            }
            QPushButton:hover {
                background-color: #1976D2;
            }
        """)
        layout.addWidget(btn_box)