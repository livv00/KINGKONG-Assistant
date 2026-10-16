"""
洛雪音乐在线搜索客户端

对接 lx-music-source 项目 (https://github.com/lxmusics/lx-music-source)
提供统一的在线音乐搜索、获取直链接口。
"""

import json
import time
import requests
from typing import Optional


# ──────────────────────────────────────────────
# 自定义异常
# ──────────────────────────────────────────────

class LxMusicError(Exception):
    """洛雪音乐 API 通用异常"""
    def __init__(self, message: str, code: int = -1, data=None):
        super().__init__(message)
        self.code = code
        self.data = data


class LxMusicParamError(LxMusicError):
    """参数错误 (HTTP 400)"""
    def __init__(self, message="请求参数错误", data=None):
        super().__init__(message, code=400, data=data)


class LxMusicServerError(LxMusicError):
    """服务器错误 (HTTP 500)"""
    def __init__(self, message="服务器内部错误", data=None):
        super().__init__(message, code=500, data=data)


class LxMusicSourceUnavailableError(LxMusicError):
    """音源不可用 (HTTP 502)"""
    def __init__(self, message="音源不可用，请尝试其他平台", data=None):
        super().__init__(message, code=502, data=data)


# ──────────────────────────────────────────────
# 平台映射
# ──────────────────────────────────────────────

SOURCE_MAP = {
    "kw": "酷我",
    "kg": "酷狗",
    "tx": "QQ",
    "wy": "网易",
    "mg": "咪咕",
}

SOURCE_NAMES = list(SOURCE_MAP.keys())


# ──────────────────────────────────────────────
# 客户端
# ──────────────────────────────────────────────

class LxMusicClient:
    """
    洛雪音乐搜索客户端

    用法:
        client = LxMusicClient(api_base="http://localhost:3100", timeout=10)
        result = client.search("周杰伦", source="kw", page=1, limit=30)
        url = client.get_music_url("kw", {"hash": "xxx"}, "320k")
    """

    def __init__(
        self,
        api_base: str = "http://localhost:3100",
        timeout: int = 10,
        max_retries: int = 1,
    ):
        """
        Args:
            api_base:  lx-music-source 服务地址
            timeout:   请求超时（秒）
            max_retries: 失败重试次数（仅针对可恢复的网络错误）
        """
        self.api_base = api_base.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries

        # 复用 Session，保持连接池
        self._session = requests.Session()
        self._session.headers.update({
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "LxMusicClient/1.0",
        })

        # 适配器：设置连接池大小 & 重试
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=10,
            pool_maxsize=20,
            max_retries=0,  # 我们自己控制重试
        )
        self._session.mount("http://", adapter)
        self._session.mount("https://", adapter)

    # ── 公开方法 ────────────────────────────────

    def search(
        self,
        keyword: str,
        source: str = "kw",
        page: int = 1,
        limit: int = 30,
    ) -> dict:
        """
        搜索歌曲

        Args:
            keyword: 搜索关键词
            source:  平台代号 (kw/kg/tx/wy/mg)
            page:    页码（从1开始）
            limit:   每页条数

        Returns:
            {
                "source": "kw",
                "list": [ ... ],   # 歌曲列表
                "total": 50,
                "limit": 30,
                "page": 1,
            }

        Raises:
            LxMusicParamError:           参数错误
            LxMusicServerError:          服务器内部错误
            LxMusicSourceUnavailableError: 音源不可用
            LxMusicError:                其他 API 错误
            requests.RequestException:   网络错误
        """
        if not keyword or not keyword.strip():
            raise LxMusicParamError("搜索关键词不能为空")

        if source not in SOURCE_MAP:
            valid = ", ".join(SOURCE_MAP.keys())
            raise LxMusicParamError(f"不支持的平台 '{source}'，可选: {valid}")

        payload = {
            "source": source,
            "keyword": keyword.strip(),
            "page": max(1, page),
            "limit": max(1, min(100, limit)),
        }

        return self._request("POST", "/search", json=payload)

    def get_music_url(
        self,
        source: str,
        music_info: dict,
        quality: str = "320k",
    ) -> str:
        """
        获取歌曲直链（下载/试听用）

        Args:
            source:     平台代号
            music_info: 歌曲标识信息，至少包含 hash 或 songmid
                        {"hash": "xxx"}          # tx/wy/kw
                        {"songmid": "xxx"}       # kg/mg
                        {"hash": "xxx", "songmid": "xxx"}  # 同时提供
            quality:    音质 (128k / 320k / flac)

        Returns:
            直链 URL 字符串

        Raises:
            同 search()
        """
        if source not in SOURCE_MAP:
            valid = ", ".join(SOURCE_MAP.keys())
            raise LxMusicParamError(f"不支持的平台 '{source}'，可选: {valid}")

        if not music_info:
            raise LxMusicParamError("music_info 不能为空")

        payload = {
            "source": source,
            "musicInfo": music_info,
            "type": quality,
        }

        data = self._request("POST", "/musicUrl", json=payload)
        return data.get("url", "")

    def check_health(self) -> bool:
        """
        检查服务是否可用
        直接访问 api_base 根路径，如果返回非空内容则认为可用
        """
        try:
            resp = self._session.get(
                self.api_base,
                timeout=max(3, self.timeout // 2),
            )
            return resp.status_code < 500
        except requests.RequestException:
            return False

    def close(self):
        """关闭会话，释放连接"""
        self._session.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    # ── 内部请求 ────────────────────────────────

    def _request(self, method: str, path: str, **kwargs) -> dict:
        """
        发送请求，统一处理错误码和重试

        Returns:
            API 返回的 data 字段内容 (dict)

        Raises:
            各类 LxMusicError / requests.RequestException
        """
        url = self.api_base + path
        kwargs.setdefault("timeout", self.timeout)

        last_error = None

        for attempt in range(self.max_retries + 1):
            try:
                resp = self._session.request(method, url, **kwargs)
            except requests.Timeout as e:
                last_error = LxMusicError(
                    f"请求超时 ({self.timeout}s): {path}",
                    code=-1,
                )
                if attempt < self.max_retries:
                    time.sleep(0.5 * (attempt + 1))
                    continue
                raise last_error from e
            except requests.ConnectionError as e:
                last_error = LxMusicError(
                    f"无法连接到服务: {self.api_base}，请确认 lx-music-source 已启动",
                    code=-1,
                )
                if attempt < self.max_retries:
                    time.sleep(1.0 * (attempt + 1))
                    continue
                raise last_error from e
            except requests.RequestException as e:
                raise LxMusicError(f"网络请求失败: {e}", code=-1) from e

            # ── 解析响应 ──
            try:
                body = resp.json()
            except json.JSONDecodeError as e:
                raise LxMusicError(
                    f"响应不是有效的 JSON: {resp.text[:200]}",
                    code=resp.status_code,
                ) from e

            # ── 检查业务码 ──
            code = body.get("code", -1)
            if code == 200:
                return body.get("data", {})

            # 错误码映射
            err_map = {
                400: LxMusicParamError,
                500: LxMusicServerError,
                502: LxMusicSourceUnavailableError,
            }

            err_cls = err_map.get(code, LxMusicError)
            msg = body.get("msg") or body.get("message") or err_cls.__doc__ or "未知错误"
            raise err_cls(msg, data=body)

        # 如果重试耗尽仍未 return，抛出最后一个错误
        raise last_error or LxMusicError("请求失败（重试耗尽）")

    # ── 工具方法 ────────────────────────────────

    @staticmethod
    def format_duration(seconds: int) -> str:
        """
        将秒数格式化为 mm:ss
        """
        if not seconds or seconds < 0:
            return "00:00"
        m, s = divmod(int(seconds), 60)
        return f"{m:02d}:{s:02d}"

    @staticmethod
    def best_quality(qualities: dict) -> str:
        """
        从 quality 字典中选取最高音质
        quality 示例: {"128k": {...}, "320k": {...}, "flac": {...}}

        Returns:
            "flac" / "320k" / "128k" / ""
        """
        if not qualities:
            return ""
        for q in ("flac", "320k", "128k"):
            if q in qualities:
                return q
        return ""

    @staticmethod
    def quality_label(quality_key: str) -> str:
        """
        音质键转显示标签
        """
        labels = {
            "flac": "无损",
            "320k": "高品",
            "128k": "标准",
            "flac24bit": "Hi-Res",
        }
        return labels.get(quality_key, quality_key)

    @staticmethod
    def quality_size(qualities: dict, quality_key: str) -> str:
        """
        获取指定音质的文件大小
        """
        q = qualities.get(quality_key, {})
        return q.get("size", "")


# ──────────────────────────────────────────────
# Listen1 备用音源 Provider
# ──────────────────────────────────────────────

class BaseListen1Provider:
    """
    Listen1 备用音源基类。

    与 LxMusicClient 接口保持一致：
        - search(keyword, source, page, limit) -> dict
        - get_music_url(source, music_info, quality) -> str

    子类需实现 _do_search / _do_get_url。
    """

    # 子类覆盖：该 provider 支持的平台代号
    SUPPORTED_SOURCE = ""

    def __init__(self, timeout: int = 10):
        self.timeout = timeout
        self._session = requests.Session()
        self._session.headers.update({
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
        })

    # ── 公开接口（与 LxMusicClient 一致）──────

    def search(self, keyword: str, source: str = "", page: int = 1, limit: int = 30) -> dict:
        if not keyword or not keyword.strip():
            raise LxMusicParamError("搜索关键词不能为空")
        try:
            return self._do_search(keyword.strip(), page, limit)
        except LxMusicError:
            raise
        except requests.RequestException as e:
            raise LxMusicError(f"Listen1 搜索网络错误: {e}", code=-1) from e
        except Exception as e:
            raise LxMusicError(f"Listen1 搜索失败: {e}", code=502) from e

    def get_music_url(self, source: str, music_info: dict, quality: str = "320k") -> str:
        if not music_info:
            raise LxMusicParamError("music_info 不能为空")
        song_id = str(music_info.get("hash") or music_info.get("songmid") or "")
        if not song_id:
            raise LxMusicParamError("music_info 缺少 hash/songmid")
        try:
            return self._do_get_url(song_id, quality)
        except LxMusicError:
            raise
        except requests.RequestException as e:
            raise LxMusicError(f"Listen1 直链网络错误: {e}", code=-1) from e
        except Exception as e:
            raise LxMusicError(f"Listen1 获取直链失败: {e}", code=502) from e

    # ── 子类实现 ───────────────────────────────

    def _do_search(self, keyword: str, page: int, limit: int) -> dict:
        raise NotImplementedError

    def _do_get_url(self, song_id: str, quality: str) -> str:
        raise NotImplementedError

    def close(self):
        self._session.close()


class NeteaseMusicProvider(BaseListen1Provider):
    """
    Listen1 网易云音乐 Provider（备用音源）。

    搜索: POST https://music.163.com/api/search/pc
          Body: s=关键词&type=1&offset=0&limit=30
    直链: POST https://music.163.com/api/song/enhance/player/url
          Body: ids=[歌曲ID]&br=320000
    """

    SUPPORTED_SOURCE = "wy"

    SEARCH_URL = "https://music.163.com/api/search/pc"
    URL_API = "https://music.163.com/api/song/enhance/player/url"

    # 音质 → 码率映射
    QUALITY_BR = {
        "128k": 128000,
        "320k": 320000,
        "flac": 999000,
    }

    def _do_search(self, keyword: str, page: int, limit: int) -> dict:
        offset = (page - 1) * limit
        data = {
            "s": keyword,
            "type": 1,
            "offset": offset,
            "limit": limit,
        }
        resp = self._session.post(
            self.SEARCH_URL,
            data=data,
            timeout=self.timeout,
            headers={"Referer": "https://music.163.com"},
        )
        body = resp.json()
        if body.get("code") != 200:
            raise LxMusicSourceUnavailableError(
                f"Listen1 网易云搜索失败: code={body.get('code')}"
            )

        songs = (body.get("result") or {}).get("songs") or []
        song_list = []
        for song in songs:
            duration_ms = song.get("duration") or 0
            duration_sec = int(duration_ms / 1000)
            artists = song.get("artists") or []
            album = song.get("album") or {}
            song_id = str(song.get("id", ""))
            song_list.append({
                "name": song.get("name", ""),
                "singer": " / ".join(a.get("name", "") for a in artists),
                "album": album.get("name", ""),
                "duration": duration_sec,
                "interval": LxMusicClient.format_duration(duration_sec),
                "img": "",
                "hash": song_id,
                "songmid": song_id,
                "quality": {"128k": {}, "320k": {}},
            })

        total = (body.get("result") or {}).get("songCount") or len(song_list)
        return {
            "source": self.SUPPORTED_SOURCE,
            "list": song_list,
            "total": total,
            "limit": limit,
            "page": page,
        }

    def _do_get_url(self, song_id: str, quality: str) -> str:
        br = self.QUALITY_BR.get(quality, 320000)
        data = {
            "ids": f"[{song_id}]",
            "br": br,
        }
        resp = self._session.post(
            self.URL_API,
            data=data,
            timeout=self.timeout,
            headers={
                "Referer": "https://music.163.com",
                "Cookie": "MUSIC_U=00",
            },
        )
        body = resp.json()
        if body.get("code") != 200:
            raise LxMusicSourceUnavailableError(
                f"Listen1 网易云直链失败: code={body.get('code')}"
            )

        data_list = body.get("data") or []
        if not data_list:
            raise LxMusicSourceUnavailableError("Listen1 网易云直链为空（可能需要 VIP）")

        url = data_list[0].get("url")
        if not url:
            # 高音质失败时自动降级到 128k
            if quality != "128k":
                return self._do_get_url(song_id, "128k")
            raise LxMusicSourceUnavailableError("Listen1 网易云直链为空（可能需要 VIP）")

        # 统一转 https，避免混合内容问题
        if url.startswith("http://"):
            url = "https://" + url[len("http://"):]
        return url


# ──────────────────────────────────────────────
# Listen1 Provider 注册表
# ──────────────────────────────────────────────

def _build_listen1_providers(timeout: int = 10) -> dict:
    """
    构建 source → Listen1 Provider 的映射。
    目前仅实现网易云，后续可扩展其他平台。
    """
    return {
        "wy": NeteaseMusicProvider(timeout=timeout),
    }


# ──────────────────────────────────────────────
# 统一客户端：洛雪为主，Listen1 为备
# ──────────────────────────────────────────────

class UnifiedMusicClient:
    """
    统一音乐客户端。

    策略：优先使用洛雪 (LxMusicClient → api-server.js)，
    当洛雪某平台失败时，自动降级到 Listen1 对应平台的 Provider。

    用法与 LxMusicClient 完全一致:
        client = UnifiedMusicClient(api_base="http://localhost:3100")
        result = client.search("周杰伦", source="wy")
        url = client.get_music_url("wy", {"hash": "123"}, "320k")
    """

    def __init__(
        self,
        api_base: str = "http://localhost:3100",
        timeout: int = 10,
        max_retries: int = 1,
        enable_fallback: bool = True,
    ):
        self.primary = LxMusicClient(
            api_base=api_base,
            timeout=timeout,
            max_retries=max_retries,
        )
        self.enable_fallback = enable_fallback
        self._fallback_providers = _build_listen1_providers(timeout) if enable_fallback else {}

    def search(self, keyword: str, source: str = "kw", page: int = 1, limit: int = 30) -> dict:
        try:
            return self.primary.search(keyword, source, page, limit)
        except (LxMusicError, requests.RequestException) as e:
            provider = self._fallback_providers.get(source)
            if provider:
                return provider.search(keyword, source, page, limit)
            raise

    def get_music_url(self, source: str, music_info: dict, quality: str = "320k") -> str:
        try:
            return self.primary.get_music_url(source, music_info, quality)
        except (LxMusicError, requests.RequestException) as e:
            provider = self._fallback_providers.get(source)
            if provider:
                return provider.get_music_url(source, music_info, quality)
            raise

    def check_health(self) -> bool:
        return self.primary.check_health()

    def close(self):
        self.primary.close()
        for p in self._fallback_providers.values():
            try:
                p.close()
            except Exception:
                pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()


# ──────────────────────────────────────────────
# 快捷入口
# ──────────────────────────────────────────────

def create_client(config: Optional[dict] = None) -> UnifiedMusicClient:
    """
    从配置字典创建统一客户端（洛雪为主，Listen1 为备）

    Args:
        config: 配置字典，如:
                {
                    "api_base": "http://localhost:3100",
                    "timeout": 10,
                    "max_concurrent_downloads": 3,
                    "enable_fallback": True,
                }
                传入 None 则使用默认值

    Returns:
        UnifiedMusicClient 实例
    """
    cfg = config or {}
    return UnifiedMusicClient(
        api_base=cfg.get("api_base", "http://localhost:3100"),
        timeout=cfg.get("timeout", 10),
        max_retries=1,
        enable_fallback=cfg.get("enable_fallback", True),
    )