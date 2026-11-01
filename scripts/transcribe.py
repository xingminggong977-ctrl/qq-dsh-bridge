#!/usr/bin/env python3
"""Transcribe one audio file and print JSON on stdout.

Called by the bridge as: transcribe.py <clip> <model-dir>

Prints {"text": "...", "lang": "zh", "dur": 1.23}. Prints {"text": ""} and exits
0 when there is nothing to hear, so a quiet clip is never an error.
"""
import json
import os
import subprocess
import sys
import tempfile

FFMPEG = "/usr/bin/ffmpeg"


def leading_bytes(path, count=12):
    """前几个字节：mp3 是 fffb/4944，silk 是 0221，amr 是 2321——出事时一眼看穿。"""
    try:
        with open(path, "rb") as handle:
            return handle.read(count).hex()
    except OSError:
        return "?"


def to_wav(clip):
    """不管 NapCat 给的是 mp3、amr 还是 silk，先用 ffmpeg 归一成 16k 单声道 wav。

    直接把原文件喂给 faster-whisper 时，解不开的容器只会抛一句
    「Invalid data found when processing input」，而真正的字节长什么样完全看不到；
    这里把 ffmpeg 的 stderr 和文件头一起带进错误信息。
    """
    handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    handle.close()
    try:
        done = subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", clip,
             "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", handle.name],
            capture_output=True,
            text=True,
        )
        size = os.path.getsize(handle.name)
        if done.returncode != 0 or size == 0:
            raise ValueError(
                f"ffmpeg 解不开这个音频：{os.path.getsize(clip)} 字节，"
                f"开头 {leading_bytes(clip)}，ffmpeg 说：{(done.stderr or '').strip()[:200]}"
            )
        return handle.name
    except Exception:
        os.unlink(handle.name)
        raise


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"text": "", "error": "usage: transcribe.py <clip> [model-dir]"}))
        return 2
    clip = sys.argv[1]
    model_dir = sys.argv[2] if len(sys.argv) > 2 else "/opt/asr-models"

    # 模型早就下到本地了，但 huggingface_hub 每次加载仍要联网问一次版本。
    # 这台机器到 huggingface 不通，于是每次调用都卡在超时重试上：
    # 实测「加载 132 秒、转写 0.13 秒」，关掉联网查询后加载 2.8 秒。
    os.environ.setdefault("HF_HUB_OFFLINE", "1")

    from faster_whisper import WhisperModel

    model = WhisperModel("small", device="cpu", compute_type="int8", download_root=model_dir)
    wav = to_wav(clip)
    try:
        segments, info = model.transcribe(
            wav,
            language="zh",
            vad_filter=True,
            beam_size=1,
            # 不提示的话，whisper 的 zh 输出偏繁体（「頭疼」「肚子還是」），
            # 她读到的上下文跟着变味。给一句简体引导，输出就稳在简体。
            initial_prompt="以下是普通话的句子，请用简体中文转写。",
        )
        text = "".join(segment.text for segment in segments).strip()
    finally:
        os.unlink(wav)
    print(json.dumps({"text": text, "lang": info.language, "dur": round(info.duration, 2)}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - the bridge only needs a clean failure
        print(json.dumps({"text": "", "error": f"{type(error).__name__}: {error}"}))
        sys.exit(1)
