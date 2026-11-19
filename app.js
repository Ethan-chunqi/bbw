'use strict';

(() => {
  const get = id => document.getElementById(id);
  const form = get('registration');
  const card = get('status-card');
  const title = get('status-title');
  const description = get('status-description');
  const refresh = get('refresh');
  const update = get('status-update');
  const submit = get('submit');
  const errorNote = get('form-error');
  const base = new URL('.', location.href);
  const apiRoot = location.hostname === 'ethan-chunqi.github.io'
    ? new URL('https://dashayu.xyz/bbw/api/')
    : new URL('api/', base);
  const storageKey = 'bbw-guest-invite:' + base.pathname;
  const requestKey = 'bbw-guest-request:' + base.pathname;
  const states = {
    pending: ['申请已提交，等待审核', 'UXUY 收到了你的申请。审核通过后，UXUY 将代你办理活动报名和领票。'],
    declined: ['申请未通过', '如需了解具体情况，请联系发出邀请的 UXUY 工作人员。'],
    approved: ['审核已通过', 'UXUY 已通过你的申请，接下来将办理报名和领票。'],
    queued: ['审核已通过', '你的报名资料已进入领票办理队列。'],
    processing: ['正在办理领票', 'UXUY 正在为你办理活动报名和领票。'],
    review: ['等待人工核对', '办理过程中需要 UXUY 核对资料，请稍后查看进度。'],
    issued: ['已完成领票', '请留意报名邮箱。入场二维码将由活动方在临近活动时发送。'],
    closed: ['邀请已关闭', '如需了解具体情况，请联系发出邀请的 UXUY 工作人员。']
  };
  const activeStates = new Set(['pending', 'approved', 'queued', 'processing', 'review']);
  let state = 'initial';
  let busy = false;
  let timer;
  let requestId = read(requestKey);
  let token = read(storageKey);

  function read(key) {
    try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
  }

  function remember(key, value) {
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch { /* The page can use its in-memory copy. */ }
  }

  function setToken(value) {
    token = value;
    remember(storageKey, value);
  }

  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has('invite')) {
    const nextToken = fragment.get('invite').trim();
    if (nextToken !== token) { requestId = ''; remember(requestKey, ''); }
    setToken(nextToken);
    history.replaceState(null, '', location.pathname + location.search);
  }

  async function request(path, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(new URL(path, apiRoot), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error('Request failed');
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally { clearTimeout(timeout); }
  }

  function showForm() {
    state = 'available';
    clearTimeout(timer);
    card.hidden = true;
    form.hidden = false;
    submit.disabled = false;
  }

  function showStatus(heading, detail, retry = false, personal = false) {
    clearTimeout(timer);
    form.hidden = true;
    card.hidden = false;
    title.textContent = heading;
    description.textContent = detail;
    refresh.hidden = !retry;
    refresh.textContent = state === 'error' ? '重新连接' : '刷新进度';
    update.textContent = '';
    get('order').hidden = true;
    get('order-id').textContent = '';
    const link = get('status-link');
    get('manual-link').hidden = true;
    get('copy-result').textContent = '请保存此链接，仅供本人查看。';
    get('status-link-row').hidden = !(personal && token);
    if (personal && token) {
      const privateUrl = new URL(location.pathname, location.origin);
      privateUrl.hash = new URLSearchParams({ invite: token });
      link.href = privateUrl.href;
    } else {
      link.removeAttribute('href');
    }
  }

  function poll() {
    clearTimeout(timer);
    if (!document.hidden && activeStates.has(state)) {
      timer = setTimeout(checkStatus, state === 'pending' || state === 'review' ? 45000 : 12000);
    }
  }

  function render(result) {
    if (result?.state === 'available') { showForm(); return; }
    if (!result || !Object.hasOwn(states, result.state)) throw new Error('Unknown state');
    state = result.state;
    showStatus(...states[state], activeStates.has(state), true);
    if (state === 'issued' && result.orderId) {
      get('order-id').textContent = String(result.orderId);
      get('order').hidden = false;
    }
    poll();
  }

  async function checkStatus() {
    if (!token || busy) return;
    busy = true;
    refresh.disabled = true;
    try {
      render(await request('invitation', { token }));
    } catch (error) {
      if ([401, 403, 404, 410].includes(error.status)) {
        state = 'closed';
        showStatus('链接不可用', '请重新打开保存的完整链接，或联系 UXUY 核对。');
      } else if (activeStates.has(state)) {
        update.textContent = '暂时无法刷新，请稍后再试。';
        poll();
      } else {
        state = 'error';
        showStatus('暂时无法连接', '请检查网络连接，再试一次。', true);
      }
    } finally { busy = false; refresh.disabled = false; }
  }

  form.addEventListener('input', event => {
    if (event.target.setCustomValidity) event.target.setCustomValidity('');
    errorNote.hidden = true;
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || state !== 'available') return;
    const fields = form.elements;
    const fullName = fields.fullName.value.trim();
    if (!fullName) {
      fields.fullName.setCustomValidity('请输入英文全名。');
      fields.fullName.reportValidity();
      return;
    }
    const attendee = {
      fullName, email: fields.email.value.trim(),
      consentPhoto: fields.consentPhoto.checked, consentData: fields.consentData.checked
    };
    if (!requestId) { requestId = crypto.randomUUID(); remember(requestKey, requestId); }
    busy = true;
    submit.disabled = true;
    submit.textContent = '提交中…';
    errorNote.hidden = true;
    try {
      const receipt = await request('registration', { requestId, ...(token ? { token } : {}), attendee });
      if (!receipt || !Object.hasOwn(states, receipt.state)) throw new Error('Submission not confirmed');
      if (typeof receipt.token === 'string' && receipt.token) setToken(receipt.token);
      if (!token) throw new Error('Missing receipt');
      render(receipt);
      requestId = '';
      remember(requestKey, '');
      form.reset();
      title.focus();
    } catch (error) {
      const messages = {
        400: '请核对英文姓名、邮箱及两项授权后再次提交。',
        422: '请核对英文姓名、邮箱及两项授权后再次提交。',
        409: '该邮箱或邀请已有申请记录。请打开先前保存的进度链接。如需更正资料，请联系 UXUY。',
        410: '本次赠票申请已截止。如需核实，请联系 UXUY。',
        429: '提交过于频繁。请先保留本页，稍后再试。'
      };
      errorNote.textContent = messages[error.status]
        || '暂时无法确认提交结果。请保留本页，使用相同资料再次提交，即可核对这份申请。';
      errorNote.hidden = false;
    } finally {
      busy = false;
      submit.disabled = false;
      submit.textContent = '提交申请';
    }
  });

  get('copy-link').addEventListener('click', async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(get('status-link').href);
      get('copy-result').textContent = '进度链接已复制，请只保存给自己。';
    } catch {
      get('manual-link').hidden = false;
      get('copy-result').textContent = '请长按或右键点击下方链接，选择复制链接地址。';
    }
  });
  refresh.addEventListener('click', checkStatus);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else if (activeStates.has(state)) checkStatus();
  });
  if (token) { showStatus('正在查询进度', '请稍候。'); checkStatus(); }
  else showForm();
})();
