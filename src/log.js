/**
 * JSON-lines logger with mandatory secret redaction.
 * NODE_TOKEN / NAPCAT_ACCESS_TOKEN must never reach stdout or an error response.
 */
export function createLogger({ secrets = [], write, now = () => Date.now() } = {}) {
  const hidden = secrets.filter((secret) => typeof secret === 'string' && secret.length > 0);
  const sink = write ?? ((line) => process.stdout.write(`${line}\n`));

  function redact(input) {
    let out = String(input);
    for (const secret of hidden) out = out.split(secret).join('***');
    return out
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
      .replace(/access_token=[^&\s"]+/gi, 'access_token=***');
  }

  function emit(level, msg, fields) {
    const record = { ts: new Date(now()).toISOString(), level, msg: String(msg) };
    if (fields && typeof fields === 'object') {
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        record[key] = value;
      }
    }
    let line;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level, msg: record.msg });
    }
    sink(redact(line));
  }

  return {
    redact,
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
