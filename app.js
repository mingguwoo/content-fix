const PUBLIC_CONFIG = {
  endpoint: 'https://content-distiller.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_eCNGr4irgwVg07udbv4LMe_XOylNjsfB9BGG6OuAtTyBRR8CZ25kvkl'
};

const MAX_INPUT = 20000;
const MAX_SECTIONS = 12;
const NODE_TIMEOUT = 120000;
const TRIAL_KEY = 'cd_trial_used_v1'; // 游客免费体验是否已使用（本地记录，仅防重复刷新）
const VIP_PHONES = ['18702103770']; // 无限次使用白名单

const NODES = [
  { id: 'n0', name: '风格识别', desc: '读懂原文，判定行业/领域/深度/语体，生成表达策略', temp: 0.2, on: true },
  { id: 'n1', name: '结构抽取', desc: '解析杂乱原文，抽出主题与全部事实点', temp: 0.2, on: true },
  { id: 'n2', name: '核心压缩', desc: '按表达策略改写为一句话主干 + 一级结论', temp: 0.4, on: true, required: true },
  { id: 'n3', name: '细节分层', desc: '把细节下钻为二级 / 三级，确保不遗漏', temp: 0.3, on: true },
  { id: 'n4', name: '质量校验', desc: '回查原文补漏纠错，产出终稿', temp: 0.2, on: true }
];

const SAMPLE = `自动驾驶的模型训练需要使用高质量有标注的数据集，采集车直采的数据不能直接使用，须经过"预处理"：
1.格式不满足（采集的格式：MCAP/PCAP/ROSbag），须经过格式解析/转换/抽帧后形成帧、点云、图像等，标注平台才可打开进行标注。
2.对采集的数据做切分和筛选，不同采集硬件数据对其抽帧等方式，得到根据规则和场景需要标注的有效数据片段，可减少训练数据量，降低训练成本
3.提前做前置校验，拦截和过滤重复数据、缺失关键传感器topic，数据包损坏等，规避训练的资源浪费
4.搭建固定处理链路，保证数据集质量和环节可追溯。
采集车包括前2、左2、右2、后1高清摄像头，前激光雷达1，毫米波雷达若干，每个摄像头采集频率不同，时长不同，起始时间不同。数据通过专线上传到S3云端存储，2小时包、4小时包，TB量级不能同时处理，只能切片成clip片段。`;

const PREFERRED = {
  n0: ['deepseek-v4-pro', 'glm-5.3', 'kimi-k2.7', 'auto'],
  n1: ['deepseek-v4-pro', 'glm-5.3', 'kimi-k2.7', 'auto'],
  n2: ['kimi-k2.7', 'glm-5.2', 'auto'],
  n3: ['glm-5.3', 'deepseek-v4-pro', 'auto'],
  n4: ['deepseek-v4-pro', 'glm-5.3', 'auto']
};

const state = {
  cloud: null,
  models: [],
  modelPick: {},
  controller: null,
  running: false,
  stopping: false,
  result: null,
  logs: [],
  treeDepth: 2,
  stepsExpanded: false,
  profile: null,
  trialUsed: readTrial(),
  session: null,
  quota: { granted: 0, used: 0, remaining: 0 },
  loginWay: 'phone',
  pendingOtp: null
};

const $ = (id) => document.getElementById(id);

function readTrial() {
  try { return window.localStorage.getItem(TRIAL_KEY) === '1'; } catch (e) { return false; }
}

function writeTrial(used) {
  try { window.localStorage.setItem(TRIAL_KEY, used ? '1' : '0'); } catch (e) { /* 隐私模式忽略 */ }
}

// 用户点了「中止」：这类错误不能被节点的降级兜底吞掉，必须一路抛出到最外层
function isStop(e) {
  if (state.stopping) return true;
  if (!e) return false;
  if (e.name === 'AbortError' || e.code === 20) return true;
  return /abort/i.test(String(e.message || e.type || ''));
}

// 无限次用户白名单：手机号可能完整返回，也可能脱敏成 187****3770
function isVip() {
  const u = state.session && state.session.user;
  if (!u) return false;
  const p = String(u.phone || '');
  if (!p) return false;
  return VIP_PHONES.some(function (full) {
    if (p === full) return true;
    const masked = full.slice(0, 3) + '****' + full.slice(-4);
    return p === masked;
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function setStatus(text, kind) {
  const el = $('cloudStatus');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function addLog(title, text) {
  state.logs.push({ title, text });
  renderLogs();
}

function renderLogs() {
  const box = $('logView');
  box.innerHTML = '';
  if (!state.logs.length) {
    box.innerHTML = '<div class="empty">尚无执行记录。</div>';
    return;
  }
  state.logs.forEach((l) => {
    const item = document.createElement('div');
    item.className = 'log-item';
    const h = document.createElement('div');
    h.className = 'log-title';
    h.textContent = l.title;
    const p = document.createElement('pre');
    p.className = 'log-body';
    p.textContent = l.text || '';
    item.appendChild(h);
    item.appendChild(p);
    box.appendChild(item);
  });
}

function setStepsVisible(visible, finished) {
  const stepper = $('stepper');
  const toggle = $('btnToggleSteps');
  const line = $('stepLine');
  if (finished) {
    // 运行结束：默认收起为单行（usageTip 显示结果），可点击展开完整过程
    stepper.hidden = !state.stepsExpanded;
    line.hidden = true;
    toggle.hidden = false;
    toggle.textContent = state.stepsExpanded ? '收起执行过程 ▾' : '查看执行过程 ▸';
  } else if (visible) {
    // 运行中：默认单行（当前节点 + 进度），点击单行或按钮展开完整步骤
    stepper.hidden = !state.stepsExpanded;
    line.hidden = state.stepsExpanded;
    toggle.hidden = false;
    toggle.textContent = state.stepsExpanded ? '收起执行过程 ▾' : '展开执行过程 ▸';
  } else {
    stepper.hidden = true;
    line.hidden = true;
    toggle.hidden = true;
  }
}

function renderStepLine(activeId) {
  const line = $('stepLine');
  line.innerHTML = '';
  const idx = NODES.findIndex((n) => n.id === activeId);
  const cur = idx >= 0 ? NODES[idx] : null;
  const dot = document.createElement('span');
  dot.className = 'sl-dot';
  const name = document.createElement('span');
  name.className = 'sl-name';
  name.textContent = cur ? (cur.id.toUpperCase() + ' · ' + cur.name) : '准备中';
  const tail = document.createElement('span');
  tail.className = 'sl-tail';
  tail.textContent = cur ? ('进行中（' + (idx + 1) + '/' + NODES.length + '），点击展开') : '点击展开';
  line.appendChild(dot);
  line.appendChild(name);
  line.appendChild(tail);
}

function renderStepper(activeId) {
  renderStepLine(activeId);
  const ol = $('stepper');
  ol.innerHTML = '';
  NODES.forEach((n) => {
    const li = document.createElement('li');
    li.className = 'step';
    if (!n.on) li.classList.add('off');
    if (activeId === n.id) li.classList.add('running');
    if (n.done) li.classList.add('done');
    if (n.failed) li.classList.add('failed');
    const idx = document.createElement('span');
    idx.className = 'step-idx';
    idx.textContent = n.id.toUpperCase();
    const name = document.createElement('span');
    name.className = 'step-name';
    name.textContent = n.name;
    const desc = document.createElement('span');
    desc.className = 'step-desc';
    desc.textContent = n.desc + (n.on ? '' : '（已跳过）');
    li.appendChild(idx);
    li.appendChild(name);
    li.appendChild(desc);
    ol.appendChild(li);
  });
}

function renderPipeline() {
  const box = $('pipeline');
  box.innerHTML = '';
  NODES.forEach((n) => {
    const row = document.createElement('div');
    row.className = 'node';

    const head = document.createElement('div');
    head.className = 'node-head';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = n.on;
    cb.disabled = !!n.required;
    cb.addEventListener('change', () => { n.on = cb.checked; row.classList.toggle('off', !n.on); });

    const nm = document.createElement('b');
    nm.textContent = n.id.toUpperCase() + ' · ' + n.name;
    const ds = document.createElement('span');
    ds.className = 'node-desc';
    ds.textContent = n.desc;

    head.appendChild(cb);
    head.appendChild(nm);
    head.appendChild(ds);

    const ctrl = document.createElement('div');
    ctrl.className = 'node-ctrl';

    const sel = document.createElement('select');
    sel.className = 'sel';
    if (!state.models.length) {
      const o = document.createElement('option');
      o.textContent = '暂无可用模型';
      sel.appendChild(o);
      sel.disabled = true;
    } else {
      state.models.forEach((m) => {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = (m.name || m.id) + (m.disabled === true ? '（不可用）' : '');
        if (m.disabled === true) o.disabled = true;
        sel.appendChild(o);
      });
      sel.value = state.modelPick[n.id] || state.models[0].id;
      sel.addEventListener('change', () => { state.modelPick[n.id] = sel.value; });
    }

    const tl = document.createElement('label');
    tl.className = 'temp';
    tl.textContent = '温度';
    const ti = document.createElement('input');
    ti.type = 'number';
    ti.min = '0'; ti.max = '1'; ti.step = '0.1';
    ti.value = String(n.temp);
    ti.addEventListener('change', () => {
      const v = parseFloat(ti.value);
      n.temp = isNaN(v) ? 0.3 : Math.min(1, Math.max(0, v));
      ti.value = String(n.temp);
    });
    tl.appendChild(ti);

    ctrl.appendChild(sel);
    ctrl.appendChild(tl);

    row.appendChild(head);
    row.appendChild(ctrl);
    box.appendChild(row);
  });
}

function waitForSdk(timeoutMs) {
  return new Promise((resolve) => {
    if (typeof WorkBuddyCloud !== 'undefined') { resolve(true); return; }
    if (window.__sdkLoadFailed) { resolve(false); return; }
    const started = Date.now();
    const timer = setInterval(() => {
      if (typeof WorkBuddyCloud !== 'undefined') {
        clearInterval(timer);
        resolve(true);
      } else if (window.__sdkLoadFailed || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label || '请求超时')), ms))
  ]);
}

/* ---------- 账号与额度 ---------- */

function setAccountErr(text) {
  const el = $('accountErr');
  el.textContent = text || '';
  el.hidden = !text;
}

function setLoginTip(text, bad) {
  const el = $('loginTip');
  el.textContent = text || '';
  el.className = 'hint' + (bad ? ' bad' : '');
}

function setRedeemTip(text, bad) {
  const el = $('redeemTip');
  el.textContent = text || '';
  el.className = 'hint' + (bad ? ' bad' : '');
}

function renderAccount() {
  const logged = !!(state.session && state.session.user);
  $('loginView').hidden = logged;
  $('memberView').hidden = !logged;
  const label = $('accountLabel');
  const chip = $('accountQuota');
  const dot = $('accountDot');
  if (!logged) {
    const tip = state.trialUsed ? '游客 · 免费体验已用完' : '游客 · 可免费体验 1 次';
    $('quotaTip').textContent = tip;
    $('quotaTip').className = 'hint' + (state.trialUsed ? ' bad' : '');
    label.textContent = tip;
    chip.hidden = true;
    dot.className = 'acc-dot' + (state.trialUsed ? ' off' : '');
    return;
  }
  $('quotaTip').className = 'hint';
  const u = state.session.user || {};
  const name = u.name || u.phone || u.email || '已登录';
  const vip = isVip();
  $('quotaTip').textContent = u.phone || u.email || name;
  label.textContent = vip ? 'VIP · ' + name : name;
  chip.hidden = false;
  chip.textContent = vip ? '无限次' : (state.quota.remaining + ' 次可用');
  dot.className = 'acc-dot ' + (vip ? 'vip' : 'logged');
  $('quotaLeft').textContent = vip ? '∞' : String(state.quota.remaining);
}

// 顶部账号单行 → 展开/收起面板
function setAccountOpen(open) {
  const widget = $('accountWidget');
  const panel = $('accountPanel');
  const bar = $('accountBar');
  if (!widget || !panel) return;
  widget.classList.toggle('open', !!open);
  panel.hidden = !open;
  if (bar) bar.setAttribute('aria-expanded', open ? 'true' : 'false');
}

async function restoreAuth() {
  if (!state.cloud) return;
  try {
    const { data: session } = await state.cloud.auth.getSession();
    state.session = session || null;
    renderAccount();
    if (state.session) await loadQuota();
  } catch (e) {
    setLoginTip('登录状态读取失败，请刷新重试', true);
  }
}

async function loadQuota() {
  if (!state.cloud) return;
  const db = state.cloud.database;
  const red = await db.from('redemptions').select('quota_granted, expire_at');
  const cnt = await db.from('usage_logs').select('*', { count: 'exact', head: true }).eq('ok', true);
  const err = red.error || cnt.error;
  if (err) {
    if (err.code === '42P01') setRedeemTip('数据表尚未创建，请联系管理员', true);
    else setRedeemTip('额度读取失败：' + (err.message || '未知错误'), true);
    return;
  }
  const now = Date.now();
  const rows = red.data || [];
  const granted = rows.reduce((sum, r) => {
    if (r.expire_at && new Date(r.expire_at).getTime() < now) return sum;
    return sum + (r.quota_granted || 0);
  }, 0);
  const used = cnt.count || 0;
  state.quota = { granted: granted, used: used, remaining: Math.max(0, granted - used) };
  renderAccount();
}

function startSendCountdown() {
  const btn = $('btnSendCode');
  let left = 60;
  btn.disabled = true;
  btn.textContent = left + ' 秒后重发';
  const t = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(t);
      btn.disabled = false;
      btn.textContent = '获取验证码';
      return;
    }
    btn.textContent = left + ' 秒后重发';
  }, 1000);
}

async function sendCode() {
  if (!state.cloud) { setLoginTip('云服务尚未就绪', true); return; }
  const way = state.loginWay;
  const value = $('loginAccount').value.trim();
  if (way === 'phone') {
    if (!/^1\d{10}$/.test(value)) { setAccountErr('请输入正确的 11 位手机号'); return; }
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    setAccountErr('请输入正确的邮箱地址');
    return;
  }
  setAccountErr('');
  setLoginTip('正在发送验证码…');
  const sent = way === 'phone'
    ? await state.cloud.auth.sendOtp({ phone: value })
    : await state.cloud.auth.sendOtp({ email: value });
  if (sent.error) { setLoginTip(sent.error.message || '验证码发送失败', true); return; }
  state.pendingOtp = {
    way: way,
    value: value,
    verificationId: sent.data.verificationId,
    isExistingUser: sent.data.isExistingUser
  };
  setLoginTip('验证码已发送，请查收');
  startSendCountdown();
}

async function submitLogin() {
  if (!state.cloud) { setLoginTip('云服务尚未就绪', true); return; }
  const way = state.loginWay;
  const value = $('loginAccount').value.trim();
  const token = $('loginCode').value.trim();
  const pending = state.pendingOtp;
  if (!pending || pending.way !== way || pending.value !== value) {
    setLoginTip('请先为当前账号获取验证码', true);
    return;
  }
  if (!token) { setLoginTip('请输入验证码', true); return; }
  setLoginTip('正在登录…');
  const base = {
    verificationId: pending.verificationId,
    isExistingUser: pending.isExistingUser,
    token: token
  };
  const done = way === 'phone'
    ? await state.cloud.auth.verifyOtp(Object.assign({ phone: value }, base))
    : await state.cloud.auth.verifyOtp(Object.assign({ email: value }, base));
  if (done.error) { setLoginTip(done.error.message || '验证码错误或已过期', true); return; }
  state.pendingOtp = null;
  $('loginCode').value = '';
  setLoginTip('登录成功');
  const { data: session } = await state.cloud.auth.getSession();
  state.session = session || null;
  renderAccount();
  await loadQuota();
  setAccountOpen(false); // 收起面板，顶部单行即时反映登录态
}

async function redeemLicense() {
  if (!state.cloud || !state.session) { setRedeemTip('请先登录', true); return; }
  const code = $('licenseCode').value.trim();
  if (!code) { setRedeemTip('请输入授权码', true); return; }
  setRedeemTip('正在兑换…');
  const { data, error } = await state.cloud.database.rpc('redeem_license', { p_code: code });
  if (error) { setRedeemTip('兑换失败：' + (error.message || '未知错误'), true); return; }
  const res = Array.isArray(data) ? data[0] : data;
  if (!res || res.ok !== true) { setRedeemTip((res && res.msg) || '兑换失败', true); return; }
  $('licenseCode').value = '';
  await loadQuota();
  setRedeemTip('兑换成功，新增 ' + res.quota + ' 次额度');
}

async function doSignOut() {
  if (!state.cloud) return;
  await state.cloud.auth.signOut();
  state.session = null;
  state.pendingOtp = null;
  state.quota = { granted: 0, used: 0, remaining: 0 };
  renderAccount();
  setLoginTip('');
}

async function recordUsage(rawLen, startedAt) {
  if (!state.session) {
    // 游客体验：usage_logs 写入需要登录态，这里只做本地标记，防止刷新后重复领取
    state.trialUsed = true;
    writeTrial(true);
    renderAccount();
    return;
  }
  if (isVip()) return; // VIP 无限次，不扣减也不计数
  try {
    await state.cloud.database.from('usage_logs').insert({
      chars_in: rawLen,
      nodes: NODES.filter((n) => n.on).length,
      sec: Math.round((Date.now() - startedAt) / 1000),
      ok: true
    });
  } catch (e) {
    addLog('额度扣减记录失败', e && e.message ? e.message : String(e));
  }
  await loadQuota();
}

function gateAccount() {
  if (state.session) {
    if (isVip()) return true; // VIP 无限次，直接放行
    if (state.quota.remaining <= 0) {
      const box = $('errorBox');
      box.textContent = '可用次数已用完，请在左侧「账号与额度」中兑换授权码';
      box.hidden = false;
      return false;
    }
    return true;
  }
  if (state.trialUsed) {
    const box = $('errorBox');
    box.textContent = '免费体验已用完。请登录后兑换授权码，即可继续使用';
    box.hidden = false;
    return false;
  }
  return true; // 游客首次免费体验
}

async function initCloud() {
  setStatus('正在加载云服务组件…');
  const ok = await waitForSdk(8000);
  if (!ok) {
    setStatus('云服务组件加载失败', 'bad');
    const box = $('errorBox');
    box.textContent = '云服务 SDK 未能载入（脚本被拦截或超时）。请刷新页面重试；若持续失败，说明当前网络无法获取本站静态资源。';
    box.hidden = false;
    return;
  }
  try {
    state.cloud = WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: PUBLIC_CONFIG.endpoint,
      oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
      publishableKey: PUBLIC_CONFIG.publishableKey
    });
    await loadModels();
    await restoreAuth();
  } catch (e) {
    setStatus('云服务初始化失败', 'bad');
    showError(e);
  }
}

async function loadModels() {
  setStatus('正在读取模型列表…');
  try {
    const list = await withTimeout(state.cloud.llm.models.list(), 15000, '模型列表读取超时');
    state.models = Array.isArray(list) ? list : [];
    const usable = state.models.filter((m) => m.disabled !== true);
    if (!usable.length) {
      setStatus('当前没有可用模型', 'bad');
    } else {
      state.modelPick = {};
      NODES.forEach((n) => {
        const want = PREFERRED[n.id] || [];
        let pick = usable[0].id;
        for (let i = 0; i < want.length; i += 1) {
          const m = usable.find((x) => x.id === want[i]);
          if (m) { pick = m.id; break; }
        }
        state.modelPick[n.id] = pick;
      });
      setStatus('已接入 ' + usable.length + ' 个可用模型', 'ok');
    }
    renderPipeline();
  } catch (e) {
    setStatus('模型列表读取失败', 'bad');
    showError(e);
  }
}

function showError(e) {
  const box = $('errorBox');
  const code = e && e.error && e.error.code ? e.error.code : '';
  const reqId = e && e.requestId ? e.requestId : '';
  let msg = '执行失败';
  if (code.startsWith('quota_')) msg = '配额不足或触发限流，请稍后重试';
  else if (code.startsWith('auth_')) msg = '云服务鉴权未通过（域名不匹配或凭据失效）';
  else if (code.startsWith('request_')) msg = '请求参数或模型不匹配：' + (e.error.message || '');
  else if (code.startsWith('gateway_') || code.startsWith('model_')) msg = '模型服务暂时不可用，请重试';
  else if (code.startsWith('internal_')) msg = '服务内部错误';
  else if (e && e.message) msg = e.message;
  box.textContent = msg + (reqId ? '（请求 ID：' + reqId + '）' : '');
  box.hidden = false;
}

function clearError() { $('errorBox').hidden = true; $('errorBox').textContent = ''; }

async function callModel(node, systemText, userText) {
  const modelId = state.modelPick[node.id];
  let text = '';
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, NODE_TIMEOUT);
  let onOuterAbort = null;
  if (state.controller) {
    onOuterAbort = () => ac.abort();
    state.controller.signal.addEventListener('abort', onOuterAbort);
  }
  try {
    const opts = {
      model: modelId,
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: userText }
      ],
      stream: true,
      temperature: node.temp,
      signal: ac.signal
    };
    const stream = await state.cloud.llm.chat.completions.create(opts);
    for await (const chunk of stream) {
      const delta = chunk.choices && chunk.choices[0] ? chunk.choices[0].delta : null;
      if (delta && delta.content) text += delta.content;
    }
    return text;
  } catch (e) {
    if (timedOut) {
      const err = new Error('节点 ' + node.id.toUpperCase() + ' 响应超时（超过 ' + (NODE_TIMEOUT / 1000) + ' 秒），请重试或换更快的模型');
      err.isTimeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (onOuterAbort && state.controller) state.controller.signal.removeEventListener('abort', onOuterAbort);
  }
}

function parseJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error('模型返回内容不是合法 JSON，请重试或换一个模型');
  }
}

function normalize(data) {
  const out = { title: '', summary: '', sections: [] };
  if (!data || typeof data !== 'object') return out;
  out.title = String(data.title || '').trim();
  out.summary = String(data.summary || '').trim();
  const sections = Array.isArray(data.sections) ? data.sections : [];
  out.sections = sections.slice(0, MAX_SECTIONS).map((s, i) => {
    const points = Array.isArray(s.points) ? s.points : [];
    return {
      id: s.id || ('s' + (i + 1)),
      conclusion: String(s.conclusion || s.title || s.topic || '').trim(),
      points: points.map((p) => {
        if (typeof p === 'string') p = { text: p };
        const kids = Array.isArray(p.children) ? p.children : [];
        const label = String(p.label || '').replace(/[：:]\s*$/, '').trim().slice(0, 10);
        let text = String(p.text || '').trim();
        if (label) {
          // 模型常把 label 又写在正文开头（如「背景动因：自动驾驶…」），渲染时会与前缀重复，这里剥掉
          const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          text = text.replace(new RegExp('^【?' + esc + '】?\\s*[：:]\\s*'), '')
            .replace(new RegExp('^【' + esc + '】\\s*'), '');
        }
        return {
          label: label,
          text: text,
          children: kids.map((c) => ({ text: String((c && c.text) || c || '').trim() })).filter((c) => c.text)
        };
      }).filter((p) => p.text)
    };
  }).filter((s) => s.conclusion);
  return out;
}

function truncateInput(raw) {
  const t = raw || '';
  if (t.length <= MAX_INPUT) {
    $('truncTip').textContent = '';
    return t;
  }
  $('truncTip').textContent = '内容超过 ' + MAX_INPUT + ' 字，将截取前 ' + MAX_INPUT + ' 字处理';
  return t.slice(0, MAX_INPUT);
}

const nodeOf = (id) => NODES.find((n) => n.id === id);

const SAFETY_RULE =
  '硬性约束（优先级高于一切）：1) 不得新增原文没有的信息、例子、数据或结论；' +
  '2) 不得改变数值、单位、因果关系、时间先后与结论方向；' +
  '3) 只允许在句式、用词、语序、衔接和语体上做优化，禁止改写事实本身；' +
  '4) 专有名词、术语、系统名、文件名保持原文写法不变；' +
  '5) 宁可保持朴素，也不要为了文采牺牲准确性。';

function styleGuide() {
  const p = state.profile;
  if (!p) return '';
  return '【内容画像】行业=' + (p.industry || '未识别') +
    '；领域=' + (p.domain || '未识别') +
    '；知识深度=' + (p.depth || '未识别') +
    '；表达类型=' + (p.register || '未识别') +
    '；目标读者=' + (p.audience || '未识别') + '\n' +
    '【表达策略】' + (p.strategy || '保持原文风格') + '\n' +
    SAFETY_RULE;
}

function renderProfile() {
  const box = $('profileBox');
  const p = state.profile;
  if (!p || (!p.industry && !p.domain)) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '';
  const rows = [
    ['行业', p.industry],
    ['领域', p.domain],
    ['深度', p.depth],
    ['语体', p.register],
    ['读者', p.audience]
  ];
  rows.forEach((r) => {
    if (!r[1]) return;
    const item = document.createElement('div');
    item.className = 'pf-item';
    const k = document.createElement('span');
    k.className = 'pf-key';
    k.textContent = r[0];
    const v = document.createElement('span');
    v.className = 'pf-val';
    v.textContent = r[1];
    item.appendChild(k);
    item.appendChild(v);
    box.appendChild(item);
  });
  if (p.strategy) {
    const s = document.createElement('div');
    s.className = 'pf-strategy';
    s.textContent = '表达策略：' + p.strategy;
    box.appendChild(s);
  }
}

async function runPipeline() {
  if (state.running) return;
  const raw = truncateInput($('rawInput').value.trim());
  if (!raw) {
    clearError();
    const box = $('errorBox');
    box.textContent = '请先粘贴或导入要提炼的内容';
    box.hidden = false;
    return;
  }
  if (!state.cloud || !state.models.some((m) => m.disabled !== true)) {
    const box = $('errorBox');
    box.textContent = '云服务或模型尚未就绪，请等待模型列表加载完成';
    box.hidden = false;
    return;
  }
  if (!gateAccount()) return;
  if (!state.session) addLog('额度', '本次为游客免费体验（每个浏览器限 1 次）');

  clearError();
  state.running = true;
  state.stopping = false;
  state.logs = [];
  state.result = null;
  state.profile = null;
  NODES.forEach((n) => { n.done = false; n.failed = false; });
  $('profileBox').hidden = true;
  $('profileBox').innerHTML = '';
  $('btnRun').disabled = true;
  $('btnStop').disabled = false;
  $('exportBar').hidden = true;
  $('usageTip').textContent = '';
  state.stepsExpanded = false;
  setStepsVisible(true, false);
  state.controller = new AbortController();
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    $('usageTip').textContent = '已运行 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒';
  }, 1000);

  try {
    let stage = null;

    // N0 风格识别（失败可降级：以中性表达继续）
    if (nodeOf('n0').on) {
      renderStepper('n0');
      try {
        const out0 = await callModel(
          nodeOf('n0'),
          '你是文本画像分析师，擅长判断一段内容的行业归属、专业深度与语体风格。只输出合法 JSON，不要输出任何解释文字。',
          '请充分理解下面的原文，判断它的行业、领域、知识深度与表达类型，并给出后续改写应遵循的表达策略。\n' +
          '输出格式：{"industry":"","domain":"","depth":"","register":"","audience":"","strategy":""}\n' +
          '字段要求：\n' +
          '- industry：行业归属，如 自动驾驶 / 医疗健康 / 教育培训 / 金融 / 制造业 / 泛生活\n' +
          '- domain：细分领域，如 数据预处理 / 财务管理 / 课堂教学\n' +
          '- depth：只能取 入门科普 / 进阶实践 / 专业深度 / 战略决策 四者之一\n' +
          '- register：只能取 正式书面 / 专业术语 / 口语闲聊 / 营销文案 / 内部汇报 / 幽默吐槽 六者之一\n' +
          '- audience：最可能的目标读者\n' +
          '- strategy：60 字以内，说明这段内容最终应以什么样的语气、句式和词汇密度呈现。专业场景用准确术语与紧凑句式；非专业场景用口语化表达降低理解成本；非正式场景可适度幽默提升趣味性；正式汇报场景用规范书面语并突出结论先行。\n' +
          '原文：\n"""\n' + raw + '\n"""'
        );
        state.profile = parseJson(out0);
        nodeOf('n0').done = true;
        renderProfile();
        addLog('N0 风格识别 · 输出', out0);
      } catch (e) {
        if (isStop(e)) throw e;
        nodeOf('n0').failed = true;
        state.profile = null;
        addLog('N0 风格识别 · 失败，已降级为中性表达', e && e.message ? e.message : String(e));
      }
    }

    const guide = styleGuide();

    // N1 结构抽取（失败可降级：直接用原文进 N2）
    if (nodeOf('n1').on) {
      renderStepper('n1');
      try {
        const out = await callModel(
          nodeOf('n1'),
          '你是内容结构分析引擎。只输出合法 JSON，不要输出任何解释文字。',
          '请把下面可能杂乱无章的原文解析成结构化提纲，提取全部关键事实、数据、约束与结论，不要遗漏细节。\n' +
          '输出格式：{"title":"<主题>","outline":[{"topic":"<主题名>","facts":["<事实或细节>"]}]}\n' +
          '要求：topic 按原文天然的信息模块/话题板块划分（如讲话者逐个介绍的每个模块各占一个 topic），3-12 个，不要把不同模块合并到同一个 topic；facts 覆盖原文所有关键信息点，包含数值、编号、格式名、系统名、限制条件、分类规则、操作步骤。\n' +
          (guide ? guide + '\n' : '') +
          '原文：\n"""\n' + raw + '\n"""'
        );
        stage = parseJson(out);
        nodeOf('n1').done = true;
        addLog('N1 结构抽取 · 输出', out);
      } catch (e) {
        if (isStop(e)) throw e;
        nodeOf('n1').failed = true;
        addLog('N1 结构抽取 · 失败，已降级使用原文进入下一节点', e && e.message ? e.message : String(e));
      }
    }

    // N2 核心压缩
    let core = null;
    renderStepper('n2');
    const coreInput = stage ? JSON.stringify(stage) : raw;
    const out2 = await callModel(
      nodeOf('n2'),
      '你是内容提炼专家，擅长把长文压缩成可扫读的结论，并能按指定语体改写表达。只输出合法 JSON，不要输出解释文字。',
      '请把下面的内容提纲压缩为阅读主干，并按照给定的内容画像优化表达：专业场景写成专业紧凑的结论句，非专业场景写成口语化的大白话以降低理解成本，非正式场景允许适度幽默提升趣味，正式场景严格书面规范并结论先行。\n' +
      '输出格式：{"title":"","summary":"<一句话核心：这段内容讲什么、最终结论是什么>","sections":[{"id":"s1","conclusion":"<一级结论，必须是一句完整、可独立理解的结论句，破折号后可补目的/约束/结果>"}]}\n' +
      '要求：sections 按内容天然的信息模块/主题板块划分（每个模块、每个被逐一介绍的主题各占一个 section），4-10 个，不要把两个独立模块合并进一个 section；每个 conclusion 先点明板块名称再给出核心结论，独立成句且自带关键限定；不要写成单词或短语标题。\n' +
      (guide ? guide + '\n' : '') +
      '内容：\n"""\n' + coreInput + '\n"""'
    );
    core = normalize(parseJson(out2));
    nodeOf('n2').done = true;
    addLog('N2 核心压缩 · 输出', out2);

    // N3 细节分层
    let detail = core;
    if (nodeOf('n3').on) {
      renderStepper('n3');
      try {
        const out3 = await callModel(
        nodeOf('n3'),
        '你是信息架构师，负责把细节按层级下钻，并按指定语体表达。只输出合法 JSON，不要输出解释文字。',
        '下面是一段原文和已经提炼出的主干。请把每个一级结论下的细节组织成二级要点与三级补充，保证原文信息不遗漏，并按内容画像统一语气（专业/口语/幽默/书面保持一致）。\n' +
        '输出格式：{"title":"","summary":"","sections":[{"id":"s1","conclusion":"","points":[{"label":"<要点类别，2-6字>","text":"<二级要点，一句话>","children":[{"text":"<三级补充，一句话>"}]}]}]}\n' +
        '要求：保持主干的 title/summary/conclusion 不变；每个 section 的 points 2-6 个；每个 point 必须有 label，用 2-6 个字标明这条要点的类型或角度（如 模块定位 / 核心功能 / 工作流程 / 分类规则 / 关键链路 / 错误类型 / 页面交互 / 使用提示 / 背景动因 / 核心价值 / 任务管理 / 版本策略，按内容灵活起名，同一 section 内不重复）；text 是该类别的具体内容，不要再重复 label 里的字；children 只在仍有补充细节时出现；不得新增原文没有的信息。\n' +
        (guide ? guide + '\n' : '') +
        '原文：\n"""\n' + raw + '\n"""\n主干：\n"""\n' + JSON.stringify(core) + '\n"""'
      );
      const parsed3 = normalize(parseJson(out3));
      if (parsed3.sections.length) detail = parsed3;
      nodeOf('n3').done = true;
      addLog('N3 细节分层 · 输出', out3);
    } catch (e) {
      if (isStop(e)) throw e;
      nodeOf('n3').failed = true;
      addLog('N3 细节分层 · 失败，已保留上一层结果', e && e.message ? e.message : String(e));
    }
    }

    // N4 质量校验
    let finalData = detail;
    if (nodeOf('n4').on) {
      renderStepper('n4');
      try {
      const out4 = await callModel(
        nodeOf('n4'),
        '你是质量校验编辑，负责补漏与纠错。只输出合法 JSON，不要输出解释文字。',
        '请逐条比对原文，对下面已分层的内容做校验：补充被遗漏的细节、修正不准确的表述，并检查每一句是否偏离原文、是否夹带原文没有的信息，然后直接输出补全并校准后的终稿。\n' +
        '要求：保持同样的 JSON 结构与字段名；一级结论必须是完整结论句；语体与内容画像保持一致；不要新增原文没有的内容。\n' +
        (guide ? guide + '\n' : '') +
        '原文：\n"""\n' + raw + '\n"""\n待校验内容：\n"""\n' + JSON.stringify(detail) + '\n"""'
      );
      const parsed4 = normalize(parseJson(out4));
      if (parsed4.sections.length) finalData = parsed4;
      nodeOf('n4').done = true;
      addLog('N4 质量校验 · 输出', out4);
    } catch (e) {
      if (isStop(e)) throw e;
      nodeOf('n4').failed = true;
      addLog('N4 质量校验 · 失败，已保留上一层结果', e && e.message ? e.message : String(e));
    }
    }

    state.result = finalData;
    await recordUsage(raw.length, startedAt);
    renderStepper(null);
    renderCards(finalData);
    renderTree(finalData);
    renderJson(finalData);
    $('emptyCards').hidden = true;
    $('treeTools').hidden = false;
    $('exportBar').hidden = false;
    switchTab('cards');
    // 出结果后自动收起左栏，让结果区占满全宽（点左侧窄条可展开再编辑）
    const wrapNow = document.querySelector('.wrap');
    if (wrapNow) wrapNow.classList.add('left-folded');
    addLog('完成', '共 ' + finalData.sections.length + ' 个一级结论');
    $('usageTip').textContent = '完成，总耗时 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒';
    if (!state.session) {
      setLoginTip('免费体验已用完。登录后兑换授权码即可继续使用，额度跨设备通用');
      addLog('额度', '游客免费体验已使用，下次运行需登录并兑换授权码');
    }
  } catch (e) {
    if (isStop(e)) {
      addLog('已中止', '用户主动停止，未产生结果，不扣减额度');
      $('usageTip').textContent = '已中止';
    } else {
      showError(e);
      $('usageTip').textContent = '执行失败，点「查看执行过程」定位到具体节点';
      const id = ['n0', 'n1', 'n2', 'n3', 'n4'].find((k) => {
        const n = nodeOf(k);
        return n && n.on && !n.done;
      });
      if (id) nodeOf(id).failed = true;
      renderStepper(null);
    }
  } finally {
    clearInterval(ticker);
    state.running = false;
    setStepsVisible(false, true);
    $('btnRun').disabled = false;
    $('btnStop').disabled = true;
    state.controller = null;
  }
}

function renderCards(data) {
  const box = $('cards');
  box.innerHTML = '';

  if (data.title || data.summary) {
    const head = document.createElement('div');
    head.className = 'card-core';
    if (data.title) {
      const h = document.createElement('div');
      h.className = 'core-title';
      h.textContent = data.title;
      head.appendChild(h);
    }
    if (data.summary) {
      const p = document.createElement('div');
      p.className = 'core-sum';
      p.textContent = data.summary;
      head.appendChild(p);
    }
    box.appendChild(head);
  }

  data.sections.forEach((s, i) => {
    const d1 = document.createElement('details');
    d1.className = 'lvl1';
    const s1 = document.createElement('summary');
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String(i + 1);
    const t1 = document.createElement('span');
    t1.className = 'concl';
    t1.textContent = s.conclusion;
    s1.appendChild(badge);
    s1.appendChild(t1);
    if (s.points && s.points.length) {
      const tag = document.createElement('span');
      tag.className = 'more';
      tag.textContent = '展开 ' + s.points.length + ' 项 ▸';
      s1.appendChild(tag);
      d1.addEventListener('toggle', () => {
        tag.textContent = d1.open ? '收起 ▾' : '展开 ' + s.points.length + ' 项 ▸';
      });
    }
    d1.appendChild(s1);

    if (s.points && s.points.length) {
      const body = document.createElement('div');
      body.className = 'lvl2';
      s.points.forEach((p) => {
        const li = document.createElement('div');
        li.className = 'point';
        if (p.label) {
          const b = document.createElement('b');
          b.className = 'pt-label';
          b.textContent = p.label + '：';
          li.appendChild(b);
        }
        li.appendChild(document.createTextNode(p.text));
        body.appendChild(li);

        if (p.children && p.children.length) {
          const d3 = document.createElement('details');
          d3.className = 'lvl3';
          const s3 = document.createElement('summary');
          s3.textContent = '补充说明 ▸';
          d3.addEventListener('toggle', () => {
            s3.textContent = d3.open ? '补充说明 ▾' : '补充说明 ▸';
          });
          d3.appendChild(s3);
          const inner = document.createElement('div');
          inner.className = 'lvl3-body';
          p.children.forEach((c) => {
            const line = document.createElement('div');
            line.textContent = c.text;
            inner.appendChild(line);
          });
          d3.appendChild(inner);
          body.appendChild(d3);
        }
      });
      d1.appendChild(body);
    }
    box.appendChild(d1);
  });
}

// 思维树图：从上往下的缩进大纲树（HTML），节点可收起/展开，按分支配色，文字自然换行
const MTREE_PALETTE = [
  { stroke: '#185FA5', fill: '#E6F1FB' },  // 蓝
  { stroke: '#0F6E56', fill: '#E1F5EE' },  // 绿
  { stroke: '#854F0B', fill: '#FAEEDA' },  // 琥珀
  { stroke: '#534AB7', fill: '#EEEDFE' },  // 紫
  { stroke: '#993556', fill: '#FBEAF0' },  // 品红
  { stroke: '#0E7C86', fill: '#E0F4F5' }   // 青
];

function makeTreeNode(opts) {
  // opts: { text, label, boxClass, stroke, fill, children: [HTMLElement] }
  const item = document.createElement('div');
  item.className = 'mt-item';
  const row = document.createElement('div');
  row.className = 'mt-row';
  const tog = document.createElement('span');
  tog.className = 'mt-toggle';
  const box = document.createElement('div');
  box.className = 'mt-box' + (opts.boxClass ? ' ' + opts.boxClass : '');
  if (opts.stroke) {
    box.style.borderColor = opts.stroke;
    box.style.background = opts.fill;
  }
  if (opts.label) {
    const b = document.createElement('span');
    b.className = 'pt-label';
    if (opts.stroke) b.style.color = opts.stroke;
    b.textContent = opts.label + '：';
    box.appendChild(b);
  }
  box.appendChild(document.createTextNode(opts.text || ''));
  row.appendChild(tog);
  row.appendChild(box);
  item.appendChild(row);
  if (opts.children && opts.children.length) {
    tog.textContent = '▾';
    tog.title = '收起 / 展开';
    const kids = document.createElement('div');
    kids.className = 'mt-kids';
    opts.children.forEach((c) => kids.appendChild(c));
    item.appendChild(kids);
    const flip = () => {
      const closed = item.classList.toggle('closed');
      tog.textContent = closed ? '▸' : '▾';
    };
    tog.addEventListener('click', flip);
  } else {
    tog.classList.add('leaf');
  }
  return item;
}

function renderTree(data) {
  const host = $('tree');
  host.innerHTML = '';
  if (!data || !data.sections || !data.sections.length) {
    host.innerHTML = '<div class="empty">暂无可绘制的结构。</div>';
    return;
  }
  const depth = state.treeDepth;
  const sectionNodes = data.sections.map((s, i) => {
    const pal = MTREE_PALETTE[i % MTREE_PALETTE.length];
    let pointNodes = [];
    if (depth >= 3) {
      pointNodes = (s.points || []).map((p) => {
        const childNodes = depth >= 4
          ? (p.children || []).map((c) => makeTreeNode({ text: c.text }))
          : [];
        return makeTreeNode({
          text: p.text, label: p.label,
          stroke: pal.stroke, fill: pal.fill, boxClass: 'mt-soft',
          children: childNodes
        });
      });
    }
    return makeTreeNode({
      text: s.conclusion, boxClass: 'mt-branch',
      stroke: pal.stroke, fill: pal.fill,
      children: pointNodes
    });
  });
  const root = makeTreeNode({
    text: data.title || '内容主干', boxClass: 'mt-root',
    children: sectionNodes
  });
  const wrap = document.createElement('div');
  wrap.className = 'mtree';
  wrap.appendChild(root);
  host.appendChild(wrap);
}

function renderJson(data) {
  $('jsonView').textContent = JSON.stringify(data, null, 2);
}

function switchTab(name) {
  ['cards', 'tree', 'json', 'log'].forEach((k) => {
    $('view-' + k).hidden = k !== name;
  });
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), (b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
}

function toMarkdown(data) {
  let md = '';
  if (data.title) md += '# ' + data.title + '\n\n';
  if (data.summary) md += '> ' + data.summary + '\n\n';
  data.sections.forEach((s, i) => {
    md += '## ' + (i + 1) + '. ' + s.conclusion + '\n';
    (s.points || []).forEach((p) => {
      md += '- ' + (p.label ? '**' + p.label + '**：' : '') + p.text + '\n';
      (p.children || []).forEach((c) => { md += '  - ' + c.text + '\n'; });
    });
    md += '\n';
  });
  return md;
}

function download(name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function bindEvents() {
  $('rawInput').addEventListener('input', () => {
    $('charCount').textContent = $('rawInput').value.length + ' 字';
  });

  $('btnSample').addEventListener('click', () => {
    $('rawInput').value = SAMPLE;
    $('charCount').textContent = SAMPLE.length + ' 字';
  });

  $('btnClear').addEventListener('click', () => {
    $('rawInput').value = '';
    $('charCount').textContent = '0 字';
  });

  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      $('rawInput').value = String(r.result || '');
      $('charCount').textContent = $('rawInput').value.length + ' 字';
    };
    r.readAsText(f, 'utf-8');
  });

  $('btnReloadModels').addEventListener('click', loadModels);
  $('btnTogglePipeline').addEventListener('click', () => {
    const cfg = $('pipelineCfg');
    cfg.hidden = !cfg.hidden;
    $('btnTogglePipeline').textContent = cfg.hidden ? '展开 ▸' : '收起 ▾';
  });
  $('btnRun').addEventListener('click', runPipeline);
  $('btnStop').addEventListener('click', () => {
    state.stopping = true; // 先置标记，避免被各节点的降级兜底吃掉中止信号
    if (state.controller) state.controller.abort();
  });

  const flipSteps = () => {
    state.stepsExpanded = !state.stepsExpanded;
    // 运行中保持运行态展示（单行/步骤列表切换），结束后保持「完成态」
    setStepsVisible(state.running, !state.running);
  };
  $('btnToggleSteps').addEventListener('click', flipSteps);
  $('stepLine').addEventListener('click', flipSteps);

  // 账号与额度（顶部右侧单行 + 展开面板）
  $('accountBar').addEventListener('click', (e) => {
    e.stopPropagation();
    setAccountOpen($('accountPanel').hidden);
  });
  $('accountPanel').addEventListener('click', (e) => {
    e.stopPropagation(); // 面板内部交互不触发「点击外部收起」
    const t = e.target.closest('.tab');
    if (!t || !t.dataset.way) return;
    state.loginWay = t.dataset.way;
    state.pendingOtp = null;
    Array.prototype.forEach.call(document.querySelectorAll('#loginView .tab'), (x) => {
      x.classList.toggle('active', x === t);
    });
    $('loginAccount').placeholder = state.loginWay === 'phone' ? '手机号' : '邮箱';
    setAccountErr('');
    setLoginTip('');
  });
  $('btnCloseAccount').addEventListener('click', () => setAccountOpen(false));
  document.addEventListener('click', () => setAccountOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setAccountOpen(false);
  });
  $('loginAccount').addEventListener('input', () => setAccountErr(''));
  $('btnSendCode').addEventListener('click', sendCode);
  $('btnLogin').addEventListener('click', submitLogin);
  $('btnRedeem').addEventListener('click', redeemLicense);
  $('btnSignOut').addEventListener('click', doSignOut);

  // 左栏折叠 / 展开
  $('btnFoldLeft').addEventListener('click', () => {
    const w = document.querySelector('.wrap');
    if (w) w.classList.add('left-folded');
  });
  $('expandStrip').addEventListener('click', () => {
    const w = document.querySelector('.wrap');
    if (w) w.classList.remove('left-folded');
  });

  // 左右区域可拖动分割线
  const splitter = $('splitter');
  const wrapEl = document.querySelector('.wrap');
  if (splitter && wrapEl) {
    splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      splitter.classList.add('drag');
      try { splitter.setPointerCapture(e.pointerId); } catch (err) { /* 部分环境不支持指针捕获，可安全忽略 */ }
      document.body.style.userSelect = 'none';
      const onMove = (ev) => {
        const rect = wrapEl.getBoundingClientRect();
        const w = Math.min(560, Math.max(220, ev.clientX - rect.left - 20));
        wrapEl.style.setProperty('--left-w', w + 'px');
      };
      const onUp = () => {
        splitter.classList.remove('drag');
        document.body.style.userSelect = '';
        splitter.removeEventListener('pointermove', onMove);
        splitter.removeEventListener('pointerup', onUp);
        splitter.removeEventListener('pointercancel', onUp);
      };
      splitter.addEventListener('pointermove', onMove);
      splitter.addEventListener('pointerup', onUp);
      splitter.addEventListener('pointercancel', onUp);
    });
  }

  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) switchTab(b.dataset.tab);
  });

  $('treeTools').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    state.treeDepth = parseInt(b.dataset.depth, 10) || 2;
    Array.prototype.forEach.call(document.querySelectorAll('#treeTools .chip'), (x) => x.classList.toggle('active', x === b));
    if (state.result) renderTree(state.result);
  });

  $('btnCopyMd').addEventListener('click', () => {
    if (!state.result) return;
    navigator.clipboard.writeText(toMarkdown(state.result));
    $('btnCopyMd').textContent = '已复制';
    setTimeout(() => { $('btnCopyMd').textContent = '复制 Markdown'; }, 1500);
  });
  $('btnDownMd').addEventListener('click', () => {
    if (state.result) download('内容提炼结果.md', toMarkdown(state.result));
  });
  $('btnDownJson').addEventListener('click', () => {
    if (state.result) download('内容提炼结果.json', JSON.stringify(state.result, null, 2));
  });
}

window.addEventListener('error', (ev) => {
  if (state.running) return;
  setStatus('页面脚本异常：' + (ev.message || '未知错误'), 'bad');
});

bindEvents();
renderStepper(null);
renderLogs();
initCloud();
