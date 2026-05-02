// worker.js
// Cloudflare Worker - 多用户提醒推送系统 (删除页脚和GitHub按钮，保留右下角悬浮GitHub)

// ---------- 工具函数 ----------
function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(hash);
}
function generateToken() {
  return crypto.randomUUID();
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function textResponse(text, status = 200, contentType = 'text/plain') {
  return new Response(text, { status, headers: { 'Content-Type': contentType } });
}
function getBearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// ---------- 认证中间件 ----------
async function authenticate(request, env) {
  const token = getBearerToken(request);
  if (!token) return null;
  const stmt = env.DB.prepare('SELECT id FROM users WHERE api_token = ?').bind(token);
  const user = await stmt.first();
  return user ? user.id : null;
}

// ---------- 路由处理 ----------
async function handleRegister(request, env) {
  const body = await request.json();
  const { username, password } = body || {};
  if (!username || !password) return jsonResponse({ error: '用户名和密码不能为空' }, 400);
  const passwordHash = await sha256(password);
  const apiToken = generateToken();
  try {
    await env.DB.prepare('INSERT INTO users (username, password_hash, api_token) VALUES (?, ?, ?)')
      .bind(username, passwordHash, apiToken).run();
    return jsonResponse({ api_token: apiToken }, 201);
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed')) return jsonResponse({ error: '用户名已存在' }, 409);
    return jsonResponse({ error: '注册失败' }, 500);
  }
}
async function handleLogin(request, env) {
  const body = await request.json();
  const { username, password } = body || {};
  if (!username || !password) return jsonResponse({ error: '用户名和密码不能为空' }, 400);
  const passwordHash = await sha256(password);
  const user = await env.DB.prepare('SELECT api_token FROM users WHERE username = ? AND password_hash = ?')
    .bind(username, passwordHash).first();
  if (!user) return jsonResponse({ error: '用户名或密码错误' }, 401);
  return jsonResponse({ api_token: user.api_token });
}
async function handleGetTokens(userId, env) {
  const tokens = await env.DB.prepare('SELECT id, token, note FROM pushplus_tokens WHERE user_id = ? ORDER BY created_at DESC')
    .bind(userId).all();
  return jsonResponse(tokens.results);
}
async function handleAddToken(userId, request, env) {
  const body = await request.json();
  const { token, note } = body || {};
  if (!token) return jsonResponse({ error: 'token 不能为空' }, 400);
  const result = await env.DB.prepare('INSERT INTO pushplus_tokens (user_id, token, note) VALUES (?, ?, ?)')
    .bind(userId, token, note || '').run();
  return jsonResponse({ id: result.meta.last_row_id, token, note }, 201);
}
async function handleDeleteToken(userId, tokenId, env) {
  const record = await env.DB.prepare('SELECT id FROM pushplus_tokens WHERE id = ? AND user_id = ?')
    .bind(tokenId, userId).first();
  if (!record) return jsonResponse({ error: '令牌不存在或无权操作' }, 404);
  await env.DB.prepare('DELETE FROM reminders WHERE pushplus_token_id = ?').bind(tokenId).run();
  await env.DB.prepare('DELETE FROM pushplus_tokens WHERE id = ?').bind(tokenId).run();
  return jsonResponse({ success: true });
}
async function handleTestToken(userId, tokenId, env) {
  const record = await env.DB.prepare('SELECT token FROM pushplus_tokens WHERE id = ? AND user_id = ?')
    .bind(tokenId, userId).first();
  if (!record) return jsonResponse({ error: '令牌不存在或无权操作' }, 404);
  try {
    await sendPushplus(record.token, '这是一条推送测试标题', '这是一条推送测试内容');
    return jsonResponse({ success: true, message: '测试推送已发送' });
  } catch (e) {
    return jsonResponse({ error: '推送失败: ' + e.message }, 500);
  }
}
async function handleGetReminders(userId, env) {
  const reminders = await env.DB.prepare(
    `SELECT r.id, r.title, r.content, r.start_time, r.interval_hours, r.status, r.next_remind_time, r.created_at,
            pt.token as pushplus_token, pt.note as pushplus_note
     FROM reminders r JOIN pushplus_tokens pt ON r.pushplus_token_id = pt.id
     WHERE r.user_id = ? ORDER BY r.created_at DESC`
  ).bind(userId).all();
  return jsonResponse(reminders.results);
}
async function handleCreateReminder(userId, request, env) {
  const body = await request.json();
  const { pushplus_token_id, title, content, start_time, interval_hours } = body || {};
  if (!pushplus_token_id || !title || !start_time || interval_hours == null)
    return jsonResponse({ error: '缺少必要字段' }, 400);
  const tokenRecord = await env.DB.prepare('SELECT id FROM pushplus_tokens WHERE id = ? AND user_id = ?')
    .bind(pushplus_token_id, userId).first();
  if (!tokenRecord) return jsonResponse({ error: 'Pushplus 令牌无效' }, 400);
  const result = await env.DB.prepare(
    `INSERT INTO reminders (user_id, pushplus_token_id, title, content, start_time, interval_hours, status, next_remind_time)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(userId, pushplus_token_id, title, content || '', start_time, interval_hours, start_time).run();
  return jsonResponse({ id: result.meta.last_row_id }, 201);
}
async function handleCompleteReminder(userId, reminderId, env) {
  const record = await env.DB.prepare('SELECT id, status FROM reminders WHERE id = ? AND user_id = ?')
    .bind(reminderId, userId).first();
  if (!record) return jsonResponse({ error: '提醒不存在或无权操作' }, 404);
  if (record.status === 'completed') return jsonResponse({ error: '提醒已完成' }, 400);
  await env.DB.prepare("UPDATE reminders SET status = 'completed' WHERE id = ?").bind(reminderId).run();
  return jsonResponse({ success: true });
}
async function handleDeleteReminder(userId, reminderId, env) {
  const record = await env.DB.prepare('SELECT id FROM reminders WHERE id = ? AND user_id = ?')
    .bind(reminderId, userId).first();
  if (!record) return jsonResponse({ error: '提醒不存在或无权操作' }, 404);
  await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(reminderId).run();
  return jsonResponse({ success: true });
}

// ---------- 定时推送 ----------
async function handleScheduled(env) {
  const now = new Date().toISOString();
  const pending = await env.DB.prepare(
    `SELECT r.id, r.title, r.content, r.interval_hours, r.start_time, pt.token as pushplus_token
     FROM reminders r JOIN pushplus_tokens pt ON r.pushplus_token_id = pt.id
     WHERE r.status = 'pending' AND r.start_time <= ?`
  ).bind(now).all();
  for (const rem of pending.results) {
    await env.DB.prepare("UPDATE reminders SET status = 'active' WHERE id = ?").bind(rem.id).run();
    try {
      await sendPushplus(rem.pushplus_token, rem.title, rem.content + '\n---\n来自https://tixing.orz.lc');
    } catch (e) { console.error(e); }
    if (rem.interval_hours === 0) {
      await env.DB.prepare("UPDATE reminders SET status = 'completed' WHERE id = ?").bind(rem.id).run();
    } else {
      const next = new Date(Date.now() + rem.interval_hours * 3600 * 1000).toISOString();
      await env.DB.prepare('UPDATE reminders SET next_remind_time = ? WHERE id = ?').bind(next, rem.id).run();
    }
  }
  const active = await env.DB.prepare(
    `SELECT r.id, r.title, r.content, r.next_remind_time, r.interval_hours, pt.token as pushplus_token
     FROM reminders r JOIN pushplus_tokens pt ON r.pushplus_token_id = pt.id
     WHERE r.status = 'active' AND r.next_remind_time <= ? AND r.interval_hours > 0`
  ).bind(now).all();
  for (const rem of active.results) {
    const newNext = new Date(new Date(rem.next_remind_time).getTime() + rem.interval_hours * 3600 * 1000).toISOString();
    await env.DB.prepare('UPDATE reminders SET next_remind_time = ? WHERE id = ?').bind(newNext, rem.id).run();
    try {
      await sendPushplus(rem.pushplus_token, rem.title, rem.content + '\n---\n来自https://tixing.orz.lc');
    } catch (e) { console.error(e); }
  }
}

async function sendPushplus(token, title, content) {
  const res = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, title, content }),
  });
  if (!res.ok) throw new Error(`Pushplus 响应状态 ${res.status}`);
  return res.json();
}

// ---------- 前端 HTML (删除页脚和多余GitHub按钮) ----------
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tixing.Orz.lc</title>
  <style>
    :root {
      --red: #f3533b;
      --orange: #fa9f42;
      --green: #8dd67a;
      --teal: #5acec9;
      --black: #111;
      --gray-light: #f5f5f5;
      --gray-border: #ddd;
      --text: #222;
      --text-light: #555;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif;
      background: var(--gray-light);
      color: var(--text);
      line-height: 1.6;
    }
    .container { max-width: 960px; margin: 2rem auto; padding: 0 1.5rem 4rem; }
    h1 {
      text-align: center;
      font-weight: 800;
      font-size: 2rem;
      margin-bottom: 2rem;
      color: var(--black);
    }
    .card {
      background: #fff;
      border-radius: 20px;
      border: 1px solid var(--gray-border);
      box-shadow: 0 6px 24px rgba(0,0,0,0.06);
      padding: 2rem;
      margin-bottom: 1.75rem;
      transition: box-shadow 0.3s ease;
    }
    .card:hover { box-shadow: 0 10px 32px rgba(0,0,0,0.1); }
    .card h2 {
      font-size: 1.3rem;
      font-weight: 600;
      margin-bottom: 1.25rem;
      color: var(--black);
      padding-bottom: 0.5rem;
      border-bottom: 2px solid var(--orange);
    }
    .form-group { margin-bottom: 1.25rem; }
    label {
      display: block;
      font-weight: 600;
      margin-bottom: 0.35rem;
      color: var(--text);
      font-size: 0.9rem;
    }
    .input-hint {
      font-weight: 400;
      color: var(--text-light);
      font-size: 0.8rem;
      margin-left: 0.25rem;
    }
    input, select, textarea {
      width: 100%;
      padding: 0.75rem 1rem;
      font-size: 1rem;
      font-family: inherit;
      border: 1px solid var(--gray-border);
      border-radius: 12px;
      background: #fff;
      transition: all 0.2s ease;
      outline: none;
      color: var(--black);
    }
    input:focus, select:focus, textarea:focus {
      border-color: var(--teal);
      box-shadow: 0 0 0 3px rgba(90,206,201,0.3);
      transform: scale(1.01);
    }
    textarea { resize: vertical; min-height: 80px; }

    input[type="datetime-local"] {
      -webkit-appearance: none;
      appearance: none;
      cursor: pointer;
    }
    input[type="datetime-local"]::-webkit-calendar-picker-indicator {
      cursor: pointer;
      color: var(--orange);
      opacity: 0.9;
    }

    button {
      padding: 0.7rem 1.5rem;
      font-size: 1rem;
      font-weight: 600;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      background: var(--red);
      color: white;
      transition: all 0.15s ease;
      font-family: inherit;
      letter-spacing: 0.02em;
    }
    button:hover {
      background: #e0442e;
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(243,83,59,0.3);
    }
    button:active { transform: scale(0.98); }

    button.danger { background: var(--red); }
    button.danger:hover { background: #e0442e; box-shadow: 0 6px 16px rgba(243,83,59,0.4); }
    button.success { background: var(--green); color: #000; }
    button.success:hover { background: #7cc86a; box-shadow: 0 6px 16px rgba(141,214,122,0.4); }
    button.light { background: #eee; color: var(--black); }
    button.light:hover { background: #ddd; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
    button.info { background: var(--teal); color: #000; }
    button.info:hover { background: #4abcbc; box-shadow: 0 6px 16px rgba(90,206,201,0.4); }

    .actions button {
      padding: 0.35rem 0.8rem;
      font-size: 0.85rem;
      margin-right: 0.4rem;
      border-radius: 8px;
    }

    .hidden { display: none !important; }

    .auth-switch { margin-bottom: 1.5rem; display: flex; gap: 0.5rem; }
    .auth-switch button { flex: 1; }

    .toolbar {
      display: flex;
      gap: 0.75rem;
      margin-bottom: 1.75rem;
      align-items: center;
      flex-wrap: wrap;
    }
    .toolbar-spacer { flex: 1; }

    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .checkbox-group input[type="checkbox"] {
      width: 1.2rem;
      height: 1.2rem;
      accent-color: var(--orange);
    }
    .checkbox-group label {
      margin-bottom: 0;
      font-weight: 500;
      cursor: pointer;
    }
    #interval-wrapper { transition: opacity 0.2s; }

    /* 协议区域 */
    .agreement-box {
      border: 1px solid var(--gray-border);
      border-radius: 10px;
      padding: 0.8rem;
      margin-bottom: 0.75rem;
      max-height: 130px;
      overflow-y: auto;
      font-size: 0.8rem;
      color: var(--text-light);
      background: #fafafa;
      line-height: 1.5;
    }
    .agreement-box p { margin-bottom: 0.3rem; }

    /* 提醒卡片 */
    .reminder-list {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      margin-top: 1rem;
    }
    .reminder-card {
      background: #fff;
      border: 1px solid var(--gray-border);
      border-radius: 14px;
      padding: 1rem 1.25rem;
      transition: box-shadow 0.2s;
      border-left: 5px solid var(--teal);
    }
    .reminder-card.status-active { border-left-color: var(--green); }
    .reminder-card.status-completed { border-left-color: #ccc; opacity: 0.8; }
    .reminder-row {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      margin-bottom: 0.4rem;
    }
    .reminder-label {
      font-weight: 600;
      color: var(--black);
      min-width: 5rem;
      margin-right: 0.5rem;
    }
    .reminder-value { color: var(--text); word-break: break-word; }
    .reminder-badge {
      display: inline-block;
      padding: 0.15rem 0.7rem;
      border-radius: 20px;
      font-size: 0.8rem;
      font-weight: 600;
      margin-left: 0.5rem;
    }
    .badge-pending { background: #fff3e0; color: var(--orange); }
    .badge-active { background: #e8f5e9; color: #2e7d32; }
    .badge-completed { background: #f1f1f1; color: var(--text-light); }
    .reminder-actions {
      margin-top: 0.75rem;
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
    }
    .reminder-actions button {
      padding: 0.35rem 0.8rem;
      font-size: 0.85rem;
      border-radius: 8px;
    }

    /* 表格 */
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td {
      padding: 0.9rem 0.75rem;
      text-align: left;
      border-bottom: 1px solid var(--gray-border);
      vertical-align: middle;
    }
    th {
      background: #f0f0f0;
      font-weight: 600;
      color: var(--black);
      border-radius: 8px 8px 0 0;
    }

    .empty-state {
      text-align: center;
      padding: 2rem 1rem;
      color: var(--text-light);
      font-size: 0.95rem;
    }
    .empty-state .icon { font-size: 2rem; margin-bottom: 0.5rem; display: block; }

    .toast {
      position: fixed;
      bottom: 2rem;
      left: 50%;
      transform: translateX(-50%);
      background: var(--green);
      color: #000;
      padding: 0.75rem 1.5rem;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      font-weight: 600;
      z-index: 999;
      animation: slideUp 0.3s ease, fadeOut 0.3s 1.7s forwards;
    }
    @keyframes slideUp {
      from { transform: translateX(-50%) translateY(1rem); opacity: 0; }
      to { transform: translateX(-50%) translateY(0); opacity: 1; }
    }
    @keyframes fadeOut {
      to { opacity: 0; visibility: hidden; }
    }

    /* 右下角悬浮 GitHub 链接 */
    .github-corner {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: white;
      border: 1px solid var(--gray-border);
      border-radius: 50px;
      padding: 0.5rem 1.2rem;
      box-shadow: 0 4px 15px rgba(0,0,0,0.08);
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--text);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      z-index: 99;
      transition: all 0.2s ease;
    }
    .github-corner:hover {
      background: #f8f8f8;
      box-shadow: 0 6px 20px rgba(0,0,0,0.12);
      color: var(--red);
      border-color: var(--red);
    }

    @media (max-width: 640px) {
      .container { padding: 0 1rem 4rem; }
      .card { padding: 1.5rem; border-radius: 16px; }
      h1 {
        font-size: 1.5rem;
        margin-bottom: 1.5rem;
      }
      .toolbar button {
        padding: 0.5rem 0.85rem;
        font-size: 0.85rem;
      }
      .reminder-row {
        flex-direction: column;
        align-items: flex-start;
      }
      .reminder-label { min-width: auto; margin-bottom: 0.2rem; }
      .github-corner {
        bottom: 1rem;
        right: 1rem;
        padding: 0.4rem 1rem;
        font-size: 0.85rem;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Tixing.Orz.lc</h1>

    <div id="auth-section" class="card">
      <div class="auth-switch">
        <button id="show-login-btn" class="light">登录</button>
        <button id="show-register-btn" class="light">注册</button>
      </div>
      <div id="login-form">
        <h2>欢迎回来</h2>
        <div class="form-group">
          <label>用户名 <span class="input-hint">(最多20字符)</span></label>
          <input id="login-username" placeholder="输入用户名" maxlength="20" />
        </div>
        <div class="form-group">
          <label>密码 <span class="input-hint">(6-30位)</span></label>
          <input type="password" id="login-password" placeholder="输入密码" minlength="6" maxlength="30" />
        </div>
        <button id="login-btn">登录</button>
      </div>
      <div id="register-form" class="hidden">
        <h2>创建账号</h2>
        <div class="form-group">
          <label>用户名 <span class="input-hint">(最多20字符)</span></label>
          <input id="register-username" placeholder="输入用户名" maxlength="20" />
        </div>
        <div class="form-group">
          <label>密码 <span class="input-hint">(6-30位)</span></label>
          <input type="password" id="register-password" placeholder="输入密码" minlength="6" maxlength="30" />
        </div>
        <div class="form-group">
          <label>确认密码</label>
          <input type="password" id="register-password-confirm" placeholder="再次输入密码" minlength="6" maxlength="30" />
        </div>
        <div class="agreement-box">
          <p><strong>服务协议</strong></p>
          <p>1. 本站未进行加密，账号/密码/内容可能被破解，请勿保存敏感信息。</p>
          <p>2. 本站为非商业个人测试项目，不保证服务可用性。</p>
          <p>3. 用户自行承担数据丢失风险，本站不提供备份与恢复服务。</p>
          <p>4. 禁止使用本服务发送垃圾、违法或骚扰信息，违者后果自负。</p>
          <p>5. 本站保留随时修改或终止服务的权利，恕不另行通知。</p>
        </div>
        <div class="checkbox-group">
          <input type="checkbox" id="agreement-checkbox" />
          <label for="agreement-checkbox">我同意以上协议</label>
        </div>
        <button id="register-btn">注册</button>
      </div>
    </div>

    <div id="app-section" class="hidden">
      <div class="toolbar">
        <button id="show-token-btn" class="light">📱 管理令牌</button>
        <button id="show-reminders-btn" class="light">📋 我的提醒</button>
        <div class="toolbar-spacer"></div>
        <button id="logout-btn" class="danger">🚪 退出登录</button>
      </div>

      <div id="token-card" class="card hidden">
        <h2>📱 Pushplus 令牌管理</h2>
        <div class="form-group"><label>Pushplus Token</label><input id="new-token" placeholder="粘贴你的推送令牌" /></div>
        <div class="form-group"><label>备注</label><input id="new-token-note" placeholder="例如：工作、个人" /></div>
        <button id="add-token-btn" style="width:100%">添加令牌</button>
        <table id="token-table">
          <thead><tr><th>Token</th><th>备注</th><th>操作</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div id="reminders-card" class="card hidden">
        <h2>📋 我的提醒</h2>
        <div id="reminder-list" class="reminder-list"></div>
      </div>

      <div class="card">
        <h2>📝 创建提醒</h2>
        <div class="form-group"><label>推送渠道</label><select id="remind-token-select"></select></div>
        <div class="form-group">
          <label>提醒标题 <span class="input-hint">(最多50字符)</span></label>
          <input id="remind-title" placeholder="提醒标题" maxlength="50" />
        </div>
        <div class="form-group">
          <label>提醒内容 <span class="input-hint">(最多200字符)</span></label>
          <textarea id="remind-content" placeholder="可选，描述提醒详情" maxlength="200"></textarea>
        </div>
        <div class="form-group"><label>开始提醒时间</label><input type="datetime-local" id="remind-start" /></div>
        
        <div class="checkbox-group">
          <input type="checkbox" id="repeat-checkbox" checked />
          <label for="repeat-checkbox">开启持续提醒</label>
        </div>
        <div id="interval-wrapper" class="form-group">
          <label>提醒间隔（小时）<span class="input-hint">(1-8999 整数)</span></label>
          <input type="number" id="remind-interval" value="1" min="1" max="8999" step="1" placeholder="1-8999" />
        </div>
        
        <button id="create-reminder-btn" style="width:100%">创建提醒</button>
      </div>
    </div>
  </div>

  <!-- 右下角悬浮 GitHub 链接 -->
  <a href="https://github.com/2DOG-G/timed_reminders_cloudflare" class="github-corner" target="_blank" rel="noopener noreferrer">
    <span>🐙</span> GitHub
  </a>

  <script>
    let apiToken = localStorage.getItem('api_token') || '';
    const $ = (sel) => document.querySelector(sel);

    function setDefaultTime() {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      const year = tomorrow.getFullYear();
      const month = String(tomorrow.getMonth() + 1).padStart(2, '0');
      const day = String(tomorrow.getDate()).padStart(2, '0');
      const hours = String(tomorrow.getHours()).padStart(2, '0');
      const minutes = String(tomorrow.getMinutes()).padStart(2, '0');
      const value = \`\${year}-\${month}-\${day}T\${hours}:\${minutes}\`;
      const input = $('#remind-start');
      if (input && !input.value) input.value = value;
    }

    function toggleAuthForms(showLogin) {
      $('#login-form').classList.toggle('hidden', !showLogin);
      $('#register-form').classList.toggle('hidden', showLogin);
    }

    function showToast(message) {
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 2000);
    }

    async function init() {
      if (apiToken) {
        $('#auth-section').classList.add('hidden');
        $('#app-section').classList.remove('hidden');
        setDefaultTime();

        const checkbox = $('#repeat-checkbox');
        const intervalWrapper = $('#interval-wrapper');
        checkbox.addEventListener('change', () => {
          intervalWrapper.classList.toggle('hidden', !checkbox.checked);
        });
        intervalWrapper.classList.toggle('hidden', !checkbox.checked);

        const tokenBtn = document.getElementById('show-token-btn');
        const remindersBtn = document.getElementById('show-reminders-btn');
        const tokenCard = document.getElementById('token-card');
        const remindersCard = document.getElementById('reminders-card');

        tokenBtn.addEventListener('click', () => {
          const isHidden = tokenCard.classList.toggle('hidden');
          tokenBtn.style.backgroundColor = isHidden ? '' : '#ddd';
        });
        remindersBtn.addEventListener('click', () => {
          const isHidden = remindersCard.classList.toggle('hidden');
          remindersBtn.style.backgroundColor = isHidden ? '' : '#ddd';
        });

        await loadTokens();
        await loadReminders();
      } else {
        $('#auth-section').classList.remove('hidden');
        $('#app-section').classList.add('hidden');
        toggleAuthForms(true);
      }
    }

    async function apiFetch(url, options = {}) {
      if (!options.headers) options.headers = {};
      options.headers['Content-Type'] = 'application/json';
      if (apiToken) options.headers['Authorization'] = 'Bearer ' + apiToken;
      const res = await fetch(url, options);
      if (res.status === 401) {
        alert('登录已过期，请重新登录');
        localStorage.removeItem('api_token');
        apiToken = '';
        init();
        return null;
      }
      return res;
    }

    $('#register-btn').addEventListener('click', async () => {
      const username = $('#register-username').value.trim();
      const password = $('#register-password').value;
      const passwordConfirm = $('#register-password-confirm').value;
      const agreementChecked = $('#agreement-checkbox').checked;

      if (!username || !password) return alert('请填写完整');
      if (password.length < 6) return alert('密码至少6位');
      if (password !== passwordConfirm) return alert('两次输入的密码不一致');
      if (!agreementChecked) return alert('请阅读并同意服务协议');

      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        const data = await res.json();
        apiToken = data.api_token;
        localStorage.setItem('api_token', apiToken);
        init();
      } else {
        const err = await res.json();
        alert(err.error || '注册失败');
      }
    });

    $('#login-btn').addEventListener('click', async () => {
      const username = $('#login-username').value.trim();
      const password = $('#login-password').value;
      if (!username || !password) return alert('请填写完整');
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        const data = await res.json();
        apiToken = data.api_token;
        localStorage.setItem('api_token', apiToken);
        init();
      } else {
        const err = await res.json();
        alert(err.error || '登录失败');
      }
    });

    $('#show-login-btn').addEventListener('click', () => toggleAuthForms(true));
    $('#show-register-btn').addEventListener('click', () => toggleAuthForms(false));

    $('#logout-btn').addEventListener('click', () => {
      localStorage.removeItem('api_token');
      apiToken = '';
      init();
    });

    function formatNextTime(isoStr) {
      if (!isoStr) return '-';
      const d = new Date(isoStr);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      return \`\${yyyy}-\${mm}-\${dd} \${hh}-\${min}\`;
    }

    function getStatusBadge(status) {
      const map = {
        pending: { text: '等待中', className: 'badge-pending' },
        active: { text: '进行中', className: 'badge-active' },
        completed: { text: '已完成', className: 'badge-completed' }
      };
      const info = map[status] || { text: status, className: '' };
      return \`<span class="reminder-badge \${info.className}">\${info.text}</span>\`;
    }

    async function loadTokens() {
      const res = await apiFetch('/api/tokens');
      if (!res) return;
      const tokens = await res.json();
      const tbody = $('#token-table tbody');
      const select = $('#remind-token-select');
      tbody.innerHTML = '';
      select.innerHTML = '';
      if (tokens.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3"><div class="empty-state"><span class="icon">📭</span>还没有令牌，请添加第一个</div></td></tr>';
      } else {
        tokens.forEach(t => {
          tbody.innerHTML += \`<tr>
            <td>\${maskToken(t.token)}</td>
            <td>\${escapeHtml(t.note)}</td>
            <td class="actions">
              <button class="info" data-id="\${t.id}" onclick="testToken(this)">测试</button>
              <button class="danger" data-id="\${t.id}" onclick="deleteToken(this)">删除</button>
            </td>
          </tr>\`;
          select.innerHTML += \`<option value="\${t.id}">\${escapeHtml(t.note)} (\${maskToken(t.token)})</option>\`;
        });
      }
    }

    window.testToken = async function(btn) {
      const id = btn.dataset.id;
      const res = await apiFetch('/api/tokens/' + id + '/test', { method: 'POST' });
      if (res && res.ok) {
        showToast('测试推送已发送');
      } else {
        const err = await res.json();
        alert('测试失败: ' + (err.error || '未知错误'));
      }
    };

    $('#add-token-btn').addEventListener('click', async () => {
      const token = $('#new-token').value.trim();
      const note = $('#new-token-note').value.trim();
      if (!token) return alert('请输入 Token');
      const res = await apiFetch('/api/tokens', {
        method: 'POST',
        body: JSON.stringify({ token, note }),
      });
      if (res && res.ok) {
        $('#new-token').value = '';
        $('#new-token-note').value = '';
        showToast('令牌添加成功');
        await loadTokens();
      } else alert('添加失败');
    });

    window.deleteToken = async function(btn) {
      const id = btn.dataset.id;
      if (!confirm('删除该令牌将同时删除相关提醒，确认？')) return;
      const res = await apiFetch('/api/tokens/' + id, { method: 'DELETE' });
      if (res && res.ok) { 
        showToast('令牌已删除');
        await loadTokens(); 
        await loadReminders(); 
      }
      else alert('删除失败');
    };

    async function loadReminders() {
      const res = await apiFetch('/api/reminders');
      if (!res) return;
      const reminders = await res.json();
      const container = $('#reminder-list');
      container.innerHTML = '';
      if (reminders.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="icon">📋</span>还没有提醒，快创建一个吧</div>';
        return;
      }
      reminders.forEach(r => {
        const repeatIcon = r.interval_hours > 0 ? '✅' : '❌';
        const intervalDisplay = r.interval_hours > 0 ? \`每 \${r.interval_hours} 小时\` : '-';
        const statusClass = 'status-' + r.status;
        const card = document.createElement('div');
        card.className = \`reminder-card \${statusClass}\`;
        card.innerHTML = \`
          <div class="reminder-row">
            <span class="reminder-label">提醒标题</span>
            <span class="reminder-value">\${escapeHtml(r.title)} \${getStatusBadge(r.status)}</span>
          </div>
          <div class="reminder-row">
            <span class="reminder-label">提醒内容</span>
            <span class="reminder-value">\${escapeHtml(r.content) || '-'}</span>
          </div>
          <div class="reminder-row">
            <span class="reminder-label">下次提醒</span>
            <span class="reminder-value">\${formatNextTime(r.next_remind_time)}</span>
          </div>
          <div class="reminder-row">
            <span class="reminder-label">持续提醒</span>
            <span class="reminder-value">\${repeatIcon}</span>
          </div>
          <div class="reminder-row">
            <span class="reminder-label">间隔时间</span>
            <span class="reminder-value">\${intervalDisplay}</span>
          </div>
          <div class="reminder-row">
            <span class="reminder-label">推送渠道</span>
            <span class="reminder-value">\${escapeHtml(r.pushplus_note)}</span>
          </div>
          <div class="reminder-actions">
            \${r.status !== 'completed' ? \`<button class="success" data-id="\${r.id}" onclick="completeReminder(this)">✓ 完成</button>\` : ''}
            <button class="danger" data-id="\${r.id}" onclick="deleteReminder(this)">删除</button>
          </div>
        \`;
        container.appendChild(card);
      });
    }

    $('#create-reminder-btn').addEventListener('click', async () => {
      const pushplus_token_id = $('#remind-token-select').value;
      const title = $('#remind-title').value.trim();
      const content = $('#remind-content').value.trim();
      const start_time_local = $('#remind-start').value;
      const repeatCheckbox = $('#repeat-checkbox');
      const intervalStr = $('#remind-interval').value.trim();
      const interval_hours = repeatCheckbox.checked ? parseInt(intervalStr, 10) : 0;

      if (!pushplus_token_id || !title || !start_time_local) {
        return alert('请完整填写必要信息');
      }
      if (repeatCheckbox.checked) {
        // 必须为正整数且范围 1-8999，通过正则检查原始输入
        if (!/^\\d+$/.test(intervalStr)) {
          return alert('提醒间隔必须为整数');
        }
        const val = parseInt(intervalStr, 10);
        if (val < 1 || val >= 9000) {
          return alert('持续提醒间隔必须为 1 ~ 8999 的正整数');
        }
      }
      const start_time = new Date(start_time_local).toISOString();
      const res = await apiFetch('/api/reminders', {
        method: 'POST',
        body: JSON.stringify({ pushplus_token_id, title, content, start_time, interval_hours }),
      });
      if (res && res.ok) {
        $('#remind-title').value = '';
        $('#remind-content').value = '';
        $('#remind-start').value = '';
        setDefaultTime();
        $('#remind-interval').value = '1';
        $('#repeat-checkbox').checked = true;
        $('#interval-wrapper').classList.remove('hidden');
        showToast('提醒创建成功');
        await loadReminders();
      } else alert('创建失败');
    });

    window.completeReminder = async function(btn) {
      const id = btn.dataset.id;
      const res = await apiFetch('/api/reminders/' + id + '/complete', { method: 'PUT' });
      if (res && res.ok) {
        showToast('提醒已标记完成');
        await loadReminders();
      }
      else alert('操作失败');
    };

    window.deleteReminder = async function(btn) {
      const id = btn.dataset.id;
      if (!confirm('确认删除该提醒？')) return;
      const res = await apiFetch('/api/reminders/' + id, { method: 'DELETE' });
      if (res && res.ok) {
        showToast('提醒已删除');
        await loadReminders();
      }
      else alert('删除失败');
    };

    function maskToken(token) {
      if (token.length <= 8) return token;
      return token.substring(0, 4) + '****' + token.substring(token.length - 4);
    }
    function escapeHtml(str) {
      return String(str).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
    }

    init();
  </script>
</body>
</html>`;

// ---------- 主 Worker ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'GET' && path === '/') return textResponse(FRONTEND_HTML, 200, 'text/html; charset=utf-8');
    if (method === 'POST' && path === '/api/register') return handleRegister(request, env);
    if (method === 'POST' && path === '/api/login') return handleLogin(request, env);

    const userId = await authenticate(request, env);
    if (!userId) return jsonResponse({ error: '未授权' }, 401);

    if (method === 'GET' && path === '/api/tokens') return handleGetTokens(userId, env);
    if (method === 'POST' && path === '/api/tokens') return handleAddToken(userId, request, env);

    const testTokenMatch = path.match(/^\/api\/tokens\/(\d+)\/test$/);
    if (method === 'POST' && testTokenMatch) return handleTestToken(userId, testTokenMatch[1], env);

    const tokenMatch = path.match(/^\/api\/tokens\/(\d+)$/);
    if (method === 'DELETE' && tokenMatch) return handleDeleteToken(userId, tokenMatch[1], env);

    if (method === 'GET' && path === '/api/reminders') return handleGetReminders(userId, env);
    if (method === 'POST' && path === '/api/reminders') return handleCreateReminder(userId, request, env);
    const completeMatch = path.match(/^\/api\/reminders\/(\d+)\/complete$/);
    if (method === 'PUT' && completeMatch) return handleCompleteReminder(userId, completeMatch[1], env);
    const deleteMatch = path.match(/^\/api\/reminders\/(\d+)$/);
    if (method === 'DELETE' && deleteMatch) return handleDeleteReminder(userId, deleteMatch[1], env);

    return new Response('Not Found', { status: 404 });
  },
  async scheduled(event, env) {
    await handleScheduled(env);
  }
};
