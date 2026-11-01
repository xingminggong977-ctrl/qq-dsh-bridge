import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVideo } from '../src/video.js';

/** 一次性的内存文件系统：只实现 extractVideo 用到的那几个方法。 */
function memoryFs(seed = {}) {
	const files = new Map(Object.entries(seed));
	return {
		files,
		async writeFile(path, bytes) {
			files.set(path, Buffer.from(bytes));
		},
		async readFile(path) {
			const value = files.get(path);
			if (value === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
			return value;
		},
	};
}

test('video — 抽出的帧和音轨都是可用的字节', async () => {
	const fs = memoryFs();
	const calls = [];
	const run = async (args) => {
		calls.push(args.join(' '));
		const out = args.at(-1);
		if (out.endsWith('%02d.jpg')) {
			// 像真 ffmpeg 那样把模式展开成 frame01/02/03.jpg
			for (let index = 1; index <= 3; index += 1) {
				fs.files.set(out.replace('%02d', String(index).padStart(2, '0')), Buffer.alloc(1024, 7));
			}
		} else if (out.endsWith('.wav')) fs.files.set(out, Buffer.alloc(3200, 3));
	};
	const result = await extractVideo(Buffer.alloc(4096, 1), { run, fs, dir: '/w', frames: 3 });
	assert.equal(result.frames.length, 3);
	assert.equal(result.frames[0].length, 1024);
	assert.equal(result.audio.length, 3200);
	assert.match(calls[0], /thumbnail,scale=640:-2/);
	assert.match(calls[0], /-frames:v 3/);
	assert.match(calls[1], /-vn -ac 1 -ar 16000/);
});

test('video — 抽帧失败仍然交出音轨，并说清原因', async () => {
	const fs = memoryFs();
	const warned = [];
	const run = async (args) => {
		const out = args.at(-1);
		if (out.endsWith('%02d.jpg')) throw new Error('ffmpeg exploded');
		fs.files.set(out, Buffer.alloc(2000, 1));
	};
	const result = await extractVideo(Buffer.alloc(100, 1), {
		run,
		fs,
		dir: '/w',
		log: { warn: (message, detail) => warned.push([message, detail]) },
	});
	assert.deepEqual(result.frames, []);
	assert.equal(result.audio.length, 2000, '音轨这条腿不能因为抽帧挂了就一起挂');
	assert.equal(warned[0][0], 'video frames failed');
	assert.match(warned[0][1].reason, /ffmpeg exploded/);
});

test('video — 空音轨（只有 wav 头）当作没有声音', async () => {
	const fs = memoryFs();
	const run = async (args) => {
		const out = args.at(-1);
		fs.files.set(out, Buffer.alloc(44, 0));
	};
	const result = await extractVideo(Buffer.alloc(10, 1), { run, fs, dir: '/w', frames: 1 });
	assert.equal(result.audio, null);
});

test('video — 超大文件直接放弃，不浪费时间转码', async () => {
	const fs = memoryFs();
	let touched = false;
	const result = await extractVideo(Buffer.alloc(64, 1), {
		run: async () => {
			touched = true;
		},
		fs,
		dir: '/w',
		maxBytes: 32,
		log: { warn: () => {} },
	});
	assert.deepEqual(result, { frames: [], audio: null });
	assert.equal(touched, false, '超限时不该调用 ffmpeg');
});

test('video — 空 buffer 不做任何事', async () => {
	const result = await extractVideo(Buffer.alloc(0), {
		run: async () => assert.fail('不该被调用'),
		fs: memoryFs(),
		dir: '/w',
	});
	assert.deepEqual(result, { frames: [], audio: null });
});
