"""
多轨音频编辑器 - 混音引擎

将所有轨道的音频混合为最终输出。
支持：音量/声像/淡入淡出/静音/独奏/主音量
"""

import math
from typing import List, Optional

import numpy as np

from track_item import AudioTrack, AudioItem, FadeType, generate_fade_envelope


class AudioMixer:
    """
    多轨混音引擎。

    将多个轨道的音频数据混合为单声道或立体声输出。
    """

    SAMPLE_RATE = 44100
    SAMPLE_WIDTH = 2  # 16-bit
    CHANNELS = 2      # 立体声

    def __init__(self, tracks: List[AudioTrack]):
        self.tracks = tracks
        self.master_volume = 1.0  # 0.0-2.0

    def mix(self, start_time: float = 0.0, duration: Optional[float] = None) -> 'pydub.AudioSegment':
        """
        混合所有轨道指定时间范围的音频。

        Args:
            start_time: 起始时间（秒）
            duration:   混合时长（秒），None 表示混合到项目结束

        Returns:
            pydub.AudioSegment: 混合后的音频
        """
        from pydub import AudioSegment

        if duration is None:
            duration = self._project_duration()

        if duration <= 0:
            return AudioSegment.silent(
                duration=100, frame_rate=self.SAMPLE_RATE
            )

        # 创建静音底轨
        mixed = AudioSegment.silent(
            duration=int(duration * 1000),
            frame_rate=self.SAMPLE_RATE,
        )

        has_solo = self._has_solo_track()

        for track in self.tracks:
            if track.muted:
                continue
            if has_solo and not track.solo:
                continue

            for item in track.items:
                if item.audio_data is None:
                    continue

                # 计算音频块在混合范围内的部分
                item_start = item.start_time
                item_end = item.start_time + item.duration

                if item_end <= start_time or item_start >= start_time + duration:
                    continue  # 不在范围内

                # 裁剪到混合范围
                local_start = max(0.0, start_time - item_start)
                local_end = min(item.duration, start_time + duration - item_start)
                clip_duration = local_end - local_start

                if clip_duration <= 0:
                    continue

                # 提取音频片段
                segment = item.audio_data[
                    int(local_start * 1000):int(local_end * 1000)
                ]

                # 应用淡入淡出（非破坏性，克隆后应用）
                segment = segment.copy()
                segment = self._apply_fades(segment, item, local_start, local_end)

                # 应用音量增益
                gain_db = self._volume_to_db(item.gain * track.volume, item.gain)
                if gain_db != 0:
                    segment = segment.apply_gain(gain_db)

                # 应用声像
                if track.pan != 0:
                    segment = self._apply_pan(segment, track.pan)

                # 计算在混音中的偏移量并叠加
                offset_ms = int((item.start_time - start_time) * 1000)
                mixed = mixed.overlay(segment, position=offset_ms)

        # 应用主音量
        if self.master_volume != 1.0:
            master_db = self._volume_to_db(self.master_volume)
            if master_db != 0:
                mixed = mixed.apply_gain(master_db)

        return mixed

    def _project_duration(self) -> float:
        """计算项目总时长（秒）"""
        if not self.tracks:
            return 0.0
        return max((t.duration for t in self.tracks), default=0.0)

    def _has_solo_track(self) -> bool:
        """检查是否有轨道启用了独奏"""
        return any(t.solo for t in self.tracks)

    def _apply_fades(self, segment, item: AudioItem, local_start: float,
                     local_end: float) -> 'pydub.AudioSegment':
        """在片段上应用淡入淡出"""
        # 淡入：如果包含淡入范围
        if item.fade_in_duration > 0 and local_start < item.fade_in_duration:
            fade_start = item.fade_in_duration
            overlap = min(fade_start - local_start, local_end - local_start)
            if overlap > 0:
                fade_samples = int(overlap * segment.frame_rate)
                envelope = generate_fade_envelope(
                    item.fade_in_type, fade_samples
                )
                raw = np.array(segment.get_array_of_samples(), dtype=np.float64)
                channels = segment.channels
                if channels > 1:
                    raw = raw.reshape(-1, channels)
                    for ch in range(channels):
                        offset = max(0, int(
                            (local_start - 0) * segment.frame_rate
                        ))
                        if offset < fade_samples:
                            raw[:fade_samples - offset, ch] *= envelope[offset:]
                    raw = raw.flatten()
                else:
                    raw[:fade_samples] *= envelope
                from pydub import AudioSegment
                segment = AudioSegment(
                    raw.astype(segment.array_type).tobytes(),
                    frame_rate=segment.frame_rate,
                    sample_width=segment.sample_width,
                    channels=channels,
                )

        # 淡出：如果包含淡出范围
        if item.fade_out_duration > 0 and local_end > item.duration - item.fade_out_duration:
            fade_start = item.duration - item.fade_out_duration
            overlap = min(local_end - fade_start, local_end - local_start)
            if overlap > 0:
                fade_samples = int(overlap * segment.frame_rate)
                envelope = generate_fade_envelope(
                    item.fade_out_type, fade_samples
                )[::-1]  # 反转：1→0
                raw = np.array(segment.get_array_of_samples(), dtype=np.float64)
                channels = segment.channels
                if channels > 1:
                    raw = raw.reshape(-1, channels)
                    for ch in range(channels):
                        start_idx = len(raw) - fade_samples
                        raw[start_idx:, ch] *= envelope
                    raw = raw.flatten()
                else:
                    start_idx = len(raw) - fade_samples
                    raw[start_idx:] *= envelope
                from pydub import AudioSegment
                segment = AudioSegment(
                    raw.astype(segment.array_type).tobytes(),
                    frame_rate=segment.frame_rate,
                    sample_width=segment.sample_width,
                    channels=channels,
                )

        return segment

    def _apply_pan(self, segment, pan: float) -> 'pydub.AudioSegment':
        """应用声像（立体声平移）"""
        if segment.channels < 2:
            return segment

        left = segment.split_to_mono()[0]
        right = segment.split_to_mono()[1]

        # pan: -1.0(全左) → 0.0(居中) → 1.0(全右)
        left_gain = self._volume_to_db(math.sqrt(1.0 - max(0, pan)))
        right_gain = self._volume_to_db(math.sqrt(1.0 - max(0, -pan)))

        if left_gain != 0:
            left = left.apply_gain(left_gain)
        if right_gain != 0:
            right = right.apply_gain(right_gain)

        from pydub import AudioSegment
        return AudioSegment.from_mono_audiosegments(left, right)

    @staticmethod
    def _volume_to_db(volume: float, gain: float = 1.0) -> float:
        """将音量值转为 dB 调整值"""
        total = volume * gain
        if total <= 0:
            return -60.0
        return 20.0 * math.log10(total)


# ═══════════════════════════════════════════════════════
# 便捷函数
# ═══════════════════════════════════════════════════════

def mix_tracks(tracks: List[AudioTrack], **kwargs) -> 'pydub.AudioSegment':
    """
    便捷函数：混合所有轨道。

    Args:
        tracks: 轨道列表
        **kwargs: 传递给 AudioMixer.mix 的参数

    Returns:
        pydub.AudioSegment: 混合后的音频
    """
    mixer = AudioMixer(tracks)
    return mixer.mix(**kwargs)