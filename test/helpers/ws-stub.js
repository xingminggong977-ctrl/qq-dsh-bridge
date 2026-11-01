import crypto from 'node:crypto';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function encodeFrame(opcode, payload) {
  const body = Buffer.from(payload);
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, body]);
}

/** Parse client->server frames (always masked). Returns complete frames plus the leftover bytes. */
export function parseClientFrames(buffer) {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    let maskKey = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      maskKey = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (maskKey) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index & 3];
    }
    frames.push({ opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/**
 * Fake NapCat: a WebSocket *server* that pushes OneBot 11 events and records the
 * actions the bridge sends, so tests never need a real QQ account.
 */
export class FakeNapCat {
  constructor({ accessToken = '' } = {}) {
    this.accessToken = accessToken;
    this.connections = new Set();
    this.actions = [];
    this.upgradeHeaders = [];
    this.nextMessageId = 1000;
    this.actionHandler = null;
    this.rejectedHandshakes = 0;
    this.server = http.createServer((req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('websocket only');
    });
    this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    return this;
  }

  get port() {
    return this.server.address().port;
  }

  get url() {
    return `ws://127.0.0.1:${this.port}`;
  }

  get openCount() {
    return this.connections.size;
  }

  async stop() {
    for (const connection of this.connections) {
      try {
        connection.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  onUpgrade(req, socket, head) {
    this.upgradeHeaders.push(req.headers);
    if (this.accessToken && req.headers.authorization !== `Bearer ${this.accessToken}`) {
      this.rejectedHandshakes += 1;
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );
    const connection = { socket, buffer: Buffer.alloc(0) };
    this.connections.add(connection);
    const onData = (chunk) => {
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      const { frames, rest } = parseClientFrames(connection.buffer);
      connection.buffer = rest;
      for (const frame of frames) this.onFrame(connection, frame);
    };
    socket.on('data', onData);
    socket.on('close', () => this.connections.delete(connection));
    socket.on('error', () => this.connections.delete(connection));
    if (head && head.length > 0) onData(head);
  }

  onFrame(connection, frame) {
    if (frame.opcode === 0x1) {
      let message;
      try {
        message = JSON.parse(frame.payload.toString('utf8'));
      } catch {
        return;
      }
      this.handleAction(connection, message);
      return;
    }
    if (frame.opcode === 0x9) {
      try {
        connection.socket.write(encodeFrame(0xa, frame.payload));
      } catch {
        /* ignore */
      }
      return;
    }
    if (frame.opcode === 0x8) {
      try {
        connection.socket.write(encodeFrame(0x8, Buffer.alloc(0)));
      } catch {
        /* ignore */
      }
      connection.socket.end();
      this.connections.delete(connection);
    }
  }

  handleAction(connection, message) {
    const record = { action: message.action, params: message.params ?? {}, echo: message.echo };
    this.actions.push(record);
    const response = { status: 'ok', retcode: 0, data: { message_id: this.nextMessageId += 1 }, echo: message.echo };
    const override = typeof this.actionHandler === 'function' ? this.actionHandler(record, this.actions.length - 1) : null;
    if (override && override.drop) return;
    if (override) Object.assign(response, override);
    this.write(connection, response);
  }

  write(connection, object) {
    if (connection.socket.destroyed) return;
    connection.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(object), 'utf8')));
  }

  /** Push an OneBot 11 event frame to every connected bridge. */
  inject(event) {
    for (const connection of this.connections) this.write(connection, event);
  }

  get sendActions() {
    return this.actions.filter((entry) => entry.action === 'send_group_msg' || entry.action === 'send_private_msg');
  }

  /** Text payload of each send action, in order (handles both string and segment-array messages). */
  get sentTexts() {
    return this.sendActions.map((entry) => {
      const message = entry.params.message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) {
        return message
          .filter((segment) => segment && segment.type === 'text')
          .map((segment) => String(segment.data?.text ?? ''))
          .join('');
      }
      return '';
    });
  }
}

/** Build a group message event the way NapCat emits it (segment array form). */
export function groupMessage({
  selfId = '30000',
  groupId = '123456',
  userId = '10001',
  nickname = '小明',
  segments = [],
  card = '',
} = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 9001,
    group_id: Number(groupId),
    user_id: Number(userId),
    self_id: Number(selfId),
    raw_message: '',
    message: segments,
    sender: { user_id: Number(userId), nickname, card },
    time: 1760000000,
  };
}

export function privateMessage({ selfId = '30000', userId = '20002', nickname = '小红', segments = [] } = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 9002,
    user_id: Number(userId),
    self_id: Number(selfId),
    raw_message: '',
    message: segments,
    sender: { user_id: Number(userId), nickname },
    time: 1760000000,
  };
}

export const atSegment = (qq) => ({ type: 'at', data: { qq: String(qq) } });
export const textSegment = (text) => ({ type: 'text', data: { text } });
export const imageSegment = (url) => ({ type: 'image', data: { url, file: 'abc.jpg', sub_type: 0 } });
