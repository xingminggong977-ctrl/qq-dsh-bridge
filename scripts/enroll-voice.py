#!/usr/bin/env python3
"""把一段参考录音复刻成一个可用的音色，打印 voice id。

用法: DASHSCOPE_API_KEY=sk-xxx python enroll-voice.py <参考音频> [前缀] [模型]
- 参考音频：10~60 秒、单人、无背景音乐的清晰人声（wav/mp3 都行，采样率 ≥16k）
- 前缀：只能是字母数字下划线，同一前缀下可以挂多个音色
- 模型：默认 cosyvoice-v2（v3.5 系列的声音复刻额度另算）

stdout 只打印一行 JSON，方便调用方直接 parse；报错走 stderr 并用非零退出码。
"""
import base64
import json
import mimetypes
import os
import sys
import time

import dashscope
from dashscope.audio.tts_v2 import VoiceEnrollmentService


def main() -> int:
    if len(sys.argv) < 2:
        print('用法: enroll-voice.py <参考音频> [前缀] [模型]', file=sys.stderr)
        return 2
    src = sys.argv[1]
    prefix = sys.argv[2] if len(sys.argv) > 2 else 'lenovo'
    model = sys.argv[3] if len(sys.argv) > 3 else 'cosyvoice-v2'

    key = os.environ.get('DASHSCOPE_API_KEY', '')
    if key == '':
        print('缺少 DASHSCOPE_API_KEY', file=sys.stderr)
        return 2
    if not os.path.exists(src):
        print(f'参考音频不存在: {src}', file=sys.stderr)
        return 2
    size = os.path.getsize(src)
    if size == 0:
        print(f'参考音频为空: {src}', file=sys.stderr)
        return 2

    dashscope.api_key = key
    # 声音复刻要的是可访问的 URL 或 base64 data URI；我们没有公网图床，直接内联。
    mime = mimetypes.guess_type(src)[0] or 'audio/wav'
    with open(src, 'rb') as fh:
        payload = base64.b64encode(fh.read()).decode('ascii')
    data_uri = f'data:{mime};base64,{payload}'

    started = time.monotonic()
    try:
        voice_id = VoiceEnrollmentService().create_voice(
            target_model=model, prefix=prefix, url=data_uri, language_hints=['zh'])
    except Exception as exc:  # noqa: BLE001 - 云端异常统一打成一行，别丢原因
        print(f'create_voice 失败: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1

    print(json.dumps({
        'voiceId': voice_id,
        'prefix': prefix,
        'model': model,
        'bytes': size,
        'ms': int((time.monotonic() - started) * 1000),
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
