#!/usr/bin/env python3
"""用复刻出来的音色（或任何 CosyVoice 音色）把文字合成成 mp3。

文字从 stdin 读、不走命令行参数——理由同 say.py：中文标点在 argv 里会被
ssh / shell / spawn 反复折腾，stdin 是唯一不会变形的通道。

用法: DASHSCOPE_API_KEY=sk-xxx python say-cosyvoice.py <输出路径> <音色> [模型] [语速] [音高] [风格指令]
- 音色：复刻返回的 voice id（形如 cosyvoice-v2-xxxx-...），或官方音色名
- 语速：0.5~2.0，默认 1.0；音高：0.5~2.0，默认 1.0
- 风格指令：可选，例如「用自然随意的聊天语气说」；仅 v3 / v3.5 系列模型支持，v1/v2 传了会被忽略或报错
"""
import json
import os
import sys
import time

import dashscope
from dashscope.audio.tts_v2 import SpeechSynthesizer


def main() -> int:
    if len(sys.argv) < 3:
        print('用法: say-cosyvoice.py <输出路径> <音色> [模型] [语速] [音高]', file=sys.stderr)
        return 2
    out = sys.argv[1]
    voice = sys.argv[2]
    model = sys.argv[3] if len(sys.argv) > 3 else 'cosyvoice-v2'
    rate = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    pitch = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0
    instruction = sys.argv[6] if len(sys.argv) > 6 else ''

    key = os.environ.get('DASHSCOPE_API_KEY', '')
    if key == '':
        print('缺少 DASHSCOPE_API_KEY', file=sys.stderr)
        return 2

    text = sys.stdin.read().strip()
    if text == '':
        print('没有文字可读', file=sys.stderr)
        return 2

    directory = os.path.dirname(out)
    if directory:
        os.makedirs(directory, exist_ok=True)

    dashscope.api_key = key
    started = time.monotonic()
    kwargs = {'model': model, 'voice': voice, 'speech_rate': rate, 'pitch_rate': pitch}
    if instruction != '':
        kwargs['instruction'] = instruction
    try:
        synth = SpeechSynthesizer(**kwargs)
        audio = synth.call(text)
    except Exception as exc:  # noqa: BLE001 - 云端异常统一打成一行，别丢原因
        print(f'合成失败: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1

    if not audio:
        print('合成结果为空', file=sys.stderr)
        return 1
    with open(out, 'wb') as fh:
        fh.write(audio)

    print(json.dumps({
        'bytes': len(audio),
        'ms': int((time.monotonic() - started) * 1000),
        'voice': voice,
        'model': model,
        'chars': len(text),
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
