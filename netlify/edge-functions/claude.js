// 과제 솔빙 뷰어 — Claude API 중계 (Netlify Edge Function, 스트리밍)
// 환경변수: ANTHROPIC_API_KEY + SESSION_SECRET (둘 다 있어야 AI 켜짐), CLAUDE_MODEL, CLAUDE_MODEL_COMPLEX (선택)
// 등록된 칩을 비밀번호로 연 사람만 사용 가능 (칩 열쇠는 netlify/functions/store.mjs 가 SESSION_SECRET으로 발급)
async function verifyChipToken(id, tok, sec) {
  const [exp, mac] = String(tok || '').split('.');
  if (!sec || !/^[a-f0-9]{32}$/.test(id || '') || !exp || !mac || !(+exp > Date.now())) return false;
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(sec), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(id + '|' + exp)));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('') === mac;
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export default async (req) => {
  const key = Netlify.env.get('ANTHROPIC_API_KEY');
  const sec = Netlify.env.get('SESSION_SECRET') || '';
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!key) return json({ error: 'ANTHROPIC_API_KEY가 설정되지 않았어요' }, 503);
  if (!sec) return json({ error: 'AI를 쓰려면 SESSION_SECRET 환경변수도 넣어야 해요' }, 503);
  if (!(await verifyChipToken(req.headers.get('x-chip-id'), req.headers.get('x-chip-token'), sec)))
    return json({ error: '등록한 칩을 비밀번호로 연 상태에서만 AI를 쓸 수 있어요' }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: '잘못된 요청' }, 400); }
  const { messages = [], images = [], tier = 'default' } = body;
  if (!Array.isArray(messages) || !messages.length) return json({ error: 'messages 없음' }, 400);

  const msgs = messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') }));
  const last = msgs[msgs.length - 1];
  if (images.length) {
    last.content = [
      ...images.slice(0, 20).map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
      { type: 'text', text: last.content }
    ];
  }
  const model = tier === 'complex'
    ? (Netlify.env.get('CLAUDE_MODEL_COMPLEX') || Netlify.env.get('CLAUDE_MODEL') || 'claude-sonnet-5-5')
    : (Netlify.env.get('CLAUDE_MODEL') || 'claude-sonnet-5-5');

  const up = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 8000, stream: true, messages: msgs })
  });
  if (!up.ok) {
    let msg = ''; try { msg = (await up.json()).error?.message || ''; } catch {}
    return json({ error: msg || ('Claude API ' + up.status) }, up.status === 429 || up.status === 529 ? 429 : up.status === 401 ? 502 : up.status);
  }
  return new Response(up.body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } });
};

export const config = { path: '/api/claude' };
