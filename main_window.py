"""
多轨音频编辑器 - 主窗口与播放器集成

提供：
  - 主播放器界面（播放/暂停/上/下曲）
  - 与主 Electron 播放器通信（IPC 或共享文件）
  - 启动多轨编辑器
  - 从播放器导入歌曲到编辑器
"""

import os
import json
import subprocess
from typing import Optional, List

from PyQt6.QtCore import Qt, QTimer, QUrl
from PyQt6.QtGui import QColor, QFont, QAction, QKeySequence, QPixmap
from PyQt6.QtWidgets import (
    QMainWindow, QWidget, QHBoxLayout, QVBoxLayout, QLabel, QPushButton,
    QSlider, QListWidget, QListWidgetItem, QScrollArea, QFrame,
    QStatusBar, QToolBar, QMenu, QMessageBox, QApplication, QSizePolicy,
    QFileDialog, QSplitter, QLineEdit,
)

# from audio_editor import AudioEditorWindow  # 已禁用：多轨编辑器
# from track_item import AudioTrack, AudioItem, TrackColor  # 已禁用：多轨编辑器


# ═══════════════════════════════════════════════════════
# 主窗口（PyQt6 独立播放器）
# ═══════════════════════════════════════════════════════

class MainWindow(QMainWindow):
    """
    主播放器窗口。

    包含：
      - 歌曲列表
      - 播放控制栏
      - 歌曲信息显示
      - 启动多轨编辑器的入口
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("直播助手 - 音频播放器")
        self.resize(1000, 650)

        # ── 状态 ──
        self.playlist: List[dict] = []      # 歌曲列表
        self.current_index = -1
        self._is_playing = False
        # self._audio_editor: Optional[AudioEditorWindow] = None  # 已禁用：多轨编辑器

        # ── 构建 UI ──
        self._build_menu_bar()
        self._build_central()
        self._build_playback_bar()
        self._build_status_bar()

        # 播放定时器
        self._play_timer = QTimer(self)
        self._play_timer.setInterval(500)
        self._play_timer.timeout.connect(self._on_tick)

    # ════════════════════════════════════════════════
    # UI 构建
    # ════════════════════════════════════════════════

    def _build_menu_bar(self):
        menubar = self.menuBar()

        file_menu = menubar.addMenu("文件")
        file_menu.addAction(self._create_action("导入音频文件", self._on_import_files, "Ctrl+O"))
        file_menu.addAction(self._create_action("导入文件夹", self._on_import_folder, "Ctrl+Shift+O"))
        file_menu.addSeparator()
        file_menu.addAction(self._create_action("退出", self.close, "Ctrl+Q"))

        edit_menu = menubar.addMenu("编辑")
        edit_menu.addAction(self._create_action("清空播放列表", self._clear_playlist))

        # tools_menu = menubar.addMenu("工具")  # 已禁用：多轨编辑器
        # tools_menu.addAction(self._create_action("多轨音频编辑器", self._open_editor, "Ctrl+E"))  # 已禁用
        # tools_menu.addSeparator()  # 已禁用
        # tools_menu.addAction(self._create_action("混音面板", self._open_mixer))  # 已禁用

        view_menu = menubar.addMenu("视图")
        view_menu.addAction(self._create_action("显示播放列表", self._toggle_playlist))

        help_menu = menubar.addMenu("帮助")
        help_menu.addAction(self._create_action("关于", self._show_about))

    def _build_central(self):
        central = QWidget()
        self.setCentralWidget(central)

        layout = QHBoxLayout(central)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ── 左侧：播放列表 ──
        self._playlist_widget = QWidget()
        self._playlist_widget.setFixedWidth(280)
        pl_layout = QVBoxLayout(self._playlist_widget)
        pl_layout.setContentsMargins(0, 0, 0, 0)
        pl_layout.setSpacing(0)

        pl_header = QLabel("播放列表")
        pl_header.setFixedHeight(32)
        pl_header.setAlignment(Qt.AlignmentFlag.AlignCenter)
        pl_header.setStyleSheet(
            "background: #16213e; color: #eee; font-size: 12px;"
            " font-weight: bold; border-bottom: 1px solid #333;"
        )
        pl_layout.addWidget(pl_header)

        self._song_list = QListWidget()
        self._song_list.setStyleSheet("""
            QListWidget { background: #1a1a2e; color: #ccc; border: none;
                         font-size: 11px; }
            QListWidget::item { padding: 6px 10px; border-bottom: 1px solid #2a2a3e; }
            QListWidget::item:hover { background: #2a2a4a; }
            QListWidget::item:selected { background: #0f3460; color: #fff; }
        """)
        self._song_list.itemDoubleClicked.connect(self._on_song_activated)
        self._song_list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._song_list.customContextMenuRequested.connect(self._on_song_context_menu)
        pl_layout.addWidget(self._song_list, 1)

        layout.addWidget(self._playlist_widget)

        # ── 右侧：歌曲信息 + 大图 ──
        right_panel = QWidget()
        right_panel.setStyleSheet("background: #1e1e32;")
        right_layout = QVBoxLayout(right_panel)
        right_layout.setContentsMargins(20, 20, 20, 20)
        right_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)

        # 封面占位
        self._cover_label = QLabel()
        self._cover_label.setFixedSize(200, 200)
        self._cover_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._cover_label.setStyleSheet(
            "background: #2a2a44; border-radius: 10px; color: #555;"
            " font-size: 48px;"
        )
        self._cover_label.setText("🎵")
        right_layout.addWidget(self._cover_label, 0, Qt.AlignmentFlag.AlignCenter)

        # 歌曲标题
        self._title_label = QLabel("未播放")
        self._title_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._title_label.setStyleSheet(
            "color: #eee; font-size: 18px; font-weight: bold;"
            " margin-top: 10px;"
        )
        right_layout.addWidget(self._title_label)

        # 歌手
        self._artist_label = QLabel("")
        self._artist_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._artist_label.setStyleSheet("color: #999; font-size: 13px;")
        right_layout.addWidget(self._artist_label)

        right_layout.addStretch()

        layout.addWidget(right_panel, 1)

    def _build_playback_bar(self):
        bar = QFrame()
        bar.setFixedHeight(56)
        bar.setStyleSheet("""
            QFrame { background: #16213e; border-top: 1px solid #333; }
            QPushButton { background: #0f3460; color: #eee; border: none;
                         border-radius: 4px; font-size: 16px; }
            QPushButton:hover { background: #1a4080; }
            QLabel { color: #999; font-size: 11px; }
        """)
        layout = QHBoxLayout(bar)
        layout.setContentsMargins(12, 6, 12, 6)
        layout.setSpacing(6)

        self._prev_btn = QPushButton("⏮")
        self._prev_btn.setFixedSize(36, 36)
        self._prev_btn.clicked.connect(self._on_prev)
        layout.addWidget(self._prev_btn)

        self._play_btn = QPushButton("▶")
        self._play_btn.setFixedSize(44, 36)
        self._play_btn.clicked.connect(self._on_play_pause)
        layout.addWidget(self._play_btn)

        self._next_btn = QPushButton("⏭")
        self._next_btn.setFixedSize(36, 36)
        self._next_btn.clicked.connect(self._on_next)
        layout.addWidget(self._next_btn)

        self._progress = QSlider(Qt.Orientation.Horizontal)
        self._progress.setRange(0, 1000)
        self._progress.sliderMoved.connect(self._on_seek)
        layout.addWidget(self._progress, 1)

        self._time_label = QLabel("00:00 / 00:00")
        self._time_label.setFixedWidth(110)
        self._time_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._time_label.setStyleSheet("color: #eee; font-family: Consolas; font-size: 12px;")
        layout.addWidget(self._time_label)

        sep = QFrame()
        sep.setFixedWidth(1)
        sep.setStyleSheet("background: #333;")
        layout.addWidget(sep)

        # 音量
        layout.addWidget(QLabel("音量"))
        self._vol_slider = QSlider(Qt.Orientation.Horizontal)
        self._vol_slider.setRange(0, 200)
        self._vol_slider.setValue(100)
        self._vol_slider.setFixedWidth(80)
        layout.addWidget(self._vol_slider)

        sep2 = QFrame()
        sep2.setFixedWidth(1)
        sep2.setStyleSheet("background: #333;")
        layout.addWidget(sep2)

        # 多轨编辑器按钮（已禁用）
        # self._editor_btn = QPushButton("🎛 多轨编辑")
        # self._editor_btn.setFixedHeight(32)
        # self._editor_btn.setStyleSheet("""
        #     QPushButton { background: #2a2a4a; color: #8ab4f8; border: 1px solid #4a4a6a;
        #                  border-radius: 4px; font-size: 12px; padding: 0 12px; }
        #     QPushButton:hover { background: #3a3a5a; border-color: #8ab4f8; }
        # """)
        # self._editor_btn.clicked.connect(self._open_editor)
        # layout.addWidget(self._editor_btn)

        old_central = self.centralWidget()
        wrapper = QWidget()
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
        self._song_count_label = QLabel("歌曲: 0")
        self._status.addWidget(self._song_count_label)

    # ════════════════════════════════════════════════
    # 播放列表管理
    # ════════════════════════════════════════════════

    def _on_import_files(self):
        files, _ = QFileDialog.getOpenFileNames(
            self, "选择音频文件", "",
            "音频文件 (*.mp3 *.wav *.ogg *.flac *.aac *.m4a);;所有文件 (*.*)"
        )
        for f in files:
            self._add_to_playlist(f)

    def _on_import_folder(self):
        folder = QFileDialog.getExistingDirectory(self, "选择文件夹")
        if not folder:
            return
        audio_exts = ('.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a')
        for root, _, files in os.walk(folder):
            for f in files:
                if f.lower().endswith(audio_exts):
                    self._add_to_playlist(os.path.join(root, f))

    def _add_to_playlist(self, file_path: str):
        name = os.path.splitext(os.path.basename(file_path))[0]
        entry = {"path": file_path, "name": name}
        self.playlist.append(entry)
        item = QListWidgetItem(name)
        item.setData(Qt.ItemDataRole.UserRole, len(self.playlist) - 1)
        self._song_list.addItem(item)
        self._update_status()

    def _clear_playlist(self):
        self.playlist.clear()
        self._song_list.clear()
        self.current_index = -1
        self._title_label.setText("未播放")
        self._artist_label.setText("")
        self._update_status()

    def _on_song_activated(self, item):
        idx = item.data(Qt.ItemDataRole.UserRole)
        if idx is not None:
            self._play_index(idx)

    def _on_song_context_menu(self, pos):
        item = self._song_list.itemAt(pos)
        if not item:
            return
        idx = item.data(Qt.ItemDataRole.UserRole)
        if idx is None:
            return

        menu = QMenu()
        play_action = menu.addAction("播放")
        # send_action = menu.addAction("发送到多轨编辑器")  # 已禁用

        selected = menu.exec(self._song_list.mapToGlobal(pos))
        if selected == play_action:
            self._play_index(idx)
        # elif selected == send_action:  # 已禁用
        #     self._send_to_editor(idx)

    # ════════════════════════════════════════════════
    # 播放控制（简化版，实际播放依赖外部引擎）
    # ════════════════════════════════════════════════

    def _play_index(self, idx: int):
        if idx < 0 or idx >= len(self.playlist):
            return
        self.current_index = idx
        entry = self.playlist[idx]
        self._title_label.setText(entry["name"])
        self._artist_label.setText(os.path.dirname(entry["path"]))
        self._is_playing = True
        self._play_btn.setText("⏸")
        self._play_timer.start()
        self._status_label.setText(f"播放: {entry['name']}")

    def _on_play_pause(self):
        if self._is_playing:
            self._is_playing = False
            self._play_btn.setText("▶")
            self._play_timer.stop()
        else:
            if self.current_index >= 0:
                self._is_playing = True
                self._play_btn.setText("⏸")
                self._play_timer.start()

    def _on_prev(self):
        if self.current_index > 0:
            self._play_index(self.current_index - 1)

    def _on_next(self):
        if self.current_index < len(self.playlist) - 1:
            self._play_index(self.current_index + 1)

    def _on_seek(self, value: int):
        pass  # 进度条拖动，由外部播放引擎处理

    def _on_tick(self):
        pass  # 播放进度更新，由外部播放引擎处理

    # ════════════════════════════════════════════════
    # 多轨编辑器集成（已禁用）
    # ════════════════════════════════════════════════

    # def _open_editor(self):
    #     """打开多轨音频编辑器"""
    #     if self._audio_editor is None:
    #         self._audio_editor = AudioEditorWindow()
    #     self._audio_editor.show()
    #     self._audio_editor.raise_()
    #     self._audio_editor.activateWindow()
    #     self._status_label.setText("已打开多轨音频编辑器")

    # def _open_mixer(self):
    #     """打开混音面板（如果编辑器已打开）"""
    #     if self._audio_editor and self._audio_editor.isVisible():
    #         self._audio_editor._open_mixer_panel()
    #     else:
    #         QMessageBox.information(self, "提示", "请先打开多轨音频编辑器")

    # def _send_to_editor(self, song_idx: int):
    #     """将播放列表中的歌曲发送到多轨编辑器"""
    #     if song_idx < 0 or song_idx >= len(self.playlist):
    #         return
    #     entry = self.playlist[song_idx]
    #     file_path = entry["path"]
    #     if not os.path.isfile(file_path):
    #         QMessageBox.warning(self, "提示", f"文件不存在:\n{file_path}")
    #         return
    #     self._open_editor()
    #     if self._audio_editor:
    #         self._audio_editor._load_audio_to_track(file_path, 0)
    #         self._status_label.setText(f"已发送到编辑器: {entry['name']}")

    # ════════════════════════════════════════════════
    # 工具方法
    # ════════════════════════════════════════════════

    def _toggle_playlist(self):
        self._playlist_widget.setVisible(not self._playlist_widget.isVisible())

    def _update_status(self):
        self._song_count_label.setText(f"歌曲: {len(self.playlist)}")

    def _create_action(self, text: str, slot, shortcut=None) -> QAction:
        action = QAction(text, self)
        action.triggered.connect(slot)
        if shortcut:
            action.setShortcut(QKeySequence(shortcut))
        return action

    def _show_about(self):
        QMessageBox.about(self, "关于",
            "<h3>直播助手 - 音频播放器</h3>"
            "<p>基于 PyQt6 的多功能音频播放器</p>"
            "<p>支持：播放列表、格式转换</p>"
        )


# ═══════════════════════════════════════════════════════
# 入口
# ═══════════════════════════════════════════════════════

def main():
    import sys
    app = QApplication(sys.argv)
    app.setStyle("Fusion")

    from PyQt6.QtGui import QPalette
    palette = QPalette()
    palette.setColor(QPalette.ColorRole.Window, QColor(26, 26, 46))
    palette.setColor(QPalette.ColorRole.WindowText, QColor(238, 238, 238))
    palette.setColor(QPalette.ColorRole.Base, QColor(30, 30, 48))
    palette.setColor(QPalette.ColorRole.Text, QColor(238, 238, 238))
    palette.setColor(QPalette.ColorRole.Button, QColor(42, 42, 66))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor(238, 238, 238))
    app.setPalette(palette)

    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()