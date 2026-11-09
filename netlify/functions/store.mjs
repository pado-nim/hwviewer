// 과제 솔빙 뷰어 — 칩 등록/찾기 (칩마다 제목 + 비밀번호 4자리)
// Netlify Functions + Netlify Blobs. 환경변수 없이 동작 (AI 쓰려면 ANTHROPIC_API_KEY).
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const CHUNK_MAX = 3.5 * 1024 * 1024;           // Functions 요청/응답 6MB 제한 → 3MB씩 나눠 주고받음
const TOKEN_DAYS = 30;
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const cleanTitle = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 80);
const titleKey = t => sha(cleanTitle(t).toLowerCase()).slice(0, 32);

async function secret(store) {
  let s = process.env.SESSION_SECRET || await store.get('sys/secret', { type: 'text' });
  if (!s) { s = crypto.randomBytes(32).toString('hex'); await store.set('sys/secret', s); }
  return s;
}
const mac = (sec, id, exp) => crypto.createHmac('sha256', sec).update(id + '|' + exp).digest('hex');
async function makeToken(store, id) { const exp = Date.now() + TOKEN_DAYS * 864e5; return exp + '.' + mac(await secret(store), id, exp); }
async function checkToken(store, id, tok) {
  const [exp, m] = String(tok || '').split('.');
  if (!exp || !m || !(+exp > Date.now())) return false;
  const good = mac(await secret(store), id, exp);
  return m.length === good.length && crypto.timingSafeEqual(Buffer.from(m), Buffer.from(good));
}
const pubMeta = m => ({ id: m.id, title: m.title, count: m.count, created: m.created, updated: m.updated });

/* 틀린 비밀번호 제한: 칩마다 5번 → 15분 잠금, IP마다 1시간 30번 */
async function guard(store, id, ip) {
  const now = Date.now();
  const c = (await store.get('fail/chip/' + id, { type: 'json' })) || { n: 0, until: 0 };
  const p = (await store.get('fail/ip/' + ip, { type: 'json' })) || { n: 0, since: now };
  if (c.until > now) return { blocked: `이 칩은 잠겼어요. ${Math.ceil((c.until - now) / 60000)}분 뒤에 다시 해 주세요` };
  if (p.n >= 30 && now - p.since < 3600e3) return { blocked: '틀린 시도가 너무 많아요. 1시간 뒤에 다시 해 주세요' };
  return {
    async fail() {
      c.n++; let locked = false;
      if (c.n >= 5) { c.until = now + 15 * 60e3; c.n = 0; locked = true; }
      if (now - p.since >= 3600e3) { p.n = 0; p.since = now; }
      p.n++;
      await store.setJSON('fail/chip/' + id, c); await store.setJSON('fail/ip/' + ip, p);
      return locked ? '5번 틀려서 이 칩이 15분 동안 잠겼어요' : `비밀번호가 틀려요 (${5 - c.n}번 남음)`;
    },
    async ok() { if (c.n) await store.delete('fail/chip/' + id); }
  };
}

export async function handle(req, context, store) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\//, '');
  const ip = String(context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown').replace(/[^0-9a-fA-F:.]/g, '_');
  const id = url.searchParams.get('id') || '';
  const idOk = /^[a-f0-9]{32}$/.test(id);

  if (route === 'status') return json({ server: true, ai: !!(process.env.ANTHROPIC_API_KEY && process.env.SESSION_SECRET) });

  /* 칩 찾기: 제목 목록만 (비밀번호 없이 볼 수 있는 건 제목뿐) */
  if (route === 'chips' && req.method === 'GET') {
    const q = cleanTitle(url.searchParams.get('q')).toLowerCase();
    const { blobs } = await store.list({ prefix: 'meta/' });
    let metas = (await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })))).filter(Boolean);
    if (q) metas = metas.filter(m => m.title.toLowerCase().includes(q));
    metas.sort((a, b) => (b.updated || b.created) - (a.updated || a.created));
    return json({ chips: metas.slice(0, 50).map(pubMeta) });
  }

  /* 칩 등록: 제목 + 비밀번호 4자리. 같은 제목이 있으면 같은 비밀번호일 때만 덮어쓰기 */
  if (route === 'chips' && req.method === 'POST') {
    let b = {}; try { b = await req.json(); } catch {}
    const title = cleanTitle(b.title);
    if (!title) return json({ error: '제목을 적어 주세요' }, 400);
    if (!/^\d{4}$/.test(String(b.pin || ''))) return json({ error: '비밀번호는 숫자 4자리예요' }, 400);
    if (!b.chip || !Array.isArray(b.chip.items)) return json({ error: '칩 내용이 없어요' }, 400);
    const chunks = Number(b.chunks);
    if (!Number.isInteger(chunks) || chunks < 1 || chunks > 300) return json({ error: 'PDF 크기가 이상해요' }, 400);
    const cid = titleKey(title);
    const old = await store.get('meta/' + cid, { type: 'json' });
    if (old) {
      const g = await guard(store, cid, ip);
      if (g.blocked) return json({ error: g.blocked }, 429);
      if (sha(old.salt + b.pin) !== old.pinHash)
        return json({ error: '같은 제목의 칩이 이미 있어요. 다른 제목을 쓰거나, 그 칩의 비밀번호를 넣으면 새 내용으로 바꿔요. ' + await g.fail() }, 409);
      await g.ok();
    }
    const salt = crypto.randomBytes(16).toString('hex'), now = Date.now();
    const meta = { id: cid, title, count: b.chip.items.length, created: old?.created || now, updated: now,
                   salt, pinHash: sha(salt + b.pin), chunks, pending: true };
    await store.setJSON('chip/' + cid, b.chip);
    await store.setJSON('ai/' + cid, old ? ((await store.get('ai/' + cid, { type: 'json' })) || {}) : {});
    await store.setJSON('meta/' + cid, meta);                        // pending: PDF 다 올라오면 찾기 목록에 보임
    if (old) { const { blobs } = await store.list({ prefix: `pdf/${cid}/` }); await Promise.all(blobs.map(x => store.delete(x.key))); }
    return json({ id: cid, token: await makeToken(store, cid) });
  }

  /* 칩 열기: 비밀번호(또는 전에 받은 토큰) 확인 → 칩 내용 + 열쇠(토큰) */
  if (route === 'chips/open' && req.method === 'POST') {
    let b = {}; try { b = await req.json(); } catch {}
    const cid = String(b.id || '');
    if (!/^[a-f0-9]{32}$/.test(cid)) return json({ error: 'bad id' }, 400);
    const meta = await store.get('meta/' + cid, { type: 'json' });
    if (!meta || meta.pending) return json({ error: '없는 칩이에요' }, 404);
    let ok = b.token && await checkToken(store, cid, b.token);
    if (!ok) {
      if (!b.pin) return json({ error: '비밀번호를 넣어 주세요', needPin: true }, 401);
      const g = await guard(store, cid, ip);
      if (g.blocked) return json({ error: g.blocked }, 429);
      if (sha(meta.salt + String(b.pin)) !== meta.pinHash) return json({ error: await g.fail() }, 401);
      await g.ok(); ok = true;
    }
    const chip = await store.get('chip/' + cid, { type: 'json' });
    const ai = (await store.get('ai/' + cid, { type: 'json' })) || {};
    return json({ meta: pubMeta(meta), chunks: meta.chunks, chip, ai, token: await makeToken(store, cid) });
  }

  /* 여기부터는 그 칩의 열쇠(토큰)가 있어야 함 */
  if (!idOk) return json({ error: 'bad id' }, 400);
  if (!(await checkToken(store, id, req.headers.get('x-chip-token')))) return json({ error: '비밀번호를 다시 넣어 주세요', needPin: true }, 401);

  if (route === 'chips/pdf') {
    const i = Number(url.searchParams.get('i') || 0);
    if (!(Number.isInteger(i) && i >= 0 && i < 300)) return json({ error: 'bad i' }, 400);
    if (req.method === 'PUT') {
      const buf = await req.arrayBuffer();
      if (buf.byteLength > CHUNK_MAX) return json({ error: 'too big' }, 413);
      await store.set(`pdf/${id}/${i}`, buf);
      const meta = await store.get('meta/' + id, { type: 'json' });
      if (meta?.pending && i === meta.chunks - 1) { delete meta.pending; await store.setJSON('meta/' + id, meta); }
      return json({ ok: true });
    }
    if (req.method === 'GET') {
      const b = await store.get(`pdf/${id}/${i}`, { type: 'arrayBuffer' });
      if (!b) return json({ error: 'not found' }, 404);
      return new Response(b, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
    }
  }
  if (route === 'chips/ai' && req.method === 'PUT') {           // AI 검증·해설 결과 저장
    let b = {}; try { b = await req.json(); } catch {}
    const ai = (await store.get('ai/' + id, { type: 'json' })) || {};
    ai[String(b.key).slice(0, 100)] = b.value; await store.setJSON('ai/' + id, ai);
    return json({ ok: true });
  }
  if (route === 'chips' && req.method === 'DELETE') {
    const { blobs } = await store.list({ prefix: `pdf/${id}/` });
    await Promise.all([...blobs.map(x => store.delete(x.key)), store.delete('meta/' + id), store.delete('chip/' + id), store.delete('ai/' + id)]);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

export default async (req, context) => handle(req, context, getStore({ name: 'hwviewer', consistency: 'strong' }));

export const config = { path: ['/api/status', '/api/chips', '/api/chips/open', '/api/chips/pdf', '/api/chips/ai'] };
