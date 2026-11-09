// 과제 솔빙 뷰어 — PIN 로그인 + 칩 저장 (Netlify Functions + Netlify Blobs)
// 환경변수: APP_PASSWORD (숫자 4자리, 설정하면 잠금 + 서버 저장 켜짐), ANTHROPIC_API_KEY (AI), SESSION_SECRET (선택)
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const CHUNK_MAX = 3.5 * 1024 * 1024;   // Functions 요청/응답 6MB 제한 → 3MB씩 나눠 올림
const env = k => process.env[k] || '';
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const secret = () => crypto.createHash('sha256')
  .update('hwv|' + env('APP_PASSWORD') + '|' + env('ANTHROPIC_API_KEY') + '|' + env('SESSION_SECRET')).digest();
const mac = exp => crypto.createHmac('sha256', secret()).update(String(exp)).digest('hex');
const sign = exp => exp + '.' + mac(exp);
function verify(tok) {
  if (!tok) return false;
  const [exp, m] = String(tok).split('.');
  if (!exp || !m || !(+exp > Date.now())) return false;
  const good = mac(exp);
  return m.length === good.length && crypto.timingSafeEqual(Buffer.from(m), Buffer.from(good));
}
const okPath = s => /^[A-Za-z0-9_.~:@+\-\/]{1,900}$/.test(s) && !s.split('/').some(x => !x || x === '.' || x === '..');

export async function handle(req, context, store) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\//, '');
  const pin = env('APP_PASSWORD');
  const authed = !pin || verify(req.headers.get('x-app-token'));

  if (route === 'status')
    return json({ pinSet: !!pin, pinValid: /^\d{4}$/.test(pin), ai: !!env('ANTHROPIC_API_KEY'), storage: !!pin, authed });

  if (route === 'auth' && req.method === 'POST') {
    if (!pin) return json({ token: '' });
    const now = Date.now();
    const ip = String(context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown').replace(/[^0-9a-fA-F:.]/g, '_');
    const fk = 'auth/fail/' + ip;
    const f = (await store.get(fk, { type: 'json' })) || { n: 0, until: 0 };
    const g = (await store.get('auth/global', { type: 'json' })) || { n: 0, since: now };
    if (f.until > now) return json({ error: `잠겼어요. ${Math.ceil((f.until - now) / 60000)}분 뒤에 다시 해 주세요` }, 429);
    if (g.n >= 50 && now - g.since < 3600e3) return json({ error: '틀린 시도가 너무 많아 잠시 잠겼어요. 1시간 뒤에 다시 해 주세요' }, 429);
    let body = {}; try { body = await req.json(); } catch {}
    if (String(body.pin ?? '') === pin) {
      if (f.n) await store.delete(fk);
      return json({ token: sign(now + 30 * 864e5) });            // 30일 로그인 유지
    }
    f.n++; let locked = false;
    if (f.n >= 5) { f.until = now + 15 * 60e3; f.n = 0; locked = true; }
    await store.setJSON(fk, f);
    if (now - g.since >= 3600e3) { g.n = 0; g.since = now; }
    g.n++; await store.setJSON('auth/global', g);
    return json({ error: locked ? '5번 틀려서 15분 동안 잠겼어요' : `비밀번호가 틀려요 (${5 - f.n}번 남음)` }, 401);
  }

  if (!pin) return json({ error: '서버 저장은 APP_PASSWORD를 설정해야 켜져요' }, 403);
  if (!authed) return json({ error: '로그인이 필요해요' }, 401);

  const path = url.searchParams.get('path') || '';
  if (route === 'doc') {
    if (!okPath(path)) return json({ error: 'bad path' }, 400);
    const k = 'doc/' + path;
    if (req.method === 'GET') { const d = await store.get(k, { type: 'json' }); return json({ exists: d != null, data: d ?? null }); }
    if (req.method === 'PUT') { const d = await req.json(); await store.setJSON(k, d); return json({ ok: true }); }
    if (req.method === 'DELETE') { await store.delete(k); return json({ ok: true }); }
  }
  if (route === 'list') {
    if (!okPath(path)) return json({ error: 'bad path' }, 400);
    const prefix = 'doc/' + path + '/';
    const { blobs } = await store.list({ prefix });
    const direct = blobs.filter(b => !b.key.slice(prefix.length).includes('/'));
    const docs = await Promise.all(direct.map(async b => ({ id: b.key.slice(prefix.length), data: await store.get(b.key, { type: 'json' }) })));
    return json({ docs: docs.filter(d => d.data != null) });
  }
  if (route === 'blob') {
    const id = url.searchParams.get('id') || '', i = Number(url.searchParams.get('i') || 0);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !(Number.isInteger(i) && i >= 0 && i < 1000)) return json({ error: 'bad id' }, 400);
    if (req.method === 'PUT') {
      const buf = await req.arrayBuffer();
      if (buf.byteLength > CHUNK_MAX) return json({ error: 'too big' }, 413);
      await store.set(`blob/${id}/${i}`, buf); return json({ ok: true });
    }
    if (req.method === 'GET') {
      const b = await store.get(`blob/${id}/${i}`, { type: 'arrayBuffer' });
      if (!b) return json({ error: 'not found' }, 404);
      return new Response(b, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
    }
    if (req.method === 'DELETE') {
      const { blobs } = await store.list({ prefix: `blob/${id}/` });
      await Promise.all(blobs.map(b => store.delete(b.key))); return json({ ok: true });
    }
  }
  return json({ error: 'not found' }, 404);
}

export default async (req, context) => handle(req, context, getStore({ name: 'hwviewer', consistency: 'strong' }));

export const config = { path: ['/api/status', '/api/auth', '/api/doc', '/api/list', '/api/blob'] };
