"""
异步下载管理器

功能：
- 下载队列，最大并发控制
- 暂停/恢复/取消单个任务
- 全部暂停/全部开始
- 下载完成后写入元数据（歌名、歌手、专辑、封面）
- 进度通过 PyQt6 信号实时通知 UI
- 文件已存在自动跳过
"""

import os
import re
import time
import asyncio
import tempfile
from pathlib import Path
from enum import Enum
from typing import Optional, Callable

import aiohttp
import aiofiles
from mutagen import File as MutagenFile
from mutagen.id3 import ID3, TIT2, TPE1, TALB, APIC, error as MutagenID3Error
from mutagen.mp4 import MP4, MP4Cover
from mutagen.flac import FLAC, Picture

from PyQt6.QtCore import QObject, pyqtSignal


# ──────────────────────────────────────────────
# 状态枚举
# ──────────────────────────────────────────────

class DownloadStatus(Enum):
    WAITING = "等待"
    DOWNLOADING = "下载中"
    PAUSED = "已暂停"
    COMPLETED = "已完成"
    FAILED = "失败"
    CANCELLED = "已取消"
    SKIPPED = "已跳过（文件已存在）"


# ──────────────────────────────────────────────
# 任务模型
# ──────────────────────────────────────────────

class DownloadTask:
    """单个下载任务"""

    def __init__(
        self,
        song_id: str,
        song_name: str,
        singer: str,
        album: str,
        cover_url: str,
        url: str,
        quality: str,
        save_dir: str,
        duration: int = 0,
    ):
        self.song_id = song_id
        self.song_name = song_name
        self.singer = singer
        self.album = album
        self.cover_url = cover_url
        self.url = url
        self.quality = quality
        self.save_dir = save_dir
        self.duration = duration  # 秒

        self.status = DownloadStatus.WAITING
        self.progress = 0.0       # 0.0 ~ 1.0
        self.speed = 0.0          # 字节/秒
        self.remaining = 0.0      # 剩余秒数
        self.downloaded_bytes = 0
        self.total_bytes = 0
        self.file_path: Optional[str] = None
        self.error_msg: Optional[str] = None

        # 内部控制
        self._paused = False
        self._cancelled = False
        self._start_time = 0.0

    @property
    def filename(self) -> str:
        """生成文件名：{歌手} - {歌名}.{扩展名}"""
        ext_map = {"128k": "mp3", "320k": "mp3", "flac": "flac", "flac24bit": "flac"}
        ext = ext_map.get(self.quality, "mp3")
        name = f"{self.singer} - {self.song_name}"
        name = _sanitize_filename(name)
        return f"{name}.{ext}"

    @property
    def save_path(self) -> str:
        return os.path.join(self.save_dir, self.filename)

    def pause(self):
        self._paused = True

    def resume(self):
        self._paused = False

    def cancel(self):
        self._cancelled = True


# ──────────────────────────────────────────────
# 工具函数
# ──────────────────────────────────────────────

def _sanitize_filename(name: str) -> str:
    """去除文件名中的非法字符"""
    # Windows 非法字符: \ / : * ? " < > |
    name = re.sub(r'[\\/:*?"<>|]', "_", name)
    name = name.strip().rstrip(". ")
    return name or "未知歌曲"


def _ext_from_url(url: str, quality: str) -> str:
    """从 URL 推断扩展名，兜底用 quality 判断"""
    _, ext = os.path.splitext(url.split("?")[0].split("#")[0])
    if ext and len(ext) <= 5:
        return ext.lstrip(".")
    return "mp3" if quality in ("128k", "320k") else "flac"


# ──────────────────────────────────────────────
# 封面下载辅助
# ──────────────────────────────────────────────

async def _download_cover(session: aiohttp.ClientSession, url: str) -> Optional[bytes]:
    """下载封面图片，返回二进制数据"""
    if not url:
        return None
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status == 200:
                return await resp.read()
    except Exception:
        pass
    return None


# ──────────────────────────────────────────────
# 元数据写入
# ──────────────────────────────────────────────

def _write_metadata(file_path: str, task: DownloadTask, cover_data: Optional[bytes] = None):
    """
    写入音频元数据（歌名、歌手、专辑、封面）
    支持 MP3 (ID3v2)、M4A (MP4)、FLAC
    """
    ext = os.path.splitext(file_path)[1].lower()
    try:
        if ext == ".mp3":
            _write_id3(file_path, task, cover_data)
        elif ext == ".m4a" or ext == ".mp4":
            _write_mp4(file_path, task, cover_data)
        elif ext == ".flac":
            _write_flac(file_path, task, cover_data)
    except Exception as e:
        # 元数据写入失败不应阻断下载流程
        import logging
        logging.warning(f"写入元数据失败: {file_path} - {e}")


def _write_id3(file_path: str, task: DownloadTask, cover_data: Optional[bytes]):
    """写入 MP3 ID3v2 标签"""
    try:
        audio = ID3(file_path)
    except MutagenID3Error:
        audio = ID3()

    audio["TIT2"] = TIT2(encoding=3, text=task.song_name)
    audio["TPE1"] = TPE1(encoding=3, text=task.singer)
    audio["TALB"] = TALB(encoding=3, text=task.album)

    if cover_data:
        audio["APIC"] = APIC(
            encoding=3,
            mime="image/jpeg",
            type=3,  # 封面
            desc="Cover",
            data=cover_data,
        )

    audio.save(file_path, v2_version=3)


def _write_mp4(file_path: str, task: DownloadTask, cover_data: Optional[bytes]):
    """写入 M4A/MP4 元数据"""
    try:
        audio = MP4(file_path)
    except Exception:
        audio = MP4()

    audio["\xa9nam"] = task.song_name
    audio["\xa9ART"] = task.singer
    audio["\xa9alb"] = task.album

    if cover_data:
        cover_format = MP4Cover.FORMAT_JPEG if cover_data[:4] == b"\xff\xd8\xff" else MP4Cover.FORMAT_PNG
        audio["covr"] = [MP4Cover(cover_data, cover_format)]

    audio.save()


def _write_flac(file_path: str, task: DownloadTask, cover_data: Optional[bytes]):
    """写入 FLAC 元数据"""
    try:
        audio = FLAC(file_path)
    except Exception:
        audio = FLAC()

    audio["title"] = task.song_name
    audio["artist"] = task.singer
    audio["album"] = task.album

    if cover_data:
        pic = Picture()
        pic.type = 3
        pic.mime = "image/jpeg" if cover_data[:4] == b"\xff\xd8\xff" else "image/png"
        pic.desc = "Cover"
        pic.data = cover_data
        pic.width = 0
        pic.height = 0
        pic.depth = 0
        pic.colors = 0
        audio.add_picture(pic)

    audio.save()


# ──────────────────────────────────────────────
# 下载管理器
# ──────────────────────────────────────────────

class DownloadManager(QObject):
    """
    异步下载管理器

    信号:
        download_progress(song_id, progress, speed, remaining)
        download_finished(song_id, file_path)
        download_error(song_id, error_msg)
        download_status_changed(song_id, status)
    """

    download_progress = pyqtSignal(str, float, float, float)  # id, progress(0~1), speed(B/s), remaining(s)
    download_finished = pyqtSignal(str, str)                   # id, file_path
    download_error = pyqtSignal(str, str)                      # id, error_msg
    download_status_changed = pyqtSignal(str, object)          # id, DownloadStatus

    def __init__(self, max_concurrent: int = 3, parent=None):
        super().__init__(parent)
        self.max_concurrent = max_concurrent

        # 所有任务 key=song_id
        self._tasks: dict[str, DownloadTask] = {}

        # 等待队列（FIFO）
        self._queue: list[str] = []

        # 当前正在下载的 ID 集合
        self._active: set[str] = set()

        # 是否全部暂停
        self._all_paused = False

        # 事件循环
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._worker_task: Optional[asyncio.Task] = None

        # 会话
        self._session: Optional[aiohttp.ClientSession] = None

    # ── 公开方法 ────────────────────────────────

    def add_task(self, task: DownloadTask):
        """
        添加下载任务

        如果文件已存在则自动跳过。
        """
        if task.song_id in self._tasks:
            return

        # 检查文件是否已存在
        if os.path.exists(task.save_path):
            task.status = DownloadStatus.SKIPPED
            task.file_path = task.save_path
            self._tasks[task.song_id] = task
            self.download_status_changed.emit(task.song_id, task.status)
            self.download_finished.emit(task.song_id, task.save_path)
            return

        task.status = DownloadStatus.WAITING
        self._tasks[task.song_id] = task
        self._queue.append(task.song_id)
        self.download_status_changed.emit(task.song_id, task.status)

        self._ensure_running()

    def pause_task(self, song_id: str):
        """暂停单个任务"""
        task = self._tasks.get(song_id)
        if task and task.status == DownloadStatus.DOWNLOADING:
            task.pause()
            task.status = DownloadStatus.PAUSED
            self.download_status_changed.emit(song_id, task.status)

    def resume_task(self, song_id: str):
        """恢复单个任务"""
        task = self._tasks.get(song_id)
        if task and task.status == DownloadStatus.PAUSED:
            task.resume()
            task.status = DownloadStatus.WAITING
            self.download_status_changed.emit(song_id, task.status)
            if song_id not in self._queue and song_id not in self._active:
                self._queue.append(song_id)
            self._ensure_running()

    def cancel_task(self, song_id: str):
        """取消单个任务"""
        task = self._tasks.get(song_id)
        if not task:
            return
        task.cancel()
        task.status = DownloadStatus.CANCELLED
        # 清理临时文件
        if task.file_path and os.path.exists(task.file_path):
            try:
                os.remove(task.file_path)
            except OSError:
                pass
        self.download_status_changed.emit(song_id, task.status)

    def pause_all(self):
        """暂停所有任务"""
        self._all_paused = True
        for song_id in list(self._active):
            self.pause_task(song_id)

    def resume_all(self):
        """恢复所有暂停的任务"""
        self._all_paused = False
        for song_id, task in self._tasks.items():
            if task.status == DownloadStatus.PAUSED:
                task.resume()
                task.status = DownloadStatus.WAITING
                self.download_status_changed.emit(song_id, task.status)
                if song_id not in self._queue and song_id not in self._active:
                    self._queue.append(song_id)
        self._ensure_running()

    def get_task(self, song_id: str) -> Optional[DownloadTask]:
        return self._tasks.get(song_id)

    def get_all_tasks(self) -> list[DownloadTask]:
        return list(self._tasks.values())

    def get_active_count(self) -> int:
        return len(self._active)

    def get_queue_count(self) -> int:
        return len(self._queue)

    def shutdown(self):
        """关闭管理器，取消所有任务"""
        if self._worker_task and not self._worker_task.done():
            self._worker_task.cancel()
        if self._session and not self._session.closed:
            asyncio.ensure_future(self._session.close(), loop=self._loop)

    # ── 内部逻辑 ────────────────────────────────

    def _ensure_running(self):
        """确保工作协程在运行"""
        if self._worker_task is None or self._worker_task.done():
            try:
                self._loop = asyncio.get_running_loop()
            except RuntimeError:
                self._loop = asyncio.new_event_loop()
                asyncio.set_event_loop(self._loop)

            self._worker_task = asyncio.ensure_future(self._worker(), loop=self._loop)

    async def _worker(self):
        """工作协程：从队列中取任务，并发执行"""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers={"User-Agent": "DownloadManager/1.0"},
                timeout=aiohttp.ClientTimeout(total=30),
            )

        while True:
            # 检查是否全部暂停
            if self._all_paused:
                await asyncio.sleep(0.5)
                continue

            # 检查并发数
            while len(self._active) < self.max_concurrent and self._queue:
                song_id = self._queue.pop(0)
                task = self._tasks.get(song_id)
                if task and task.status == DownloadStatus.WAITING and not task._cancelled:
                    self._active.add(song_id)
                    asyncio.ensure_future(self._download_one(song_id), loop=self._loop)
                elif task and task.status == DownloadStatus.CANCELLED:
                    continue  # 已被取消，跳过

            if not self._active and not self._queue:
                # 所有任务完成
                break

            await asyncio.sleep(0.1)

    async def _download_one(self, song_id: str):
        """下载单个文件"""
        task = self._tasks[song_id]
        task.status = DownloadStatus.DOWNLOADING
        task._start_time = time.time()
        task.downloaded_bytes = 0
        task.progress = 0.0

        self.download_status_changed.emit(song_id, task.status)

        temp_path = None
        try:
            # 准备目录
            os.makedirs(task.save_dir, exist_ok=True)

            # 临时文件
            fd, temp_path = tempfile.mkstemp(
                suffix=".tmp",
                prefix=os.path.basename(task.filename) + ".",
                dir=task.save_dir,
            )
            os.close(fd)

            # 开始下载
            async with self._session.get(task.url) as resp:
                resp.raise_for_status()
                task.total_bytes = int(resp.headers.get("Content-Length", 0))

                async with aiofiles.open(temp_path, "wb") as f:
                    last_report = time.time()
                    last_bytes = 0

                    async for chunk in resp.content.iter_chunked(8192):
                        # 检查取消/暂停
                        while task._paused and not task._cancelled:
                            await asyncio.sleep(0.2)
                        if task._cancelled:
                            break

                        await f.write(chunk)
                        task.downloaded_bytes += len(chunk)

                        if task.total_bytes > 0:
                            task.progress = task.downloaded_bytes / task.total_bytes
                        else:
                            task.progress = 0.0

                        # 每 200ms 更新一次进度
                        now = time.time()
                        elapsed = now - last_report
                        if elapsed >= 0.2:
                            bytes_delta = task.downloaded_bytes - last_bytes
                            task.speed = bytes_delta / elapsed if elapsed > 0 else 0
                            if task.speed > 0 and task.total_bytes > 0:
                                remaining_bytes = task.total_bytes - task.downloaded_bytes
                                task.remaining = remaining_bytes / task.speed
                            else:
                                task.remaining = 0.0

                            self.download_progress.emit(
                                song_id, task.progress, task.speed, task.remaining
                            )

                            last_report = now
                            last_bytes = task.downloaded_bytes

                if task._cancelled:
                    return

            # 下载完成 → 重命名
            final_path = task.save_path
            # 再次检查最终文件是否存在（可能在下载过程中被创建）
            if os.path.exists(final_path):
                os.remove(temp_path)
                task.file_path = final_path
                task.status = DownloadStatus.SKIPPED
                self.download_status_changed.emit(song_id, task.status)
                self.download_finished.emit(song_id, final_path)
                return

            os.replace(temp_path, final_path)
            task.file_path = final_path

            # 下载封面并写入元数据
            cover_data = await _download_cover(self._session, task.cover_url)
            _write_metadata(final_path, task, cover_data)

            task.progress = 1.0
            task.status = DownloadStatus.COMPLETED
            self.download_progress.emit(song_id, 1.0, 0.0, 0.0)
            self.download_status_changed.emit(song_id, task.status)
            self.download_finished.emit(song_id, final_path)

        except asyncio.CancelledError:
            raise
        except Exception as e:
            task.status = DownloadStatus.FAILED
            task.error_msg = str(e)
            self.download_error.emit(song_id, str(e))
            self.download_status_changed.emit(song_id, task.status)
            # 清理临时文件
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass
        finally:
            self._active.discard(song_id)