import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 从视频里抽出「能看懂」的两样东西：几帧画面 + 一段音轨。 * 她本来就是看图 + 听语音的，视频只是这两样的封装。与其让她多一条
 * 看不懂的输入类型，不如在这里拆开——拆完她什么都不用改。
 *
 * 抽帧用 `thumbnail` 滤镜：它在整段里挑「有代表性」的帧，比按固定间隔取帧
 * 更容易避开黑场和转场。帧数固定，宁可少看几秒，也不要一次塞几十张图。
 */
export const VIDEO_DEFAULTS = Object.freeze({
	maxBytes: 20 * 1024 * 1024,
	frames: 4,
	frameWidth: 640,
	timeoutMs: 60_000,
});

/**
 * @param {Buffer} buffer 视频原始字节
 * @param {object} options
 * @param {(args: string[]) => Promise<void>} options.run 执行 ffmpeg（可注入，测试用）
 * @param {import('node:fs/promises')} options.fs 文件操作（可注入）
 * @param {string} options.dir 临时目录
 * @returns {Promise<{frames: Buffer[], audio: Buffer|null}>}
 */
export async function extractVideo(buffer, { run, fs, dir, log = () => {}, ...rest } = {}) {
	const settings = { ...VIDEO_DEFAULTS, ...rest };
	if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { frames: [], audio: null };
	if (buffer.length > settings.maxBytes) {
		log.warn('video skipped: too large', { bytes: buffer.length, limit: settings.maxBytes });
		return { frames: [], audio: null };
	}
	const clip = `${dir}/clip`;
	await fs.writeFile(clip, buffer);

	const frames = [];
	try {
		await run([
			'-i', clip,
			'-vf', `thumbnail,scale=${settings.frameWidth}:-2`,
			'-frames:v', String(settings.frames),
			'-q:v', '3',
			`${dir}/frame%02d.jpg`,
		]);
	} catch (error) {
		// 抽帧失败不该让她连「他发了个视频」都不知道，音频那条路继续走。
		log.warn('video frames failed', { reason: error?.message ?? String(error) });
	}
	for (let index = 1; index <= settings.frames; index += 1) {
		const path = `${dir}/frame${String(index).padStart(2, '0')}.jpg`;
		try {
			const bytes = await fs.readFile(path);
			if (bytes.length > 0) frames.push(bytes);
		} catch {
			break; // ffmpeg 少抽几帧是正常的，后面的也不会有了
		}
	}

	let audio = null;
	try {
		await run([
			'-i', clip,
			'-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
			`${dir}/audio.wav`,
		]);
		const bytes = await fs.readFile(`${dir}/audio.wav`);
		if (bytes.length > 44) audio = bytes; // 44 字节是空的 wav 头
	} catch (error) {
		log.warn('video audio failed', { reason: error?.message ?? String(error) });
	}

	return { frames, audio };
}

/** 真跑 ffmpeg：把参数拼成一次子进程调用，超时就杀掉。 */
export function createFfmpegRunner(ffmpegPath = 'ffmpeg', timeoutMs = VIDEO_DEFAULTS.timeoutMs) {
	return (args) =>
		new Promise((resolve, reject) => {
			const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
				stdio: ['ignore', 'ignore', 'pipe'],
			});
			let stderr = '';
			const timer = setTimeout(() => {
				child.kill('SIGKILL');
				reject(new Error(`ffmpeg 超时（${timeoutMs}ms）`));
			}, timeoutMs);
			child.stderr.on('data', (chunk) => {
				stderr += String(chunk);
				if (stderr.length > 4000) stderr = stderr.slice(-4000);
			});
			child.on('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.on('close', (code) => {
				clearTimeout(timer);
				if (code === 0) resolve();
				else reject(new Error(stderr.trim().slice(0, 300) || `ffmpeg 退出码 ${code}`));
			});
		});
}

/** 装配成 dispatch 直接能用的 `video` 依赖；每次抽取用一个独立临时目录并保证清掉。 */
export function createVideoSplitter({ ffmpegPath = 'ffmpeg', timeoutMs = VIDEO_DEFAULTS.timeoutMs, workRoot = tmpdir(), log = () => {}, ...rest } = {}) {
	const run = createFfmpegRunner(ffmpegPath, timeoutMs);
	return {
		enabled: true,
		async extract(buffer) {
			const dir = await mkdtemp(join(workRoot, 'video-'));
			try {
				return await extractVideo(buffer, { run, fs: fsp, dir, log, timeoutMs, ...rest });
			} finally {
				await rm(dir, { recursive: true, force: true }).catch(() => {});
			}
		},
	};
}
