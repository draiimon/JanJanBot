import fs from 'fs';
import https from 'https';

function parseEnvFile(path) {
  const env = {};
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

function testKey(key) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'qwen/qwen3.8-27b',
      messages: [{ role: 'user', content: 'ok' }],
      max_completion_tokens: 1,
    });
    const req = https.request(
      {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(data);
          } catch {
            /* ignore */
          }
          resolve({
            status: res.statusCode,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', () => resolve({ status: 0 }));
    req.write(body);
    req.end();
  });
}

const env = {};
for (const p of ['.env', 'JanJanBot.render.env']) {
  if (fs.existsSync(p)) Object.assign(env, parseEnvFile(p));
}
// Prefer current runtime/Replit secrets over values from local files.
Object.assign(env, process.env);

const slots = [
  'GROQ_API_KEY1',
  'GROQ_API_KEY2',
  'GROQ_API_KEY3',
  'GROQ_API_KEY4',
  'GROQ_API_KEY5',
  'GROQ_API_KEY6',
  'GROQ_API_KEY',
];

for (const name of slots) {
  const key = String(env[name] || '').trim().replace(/^["']|["']$/g, '');
  if (!key) {
    console.log(`${name}: NOT SET`);
    continue;
  }
  const r = await testKey(key);
  console.log(`${name}: ${r.status === 200 ? 'OK' : 'FAIL'} HTTP ${r.status}`);
}
