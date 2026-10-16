"""
配置管理模块

读写 config.json，管理所有可持久化的配置项。
"""

import os
import json
from pathlib import Path
from typing import Any, Optional


# ──────────────────────────────────────────────
# 默认配置
# ──────────────────────────────────────────────

DEFAULT_CONFIG_DIR = os.path.join(str(Path.home()), ".直播助手")
DEFAULT_CONFIG_PATH = os.path.join(DEFAULT_CONFIG_DIR, "config.json")

DEFAULT_CONFIG = {
    "lxmusic": {
        "enabled": True,
        "api_base": "http://localhost:3100",
        "default_source": "kw",
        "download_quality": "320k",
        "download_path": os.path.join(str(Path.home()), "Music", "乐界下载"),
        "auto_add_to_library": True,
        "timeout": 10,
        "max_concurrent_downloads": 3,
    },
    "audio": {
        "input_device": "",
        "output_device": "",
    },
    "remote": {
        "port": 1995,
        "enabled": True,
    },
    "general": {
        "theme": "dark",
        "language": "zh",
        "auto_start": False,
    },
}

# 平台映射
SOURCE_MAP = {
    "kw": "酷我",
    "kg": "酷狗",
    "tx": "QQ",
    "wy": "网易",
    "mg": "咪咕",
}

SOURCE_NAMES = list(SOURCE_MAP.keys())

QUALITY_OPTIONS = ["128k", "320k", "flac", "flac24bit"]


# ──────────────────────────────────────────────
# 配置管理器
# ──────────────────────────────────────────────

class Config:
    """配置管理器（单例模式）"""

    _instance = None

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self, config_path: Optional[str] = None):
        if hasattr(self, "_initialized") and self._initialized:
            return
        self._initialized = True

        self._config_path = config_path or DEFAULT_CONFIG_PATH
        self._data: dict = {}
        self._dirty = False
        self.load()

    # ── 读写 ────────────────────────────────────

    def load(self):
        """从文件加载配置"""
        try:
            if os.path.exists(self._config_path):
                with open(self._config_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                # 合并默认配置（保证新字段存在）
                self._data = self._deep_merge(DEFAULT_CONFIG.copy(), loaded)
            else:
                self._data = DEFAULT_CONFIG.copy()
                self.save()
        except (json.JSONDecodeError, OSError) as e:
            import logging
            logging.warning(f"配置文件加载失败，使用默认配置: {e}")
            self._data = DEFAULT_CONFIG.copy()

    def save(self):
        """保存配置到文件"""
        try:
            os.makedirs(os.path.dirname(self._config_path), exist_ok=True)
            with open(self._config_path, "w", encoding="utf-8") as f:
                json.dump(self._data, f, ensure_ascii=False, indent=2)
            self._dirty = False
        except OSError as e:
            import logging
            logging.error(f"配置文件保存失败: {e}")

    def save_if_dirty(self):
        """仅在变更时保存"""
        if self._dirty:
            self.save()

    # ── 取值 / 设值 ─────────────────────────────

    def get(self, key: str, default: Any = None) -> Any:
        """
        按点号分隔的路径取值，如 config.get("lxmusic.api_base")

        Returns:
            如果路径不存在返回 default
        """
        keys = key.split(".")
        val = self._data
        try:
            for k in keys:
                val = val[k]
            return val
        except (KeyError, TypeError):
            return default

    def set(self, key: str, value: Any):
        """
        按点号分隔的路径设值，如 config.set("lxmusic.api_base", "http://...")
        """
        keys = key.split(".")
        target = self._data
        for k in keys[:-1]:
            if k not in target or not isinstance(target[k], dict):
                target[k] = {}
            target = target[k]
        target[keys[-1]] = value
        self._dirty = True

    def set_batch(self, items: dict):
        """
        批量设置
        items: {"lxmusic.api_base": "http://...", "lxmusic.enabled": True}
        """
        for key, value in items.items():
            self.set(key, value)
        self.save()

    # ── 便捷方法 ---------------------------------

    def get_lxmusic_config(self) -> dict:
        """获取完整的洛雪音源配置"""
        return self.get("lxmusic", {})

    def reset(self, section: Optional[str] = None):
        """
        重置指定部分的配置为默认值
        section: 如 "lxmusic", "audio", None 表示全部重置
        """
        if section:
            if section in DEFAULT_CONFIG:
                self._data[section] = DEFAULT_CONFIG[section].copy()
        else:
            self._data = DEFAULT_CONFIG.copy()
        self._dirty = True
        self.save()

    # ── 内部 ────────────────────────────────────

    @staticmethod
    def _deep_merge(base: dict, override: dict) -> dict:
        """递归合并字典，保留 base 中但 override 中没有的字段"""
        result = base.copy()
        for key, val in override.items():
            if key in result and isinstance(result[key], dict) and isinstance(val, dict):
                result[key] = Config._deep_merge(result[key], val)
            else:
                result[key] = val
        return result


# ── 全局单例 ──────────────────────────────────

_config: Optional[Config] = None


def get_config() -> Config:
    """获取全局配置单例"""
    global _config
    if _config is None:
        _config = Config()
    return _config


def init_config(config_path: Optional[str] = None) -> Config:
    """初始化配置（应用启动时调用）"""
    global _config
    _config = Config(config_path=config_path)
    return _config