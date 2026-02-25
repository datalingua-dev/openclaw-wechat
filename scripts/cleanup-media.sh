#!/bin/bash
# openclaw-wecom 媒体文件定时清理脚本
# 清理 ~/.openclaw/media/wecom/ 下超过指定天数的媒体文件
#
# 用法: ./cleanup-media.sh [天数]
# 默认: 7 天

MEDIA_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/media/wecom"
DAYS="${1:-7}"

if [ ! -d "$MEDIA_DIR" ]; then
  echo "[cleanup] 目录不存在: $MEDIA_DIR，跳过"
  exit 0
fi

# 统计清理前的文件数和大小
BEFORE_COUNT=$(find "$MEDIA_DIR" -type f -mtime +"$DAYS" | wc -l)
BEFORE_SIZE=$(find "$MEDIA_DIR" -type f -mtime +"$DAYS" -exec du -ch {} + 2>/dev/null | tail -1 | cut -f1)

if [ "$BEFORE_COUNT" -eq 0 ]; then
  echo "[cleanup] $(date '+%Y-%m-%d %H:%M:%S') 没有超过 ${DAYS} 天的文件需要清理"
  exit 0
fi

# 执行清理
find "$MEDIA_DIR" -type f -mtime +"$DAYS" -delete

echo "[cleanup] $(date '+%Y-%m-%d %H:%M:%S') 已清理 ${BEFORE_COUNT} 个文件，释放 ${BEFORE_SIZE:-0} 空间（保留策略：${DAYS} 天）"
