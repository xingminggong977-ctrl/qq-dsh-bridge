#!/usr/bin/env python3
"""把一段话合成成 mp3。

文字从 stdin 读、不走命令行参数：中文标点、引号、换行在 argv 里会被各种层
（ssh、shell、spawn）反复折腾，stdin 是唯一不会变形的通道。

用法: python say.py <输出路径> [音色] [语速] [音高]
"""
import asyncio
import os
import sys

import edge_tts


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: say.py <输出路径> [音色] [语速]", file=sys.stderr)
        return 2
    out = sys.argv[1]
    voice = sys.argv[2] if len(sys.argv) > 2 else "zh-CN-XiaoxiaoNeural"
    rate = sys.argv[3] if len(sys.argv) > 3 else "+0%"
    pitch = sys.argv[4] if len(sys.argv) > 4 else "+0Hz"
    text = sys.stdin.read().strip()
    if text == "":
        print("没有文字可读", file=sys.stderr)
        return 2

    directory = os.path.dirname(out)
    if directory:
        os.makedirs(directory, exist_ok=True)

    asyncio.run(edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(out))
    if not os.path.exists(out) or os.path.getsize(out) == 0:
        print("合成结果为空", file=sys.stderr)
        return 1
    print(os.path.getsize(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
