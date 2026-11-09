# 과제 솔빙 뷰어 (Netlify용)

칩 PDF를 넣으면 문제 · 답지 · 답안 검증 · 해설을 한 화면에 보여 주는 웹앱.
**숫자 4자리 비밀번호 잠금** + **칩 PDF 서버 저장**(어느 기기에서든 칩 코드로 열기) + AI 검증·해설.

## 폴더 구성
- `index.html`, `lib/` — 앱 화면
- `netlify/functions/store.mjs` — 비밀번호 로그인 + 칩 저장 (Netlify Blobs, 따로 가입·설정 필요 없음)
- `netlify/edge-functions/claude.js` — AI 기능용 Claude API 중계
- `package.json` — 저장 기능에 필요한 패키지(@netlify/blobs) 목록
- `netlify.toml` — Netlify 설정

## 배포 (GitHub 연결)
> 드래그 앤 드롭(app.netlify.com/drop) 배포는 서버 기능이 안 올라가서 **잠금·서버 저장·AI가 모두 꺼져요.** 꼭 아래 방법으로.

1. 이 폴더를 GitHub 저장소로 올리기
2. Netlify → Add new site → Import an existing project → 저장소 선택
   - Build command: 비워 두기 / Publish directory: `.`
3. Site configuration → Environment variables 추가
   | 이름 | 값 | |
   |---|---|---|
   | `APP_PASSWORD` | 숫자 4자리 (예: `4821`) | 잠금 + 서버 저장이 켜짐 |
   | `ANTHROPIC_API_KEY` | Claude API 키 | AI 검증·해설 (사용량만큼 요금) |
   | `SESSION_SECRET` | 아무 긴 문자열 | 선택 · 로그인 토큰 보안 강화 |
   | `CLAUDE_MODEL` | 기본 `claude-sonnet-5-5` | 선택 |
4. Deploys → Trigger deploy (환경변수는 다시 배포해야 적용)

Netlify CLI: `npm i -g netlify-cli` → `npm install` → `netlify deploy --prod`

## 동작
- 처음 열면 숫자 키패드 잠금 화면 → 4자리 입력 → 30일 동안 로그인 유지 (홈의 **잠그기**로 바로 잠금)
- 5번 틀리면 그 기기(IP)는 15분 잠김, 전체적으로 1시간에 50번 넘게 틀리면 1시간 잠김
- 칩 PDF를 넣으면 바로 열리고 서버에 자동 등록 → 다른 기기에서 칩 코드로 열기
- PDF는 3MB씩 나눠서 저장 (Netlify Functions 요청 크기 제한 때문)
- AI 검증 결과·과제 요약도 서버에 같이 저장됨

## 참고
- 비밀번호를 바꾸면 모든 기기가 로그아웃돼요.
- 저장된 칩은 Netlify 대시보드 → Blobs → `hwviewer` 저장소에서 볼 수 있어요.
