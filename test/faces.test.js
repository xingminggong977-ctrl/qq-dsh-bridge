import test from 'node:test';
import assert from 'node:assert/strict';
import { FACE_NAMES, faceMarker } from '../src/faces.js';
import { extractMessage } from '../src/dispatch.js';

const event = (segments, extra = {}) => ({
	post_type: 'message',
	message_type: 'private',
	user_id: 10001,
	message_id: 1,
	raw_message: '',
	message: segments,
	...extra,
});

test('faces — 经典脸翻成名字，不是一律「表情」', () => {
	assert.equal(faceMarker({ type: 'face', data: { id: '14' } }), '[微笑]');
	assert.equal(faceMarker({ type: 'face', data: { id: 5 } }), '[流泪]');
	assert.equal(faceMarker({ type: 'face', data: { id: '20' } }), '[偷笑]');
	// 名字表里没有的，把 id 亮出来——看得见缺口，好过假装看懂
	assert.equal(faceMarker({ type: 'face', data: { id: '147' } }), '[表情#147]');
	assert.equal(faceMarker({ type: 'face', data: {} }), '[表情]');
});

test('faces — 服务端给的文字优先，斜杠前缀会被剥掉', () => {
	assert.equal(faceMarker({ type: 'face', data: { id: '147', summary: '/doge' } }), '[doge]');
	assert.equal(faceMarker({ type: 'sface', data: { id: '1', raw: { faceText: '/汪汪' } } }), '[汪汪]');
	assert.equal(faceMarker({ type: 'sface', data: { summary: '[喵喵]' } }), '[喵喵]');
});

test('faces — 取不到字节的表情包带「表情包」字样，且会触发探针', () => {
	assert.equal(faceMarker({ type: 'mface', data: { emoji_id: 'abc' } }, { sticker: true }), '[表情包]');
	assert.equal(
		faceMarker({ type: 'mface', data: { summary: '[狗头]' } }, { sticker: true }),
		'[狗头]',
	);
});

test('faces — 一条消息里的表情不再被压成一个「[表情]」', () => {
	const seen = [];
	const message = extractMessage(
		event([
			{ type: 'text', data: { text: '今天好累' } },
			{ type: 'face', data: { id: '5' } },
			{ type: 'face', data: { id: '14' } },
			{ type: 'mface', data: { emoji_id: 'x1' } },
		]),
		{ onSticker: (segment) => seen.push(segment.type) },
	);
	assert.equal(message.text, '今天好累 [流泪][微笑][表情包]');
	assert.deepEqual(seen, ['mface'], '每个取不到字节的段都要报给探针');
});

test('faces — 名字表里没有重复的 id，也没有空名字', () => {
	const ids = Object.keys(FACE_NAMES).map(Number);
	assert.equal(ids.length, 105, '经典脸是 0–104 共 105 个');
	for (const [id, name] of Object.entries(FACE_NAMES)) {
		assert.equal(typeof name, 'string');
		assert.notEqual(name.trim(), '', `id ${id} 没有名字`);
	}
});
