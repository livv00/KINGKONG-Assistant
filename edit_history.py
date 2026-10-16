"""
多轨音频编辑器 - 撤销/重做系统

支持的操作类型：
  - move_item     移动音频块
  - split_item    分割音频块
  - delete_item   删除音频块
  - add_item      添加音频块
  - adjust_fade   调整淡入淡出
  - change_volume 调整音量
  - change_pan    调整声像
  - trim_item     裁剪音频块
  - merge_items   合并音频块
"""

import time
import copy
from enum import Enum
from typing import Optional, List, Dict, Any


class ActionType(str, Enum):
    """操作类型枚举"""
    MOVE_ITEM = "move_item"
    SPLIT_ITEM = "split_item"
    DELETE_ITEM = "delete_item"
    ADD_ITEM = "add_item"
    ADJUST_FADE = "adjust_fade"
    CHANGE_VOLUME = "change_volume"
    CHANGE_PAN = "change_pan"
    TRIM_ITEM = "trim_item"
    MERGE_ITEMS = "merge_items"


class EditHistory:
    """
    多轨编辑器操作历史。

    用法:
        history = EditHistory(max_steps=100)
        history.record_action(ActionType.MOVE_ITEM, {...})
        action = history.undo()  # 返回操作信息或 None
        action = history.redo()  # 返回操作信息或 None
    """

    def __init__(self, max_steps: int = 100):
        self.undo_stack: List[Dict[str, Any]] = []
        self.redo_stack: List[Dict[str, Any]] = []
        self.max_steps = max_steps

    def record_action(self, action_type: ActionType, data: dict):
        """
        记录操作。

        Args:
            action_type: 操作类型
            data: 包含足够信息以撤销操作的数据字典
        """
        self.undo_stack.append({
            'type': action_type,
            'data': copy.deepcopy(data),
            'timestamp': time.time(),
        })
        self.redo_stack.clear()

        # 限制最大步数
        if len(self.undo_stack) > self.max_steps:
            self.undo_stack.pop(0)

    def undo(self) -> Optional[dict]:
        """
        撤销，返回需要恢复的操作信息。

        Returns:
            dict 或 None: 包含 'type' 和 'data' 的操作信息
        """
        if not self.undo_stack:
            return None
        action = self.undo_stack.pop()
        self.redo_stack.append(action)
        return copy.deepcopy(action)

    def redo(self) -> Optional[dict]:
        """
        重做，返回需要恢复的操作信息。

        Returns:
            dict 或 None: 包含 'type' 和 'data' 的操作信息
        """
        if not self.redo_stack:
            return None
        action = self.redo_stack.pop()
        self.undo_stack.append(action)
        return copy.deepcopy(action)

    @property
    def can_undo(self) -> bool:
        return len(self.undo_stack) > 0

    @property
    def can_redo(self) -> bool:
        return len(self.redo_stack) > 0

    def clear(self):
        """清空所有历史"""
        self.undo_stack.clear()
        self.redo_stack.clear()

    def undo_description(self) -> str:
        """返回下一次撤销操作的描述"""
        if not self.undo_stack:
            return ""
        action = self.undo_stack[-1]
        return self._describe_action(action)

    def redo_description(self) -> str:
        """返回下一次重做操作的描述"""
        if not self.redo_stack:
            return ""
        action = self.redo_stack[-1]
        return self._describe_action(action)

    @staticmethod
    def _describe_action(action: dict) -> str:
        """生成操作的人类可读描述"""
        type_map = {
            ActionType.MOVE_ITEM: "移动音频块",
            ActionType.SPLIT_ITEM: "分割音频块",
            ActionType.DELETE_ITEM: "删除音频块",
            ActionType.ADD_ITEM: "添加音频块",
            ActionType.ADJUST_FADE: "调整淡入淡出",
            ActionType.CHANGE_VOLUME: "调整音量",
            ActionType.CHANGE_PAN: "调整声像",
            ActionType.TRIM_ITEM: "裁剪音频块",
            ActionType.MERGE_ITEMS: "合并音频块",
        }
        t = action.get('type', '')
        if isinstance(t, ActionType):
            return type_map.get(t, t.value)
        return type_map.get(t, str(t))


# ═══════════════════════════════════════════════════════
# 数据构造辅助函数
# ═══════════════════════════════════════════════════════

def make_move_data(item_id: str, old_start: float, new_start: float,
                   old_track: int, new_track: int) -> dict:
    """构造移动音频块的撤销数据"""
    return {
        'item_id': item_id,
        'old_start': old_start,
        'new_start': new_start,
        'old_track': old_track,
        'new_track': new_track,
    }


def make_split_data(original_item_id: str, original_data: dict,
                    left_item_data: dict, right_item_data: dict,
                    split_time: float) -> dict:
    """构造分割音频块的撤销数据"""
    return {
        'original_item_id': original_item_id,
        'original_data': original_data,
        'left_item_data': left_item_data,
        'right_item_data': right_item_data,
        'split_time': split_time,
    }


def make_delete_data(items: List[dict], track_indices: List[int]) -> dict:
    """构造删除音频块的撤销数据"""
    return {
        'items': items,
        'track_indices': track_indices,
    }


def make_add_data(item_data: dict, track_index: int) -> dict:
    """构造添加音频块的撤销数据"""
    return {
        'item_data': item_data,
        'track_index': track_index,
    }


def make_fade_data(item_id: str, is_fade_in: bool,
                   old_duration: float, new_duration: float,
                   old_type: str, new_type: str) -> dict:
    """构造调整淡入淡出的撤销数据"""
    return {
        'item_id': item_id,
        'is_fade_in': is_fade_in,
        'old_duration': old_duration,
        'new_duration': new_duration,
        'old_type': old_type,
        'new_type': new_type,
    }


def make_volume_data(track_index: int, old_volume: float,
                     new_volume: float) -> dict:
    """构造调整音量的撤销数据"""
    return {
        'track_index': track_index,
        'old_volume': old_volume,
        'new_volume': new_volume,
    }


def make_pan_data(track_index: int, old_pan: float,
                  new_pan: float) -> dict:
    """构造调整声像的撤销数据"""
    return {
        'track_index': track_index,
        'old_pan': old_pan,
        'new_pan': new_pan,
    }


def make_trim_data(item_id: str, old_trim_start: float,
                   old_trim_end: float, new_trim_start: float,
                   new_trim_end: float) -> dict:
    """构造裁剪音频块的撤销数据"""
    return {
        'item_id': item_id,
        'old_trim_start': old_trim_start,
        'old_trim_end': old_trim_end,
        'new_trim_start': new_trim_start,
        'new_trim_end': new_trim_end,
    }


def make_merge_data(merged_item_data: dict,
                    original_items: List[dict],
                    track_index: int) -> dict:
    """构造合并音频块的撤销数据"""
    return {
        'merged_item_data': merged_item_data,
        'original_items': original_items,
        'track_index': track_index,
    }