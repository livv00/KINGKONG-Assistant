"""
多轨音频编辑器 - 项目保存与加载 (.mep)

保存格式: JSON
  - 音频文件不嵌入项目文件，只记录相对路径
  - 项目文件和音频文件放在同一文件夹下
  - 如果音频文件被移动，加载时提示重新定位
"""

import os
import json
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field, asdict

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QFileDialog, QMessageBox, QDialog, QVBoxLayout, QHBoxLayout,
    QLabel, QPushButton, QListWidget, QListWidgetItem,
)


# ═══════════════════════════════════════════════════════
# 数据模型
# ═══════════════════════════════════════════════════════

@dataclass
class FadeInfo:
    duration: float = 0.0
    type: str = "linear"  # linear, exponential, logarithmic, s_curve


@dataclass
class ItemInfo:
    audio_file: str = ""          # 相对路径
    start_time: float = 0.0
    fade_in: FadeInfo = field(default_factory=FadeInfo)
    fade_out: FadeInfo = field(default_factory=FadeInfo)
    gain: float = 1.0
    trim_start: float = 0.0
    trim_end: float = 0.0
    name: str = ""
    muted: bool = False


@dataclass
class TrackInfo:
    name: str = "轨道"
    color: str = "#569CD6"
    volume: float = 1.0
    pan: float = 0.0
    muted: bool = False
    solo: bool = False
    items: List[ItemInfo] = field(default_factory=list)


@dataclass
class ProjectInfo:
    version: str = "1.0"
    name: str = "未命名项目"
    duration: float = 0.0
    bpm: int = 120
    sample_rate: int = 44100
    tracks: List[TrackInfo] = field(default_factory=list)


# ═══════════════════════════════════════════════════════
# 序列化 / 反序列化
# ═══════════════════════════════════════════════════════

def project_to_dict(project: ProjectInfo) -> dict:
    """将 ProjectInfo 转为可 JSON 序列化的字典"""
    return {
        "version": project.version,
        "project": {
            "name": project.name,
            "duration": project.duration,
            "bpm": project.bpm,
            "sample_rate": project.sample_rate,
            "tracks": [
                {
                    "name": t.name,
                    "color": t.color,
                    "volume": t.volume,
                    "pan": t.pan,
                    "muted": t.muted,
                    "items": [
                        {
                            "audio_file": item.audio_file,
                            "start_time": item.start_time,
                            "fade_in": {
                                "duration": item.fade_in.duration,
                                "type": item.fade_in.type,
                            },
                            "fade_out": {
                                "duration": item.fade_out.duration,
                                "type": item.fade_out.type,
                            },
                            "gain": item.gain,
                            "trim_start": item.trim_start,
                            "trim_end": item.trim_end,
                            "name": item.name,
                            "muted": item.muted,
                        }
                        for item in t.items
                    ],
                }
                for t in project.tracks
            ],
        },
    }


def dict_to_project(data: dict) -> ProjectInfo:
    """将字典解析为 ProjectInfo"""
    proj = data.get("project", data)
    tracks_data = proj.get("tracks", [])
    tracks = []
    for td in tracks_data:
        items_data = td.get("items", [])
        items = []
        for itd in items_data:
            fi = itd.get("fade_in", {})
            fo = itd.get("fade_out", {})
            items.append(ItemInfo(
                audio_file=itd.get("audio_file", ""),
                start_time=itd.get("start_time", 0.0),
                fade_in=FadeInfo(
                    duration=fi.get("duration", 0.0),
                    type=fi.get("type", "linear"),
                ),
                fade_out=FadeInfo(
                    duration=fo.get("duration", 0.0),
                    type=fo.get("type", "linear"),
                ),
                gain=itd.get("gain", 1.0),
                trim_start=itd.get("trim_start", 0.0),
                trim_end=itd.get("trim_end", 0.0),
                name=itd.get("name", ""),
                muted=itd.get("muted", False),
            ))
        tracks.append(TrackInfo(
            name=td.get("name", "轨道"),
            color=td.get("color", "#569CD6"),
            volume=td.get("volume", 1.0),
            pan=td.get("pan", 0.0),
            muted=td.get("muted", False),
            solo=td.get("solo", False),
            items=items,
        ))
    return ProjectInfo(
        version=data.get("version", "1.0"),
        name=proj.get("name", "未命名项目"),
        duration=proj.get("duration", 0.0),
        bpm=proj.get("bpm", 120),
        sample_rate=proj.get("sample_rate", 44100),
        tracks=tracks,
    )


# ═══════════════════════════════════════════════════════
# 文件操作
# ═══════════════════════════════════════════════════════

class ProjectIO:
    """
    项目保存与加载。

    用法:
        io = ProjectIO()
        io.save_project(tracks, file_path, project_name)
        project = io.load_project(file_path)
        ok, missing = io.resolve_audio_files(project, project_dir)
    """

    FILE_EXTENSION = ".mep"
    FILE_FILTER = "音乐编辑项目 (*.mep);;所有文件 (*.*)"

    @staticmethod
    def save_project(tracks, project_name: str, file_path: str,
                     bpm: int = 120, sample_rate: int = 44100) -> bool:
        """
        保存项目到文件。

        Args:
            tracks: List[AudioTrack]
            project_name: 项目名称
            file_path: 保存路径
            bpm: BPM
            sample_rate: 采样率

        Returns:
            bool: 是否保存成功
        """
        project_dir = os.path.dirname(file_path)

        # 构建轨道信息
        track_infos = []
        for track in tracks:
            items = []
            for item in track.items:
                # 尝试获取音频文件相对路径
                rel_path = ""
                if hasattr(item, '_source_file') and item._source_file:
                    try:
                        rel_path = os.path.relpath(item._source_file, project_dir)
                    except ValueError:
                        rel_path = os.path.basename(item._source_file)
                elif item.name:
                    # 用名称作为后备
                    rel_path = item.name

                items.append({
                    "audio_file": rel_path,
                    "start_time": item.start_time,
                    "fade_in": {
                        "duration": item.fade_in_duration,
                        "type": item.fade_in_type.value if hasattr(item.fade_in_type, 'value') else "linear",
                    },
                    "fade_out": {
                        "duration": item.fade_out_duration,
                        "type": item.fade_out_type.value if hasattr(item.fade_out_type, 'value') else "linear",
                    },
                    "gain": item.gain,
                    "trim_start": item._trim_start_sec,
                    "trim_end": item._trim_end_sec,
                    "name": item.name,
                    "muted": item.muted,
                })

            track_infos.append({
                "name": track.name,
                "color": track.color.name() if hasattr(track.color, 'name') else "#569CD6",
                "volume": track.volume,
                "pan": track.pan,
                "muted": track.muted,
                "solo": track.solo,
                "items": items,
            })

        # 计算项目总时长
        duration = max((t.duration for t in tracks), default=0.0)

        data = {
            "version": "1.0",
            "project": {
                "name": project_name,
                "duration": duration,
                "bpm": bpm,
                "sample_rate": sample_rate,
                "tracks": track_infos,
            },
        }

        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return True
        except (IOError, OSError) as e:
            QMessageBox.critical(None, "保存失败", f"无法保存项目文件:\n{e}")
            return False

    @staticmethod
    def load_project(file_path: str) -> Optional[ProjectInfo]:
        """
        从文件加载项目。

        Args:
            file_path: .mep 文件路径

        Returns:
            ProjectInfo 或 None（加载失败时）
        """
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (IOError, json.JSONDecodeError) as e:
            QMessageBox.critical(None, "加载失败", f"无法加载项目文件:\n{e}")
            return None

        return dict_to_project(data)

    @staticmethod
    def resolve_audio_files(project: ProjectInfo, project_dir: str) -> tuple:
        """
        解析项目中的音频文件路径，处理缺失文件。

        Args:
            project: ProjectInfo
            project_dir: 项目文件所在目录

        Returns:
            (ok, missing_files): 是否全部成功, 缺失文件列表
        """
        missing = []
        for track in project.tracks:
            for item in track.items:
                if not item.audio_file:
                    continue
                abs_path = os.path.join(project_dir, item.audio_file)
                if not os.path.isfile(abs_path):
                    missing.append(item.audio_file)
        return len(missing) == 0, missing

    @staticmethod
    def show_relocate_dialog(missing_files: List[str],
                             parent=None) -> Dict[str, str]:
        """
        显示缺失文件重新定位对话框。

        Args:
            missing_files: 缺失的文件路径列表
            parent: 父窗口

        Returns:
            dict: {原始路径: 新路径} 的映射
        """
        if not missing_files:
            return {}

        dialog = QDialog(parent)
        dialog.setWindowTitle("定位缺失的音频文件")
        dialog.setMinimumWidth(600)
        dialog.setMinimumHeight(400)
        dialog.setStyleSheet("""
            QDialog { background: #1e1e32; color: #eee; }
            QLabel { color: #ccc; }
            QPushButton { background: #0f3460; color: #eee; border: none;
                         border-radius: 4px; padding: 6px 16px; }
            QPushButton:hover { background: #1a4080; }
            QListWidget { background: #2a2a44; color: #eee;
                         border: 1px solid #555; border-radius: 4px; }
        """)

        layout = QVBoxLayout(dialog)
        layout.addWidget(QLabel(f"以下 {len(missing_files)} 个音频文件未找到，请逐个定位："))

        list_widget = QListWidget()
        for f in missing_files:
            item = QListWidgetItem(f"❌ {f}")
            item.setData(Qt.ItemDataRole.UserRole, f)
            list_widget.addItem(item)
        layout.addWidget(list_widget)

        btn_row = QHBoxLayout()

        browse_btn = QPushButton("浏览定位...")
        skip_btn = QPushButton("跳过此文件")
        cancel_btn = QPushButton("取消加载")

        btn_row.addWidget(browse_btn)
        btn_row.addWidget(skip_btn)
        btn_row.addStretch()
        btn_row.addWidget(cancel_btn)
        layout.addLayout(btn_row)

        result_map: Dict[str, str] = {}

        def on_browse():
            current = list_widget.currentItem()
            if not current:
                QMessageBox.information(dialog, "提示", "请先在列表中选择一个文件")
                return
            orig_path = current.data(Qt.ItemDataRole.UserRole)
            new_path, _ = QFileDialog.getOpenFileName(
                dialog, f"定位: {orig_path}", "",
                "音频文件 (*.mp3 *.wav *.ogg *.flac *.aac *.m4a);;所有文件 (*.*)"
            )
            if new_path:
                result_map[orig_path] = new_path
                current.setText(f"✅ {orig_path} → {os.path.basename(new_path)}")

        def on_skip():
            current = list_widget.currentItem()
            if not current:
                return
            orig_path = current.data(Qt.ItemDataRole.UserRole)
            if orig_path not in result_map:
                result_map[orig_path] = ""
            current.setText(f"⏭ {orig_path} (已跳过)")

        def on_cancel():
            dialog.reject()

        browse_btn.clicked.connect(on_browse)
        skip_btn.clicked.connect(on_skip)
        cancel_btn.clicked.connect(on_cancel)

        # 完成按钮
        finish_btn = QPushButton("完成定位")
        finish_btn.clicked.connect(dialog.accept)
        layout.addWidget(finish_btn)

        if dialog.exec() == QDialog.DialogCode.Accepted:
            return result_map
        return {}

    @staticmethod
    def default_project_dir() -> str:
        """返回默认项目保存目录"""
        music_dir = os.path.expanduser("~/Music")
        proj_dir = os.path.join(music_dir, "直播助手项目")
        os.makedirs(proj_dir, exist_ok=True)
        return proj_dir