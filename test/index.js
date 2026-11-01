// Node 24 resolves positional --test arguments as glob patterns, so `node --test test/`
// (the documented acceptance command) lands on this directory. Index resolution lets that
// exact command load every suite; `node --test test/*.test.js` runs each file separately.
import './config.test.js';
import './log.test.js';
import './asr.test.js'
import './tts.test.js'
import './voice-reply.test.js'
import './send-image.test.js';
import './queue.test.js';
import './proactive.test.js';
import './proactive-gates.test.js';
import './proactive-observability.test.js';
import './world-life.test.js';
import './ratelimit.test.js';
import './http.test.js';
import './boot.test.js';
import './onebot.test.js';
import './lease-expiry.test.js';
import './delivery.test.js';
import './group-mode.test.js';
import './faces.test.js';
import './video.test.js';
import './e2e.test.js';
