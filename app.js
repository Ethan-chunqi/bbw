'use strict';

(() => {
  const get = id => document.getElementById(id);
  const form = get('registration');
  const progress = get('application-progress');
  if (!progress || !form.elements.firstName || !form.elements.lastName || !form.elements.accessCode || !get('verification-panel')) {
    const fresh = new URL(location.href);
    if (fresh.searchParams.get('form') !== 'access-20261120') {
      fresh.searchParams.set('form', 'access-20261120');
      location.replace(fresh.href);
    } else {
      get('form-error').textContent = '页面版本尚未更新，请稍后刷新本页。';
      get('form-error').hidden = false;
    }
    return;
  }
  const bar = get('progress-bar');
  const percent = get('progress-percent');
  const steps = [...get('progress-steps').children];
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
  const publicRequestKey = 'bbw-guest-request:' + base.pathname;
  const batchKey = 'bbw-guest-batch:' + base.pathname;
  const historyPrefix = 'bbw-guest-history:' + base.pathname + ':';
  const fragment = new URLSearchParams(location.hash.slice(1));
  const privateView = fragment.has('invite');
  const batchMode = !privateView && new URL(location.href).searchParams.get('mode') === 'batch';
  let token = privateView ? fragment.get('invite').trim() : '';
  const oldToken = read(storageKey);
  const requestKey = publicRequestKey + (privateView ? ':invite:' + token : ':public');
  const singleAttemptKey = requestKey + ':attempt';
  const list = get('guest-list');
  const guestTemplate = list.firstElementChild.cloneNode(true);
  const add = get('add-guest');
  const notice = get('submission-notice');
  const historyOpen = get('history-open');
  const historyPanel = get('history-panel');
  const historyRecords = new Map();
  const statusCache = new Map();
  const statusElements = new Map();
  const historyDetailLinks = new Map();
  const fields = ['lastName', 'firstName', 'email', 'badgeName'];
  let attempt = null;
  let historyRun = 0;
  let previousState;
  let sending = false;
  const states = {
    pending: ['申请已提交，等待审核', 'UXUY 收到了你的申请。审核通过后，UXUY 将代你办理活动报名和领票。'],
    declined: ['申请未通过', '如需了解具体情况，请联系发出邀请的 UXUY 工作人员。'],
    approved: ['审核已通过', 'UXUY 已通过你的申请，接下来将办理报名和领票。'],
    queued: ['正在等待办理报名', '报名码已使用，资料已进入办理队列。请保留本页，邮箱验证入口就绪后会显示在这里。'],
    processing: ['正在办理报名和领票', '请保留本页。需要验证报名邮箱时，页面会提示你。'],
    review: ['等待人工核对', '办理过程中需要 UXUY 核对资料，请稍后查看进度。'],
    issued: ['已完成领票', '请查看你填写的报名邮箱，留意活动方的确认邮件。入场二维码可能临近活动时另行发送。'],
    closed: ['邀请已关闭', '如需了解具体情况，请联系发出邀请的 UXUY 工作人员。']
  };
  const milestones = {
    pending: 1, declined: 1, approved: 2, queued: 2, processing: 2, review: 2, issued: 3
  };
  const activeStates = new Set(['pending', 'approved', 'queued', 'processing', 'review']);
  let state = 'initial';
  let busy = false;
  let timer;
  let requestId = read(requestKey);
  let verification = null;
  let expiryTimer;
  let reporting = false;
  let statusVersion = 0;


  function read(key) {
    try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
  }

  function remember(key, value) {
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch { /* The page can use its in-memory copy. */ }
  }

  if (privateView) {
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('mode');
    history.replaceState(null, '', cleanUrl.href);
  }
  // Older single submissions used a shared session slot. Only migrate into the matching flow.
  if ((!privateView && !oldToken && !batchMode) || (privateView && token && oldToken === token)) {
    if (!read(singleAttemptKey) && read(publicRequestKey + ':attempt')) {
      remember(singleAttemptKey, read(publicRequestKey + ':attempt'));
      remember(publicRequestKey + ':attempt', '');
    }
    if (!requestId && read(publicRequestKey)) {
      requestId = read(publicRequestKey);
      remember(requestKey, requestId);
      remember(publicRequestKey, '');
    }
  }
  window.addEventListener('hashchange', () => {
    location.reload();
  });

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
        const problem = await response.json().catch(() => ({}));
        error.row = problem.row;
        error.code = problem.error || problem.code;
        throw error;
      }
      return await response.json();
    } finally { clearTimeout(timeout); }
  }

  function updateProgress(knownState) {
    const completed = milestones[knownState];
    progress.hidden = completed === undefined;
    if (progress.hidden) return;
    const value = Math.round(100 * completed / steps.length) + '%';
    bar.value = completed;
    percent.textContent = value;
    bar.textContent = value;
    const caption = states[knownState]?.[0] || '尚未提交申请';
    bar.setAttribute('aria-valuetext', '已完成 ' + completed + '/' + steps.length + ' 步，' + caption);
    steps.forEach((step, index) => {
      step.classList.toggle('done', index < completed);
      if (index === completed && knownState !== 'declined') step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
  }

  function showForm() {
    state = 'available';
    clearTimeout(timer);
    card.hidden = true;
    form.hidden = false;
    refreshGuests();
  }

  function showStatus(heading, detail, retry = false, personal = false) {
    clearTimeout(timer);
    form.hidden = true;
    historyPanel.hidden = true;
    get('verification-panel').hidden = true;
    if (!personal) clearVerification();
    updateProgress(personal ? state : undefined);
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
    get('new-guest-row').hidden = !(personal && token);
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

  function officialCheckout(value) {
    const prefix = 'https://app.moongate.id/e/binance-blockchain-week-2026?';
    if (typeof value !== 'string' || !value.startsWith(prefix)) return null;
    const parts = value.slice(prefix.length).split('&');
    if (parts.length !== 2 || !parts.includes('checkout=1') ||
        !parts.some(p => /^c_confirmation=[A-Z0-9]{6,32}$/.test(p))) return null;
    return value;
  }

  function expiredVerification(v) {
    return v.expired === true || (Number.isFinite(v.deadline) && Date.now() >= v.deadline);
  }

  function historyStatus(result) {
    const v = result?.verification;
    if (result?.state !== 'review' || !v) return '';
    if (v.hasOrderId) return '订单号已反馈，等待核对';
    if (v.reportedAt) return '已反馈，等待核对';
    if (expiredVerification(v)) return '个人验证已过期，待核对';
    return officialCheckout(v.url) ? '请验证报名邮箱' : '正在等待邮箱验证链接';
  }

  function clearVerification() {
    verification = null;
    clearTimeout(expiryTimer);
    get('verification-panel').hidden = true;
    get('verification-link').removeAttribute('href');
    get('verification-order').value = '';
    get('verification-order').setCustomValidity('');
    get('verification-extra').open = false;
    get('verification-note').textContent = '';
  }

  function displayVerification(v) {
    if (!v || typeof v !== 'object') { clearVerification(); return; }
    verification = v;
    clearTimeout(expiryTimer);
    const expired = expiredVerification(v);
    const url = officialCheckout(v.url);
    const panel = get('verification-panel');
    panel.hidden = false;
    title.textContent = historyStatus({state:'review', verification:v});
    description.textContent = v.reportedAt ? '已收到你的反馈，工作人员将继续核对领票结果。' : '活动报名资料已提交。';
    const link = get('verification-link');
    const canOpen = Boolean(url) && !expired && !v.reportedAt;
    link.hidden = !canOpen;
    if (canOpen) {
      link.href = url;
      link.textContent = '去验证邮箱 ↗';
    }
    else link.removeAttribute('href');
    get('verification-guide').hidden = !canOpen || Boolean(v.reportedAt);
    get('verification-heading').textContent = canOpen && !v.reportedAt ? '邮箱验证' : '验证状态';
    const time = get('verification-time');
    if (expired) {
      time.textContent = '本次验证时限已过，请联系 UXUY 核对。';
      if (url && !v.hasOrderId) time.textContent += '若你此前已操作，可以在此补交反馈或官方订单号。';
      if (v.hasOrderId) time.textContent += 'UXUY 已收到你的订单号。';
    } else if (!url) {
      time.textContent = 'UXUY 正在核对这位嘉宾的专属验证入口。请稍后刷新本页，或联系 UXUY 工作人员。';
    } else if (v.reportedAt) {
      time.textContent = v.hasOrderId ? '官方订单号已收到。' : '你可以关闭本页，稍后查看领票进度。';
    } else {
      time.textContent = Number.isFinite(v.deadline)
        ? '请在 ' + new Date(v.deadline).toLocaleString('zh-CN', {timeZone:'Asia/Bangkok', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false}) + '（曼谷时间）前完成验证。'
        : '请尽快用手机完成验证。页面暂未提供准确的截止时间。';
    }
    const report = get('verification-report');
    report.hidden = !url || v.hasOrderId === true;
    const field = get('verification-order');
    field.required = Boolean(v.reportedAt);
    field.disabled = reporting;
    get('verification-extra-label').textContent = v.reportedAt ? '补交官方订单号（选填）' : '帮助与订单号（选填）';
    get('verification-report-hint').textContent = v.reportedAt
      ? '如已有官方订单号，可在此补交。' : '';
    get('verification-send').disabled = reporting;
    get('verification-send').hidden = Boolean(v.reportedAt) && !get('verification-extra').open;
    get('verification-send').textContent = reporting ? '正在提交…' : v.reportedAt ? '补交订单号' : '我已完成验证';
    if (v.hasOrderId) field.value = '';
    if (!expired && Number.isFinite(v.deadline)) {
      expiryTimer = setTimeout(() => displayVerification(v), Math.min(2147483647, Math.max(5, v.deadline - Date.now() + 1)));
    }
  }

  get('verification-link').addEventListener('click', event => {
    if (!verification || expiredVerification(verification)) {
      event.preventDefault();
      displayVerification(verification);
    }
  });

  const reportForm = get('verification-report');
  const orderInput = get('verification-order');
  orderInput.addEventListener('invalid', () => { get('verification-extra').open = true; });
  get('verification-extra').addEventListener('toggle', () => {
    if (verification?.reportedAt) get('verification-send').hidden = !get('verification-extra').open;
  });
  orderInput.addEventListener('input', () => {
    orderInput.setCustomValidity('');
    get('verification-note').textContent = '';
  });
  reportForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (reporting || !token || !verification || !officialCheckout(verification.url) || verification.hasOrderId) return;
    const orderId = orderInput.value.trim();
    if (orderId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(orderId)) {
      orderInput.setCustomValidity('请输入官方订单号，格式为包含四个短横线的 36 位编号。');
    }
    if (!reportForm.reportValidity()) return;
    reporting = true;
    statusVersion++;
    displayVerification(verification);
    const note = get('verification-note');
    note.textContent = '';
    try {
      const result = await request('verification-report', {token, ...(orderId ? {orderId} : {})});
      render(result);
      if (result?.verification) note.textContent = '反馈已送达。';
    } catch (err) {
      note.textContent = err.code === 'REPORT_CONFLICT' ? '此前已反馈另一订单号，请联系 UXUY 核对。'
        : err.status === 409 ? '当前状态已更新，请刷新进度后查看。'
        : err.status === 422 ? '请核对官方订单号后再提交。'
        : '暂时无法确认反馈结果，请刷新进度后重试。';
    } finally {
      reporting = false;
      if (verification) displayVerification(verification);
      poll();
    }
  });

  function render(result) {
    if (result?.state === 'available') {
      showForm();
      restoreSavedSubmission(singleAttemptKey, 'single');
      return;
    }
    if (!result || !Object.hasOwn(states, result.state)) throw new Error('Unknown state');
    state = result.state;
    showStatus(...states[state], activeStates.has(state), true);
    displayVerification(state === 'review' ? result.verification : null);
    if (state === 'issued' && result.orderId) {
      get('order-id').textContent = String(result.orderId);
      get('order').hidden = false;
    }
    poll();
  }

  async function checkStatus() {
    if (!token || busy || reporting) return;
    busy = true;
    refresh.disabled = true;
    const version = statusVersion;
    try {
      const result = await request('invitation', { token });
      if (version === statusVersion) render(result);
    } catch (error) {
      if (version !== statusVersion) return;
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

  function validToken(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
  }

  function progressUrl(value) {
    const url = new URL(base);
    url.hash = new URLSearchParams({invite:value});
    return url.href;
  }

  function saveRecord(record) {
    const key = historyPrefix + record.token;
    const value = JSON.stringify(record);
    historyRecords.set(record.token, record);
    try { localStorage.setItem(key, value); return true; } catch {
      remember(key, value);
      return false;
    }
  }

  function loadRecords() {
    for (const storeName of ['sessionStorage', 'localStorage']) {
      try {
        const store = window[storeName];
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (!key?.startsWith(historyPrefix)) continue;
          try {
            const item = JSON.parse(store.getItem(key));
            if (validToken(item?.token) && key === historyPrefix + item.token && typeof item.name === 'string') {
              historyRecords.set(item.token, item);
            }
          } catch { /* Skip malformed records individually. */ }
        }
      } catch { /* Entries accepted during this visit remain available in memory. */ }
    }
  }

  function migrateBatchReceipts() {
    try {
      const saved = JSON.parse(read(batchKey) || '{}');
      if (!Array.isArray(saved.receipts)) return;
      loadRecords();
      let durable = true;
      for (const p of saved.receipts) {
        if (!validToken(p?.token) || typeof p.firstName !== 'string' || typeof p.lastName !== 'string' || historyRecords.has(p.token)) continue;
        const ok = saveRecord({token:p.token, name:(p.firstName + ' ' + p.lastName).trim(), submittedAt:null});
        durable = durable && ok;
      }
      if (durable) remember(batchKey, '');
    } catch { /* Keep any outstanding submission in its original slot. */ }
  }

  function historyLink(value, text) {
    const link = document.createElement('a');
    link.href = progressUrl(value);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = text;
    return link;
  }

  const historyDate = new Intl.DateTimeFormat('zh-CN', {
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false
  });
  function renderHistory() {
    statusElements.clear();
    historyDetailLinks.clear();
    const records = [...historyRecords.values()].sort((a,b) => (b.submittedAt || 0) - (a.submittedAt || 0));
    const people = get('history-list');
    people.replaceChildren(...records.map(person => {
      const row = document.createElement('li');
      const name = document.createElement('strong');
      name.className = 'history-person';
      name.textContent = person.name;
      const date = document.createElement('span');
      date.className = 'history-date';
      date.textContent = Number.isFinite(person.submittedAt) && person.submittedAt > 0
        ? historyDate.format(person.submittedAt) : '早期记录 · 提交时间未保存';
      const status = document.createElement('span');
      status.className = 'history-state';
      const lastState = statusCache.get(person.token)?.state || person.state;
      status.textContent = historyStatus(statusCache.get(person.token)) || states[lastState]?.[0] || '待查询';
      statusElements.set(person.token, status);
      const actions = document.createElement('div');
      actions.className = 'history-actions';
      const link = historyLink(person.token, '查看详情');
      historyDetailLinks.set(person.token, link);
      if (statusCache.get(person.token)?.verification) link.textContent = '查看邮箱验证';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '复制链接';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(link.href);
          get('history-note').textContent = '已复制 ' + person.name + ' 的进度链接。';
        } catch {
          get('history-note').textContent = '请长按或右键点击这位嘉宾的「查看详情」，选择复制链接。';
          link.focus();
        }
      });
      actions.append(link, copy);
      row.append(name, date, status, actions);
      return row;
    }));
    get('history-empty').hidden = records.length > 0;
  }

  function showPreviousLink() {
    get('history-previous')?.remove();
    if (!validToken(oldToken) || historyRecords.has(oldToken)) return;
    const unfinished = previousState === 'available' && read(publicRequestKey + ':attempt');
    if (!unfinished && !Object.hasOwn(states, previousState)) return;
    const link = historyLink(oldToken, unfinished ? '继续上次未完成的个人邀请' : '上次在此标签页查看的个人进度');
    if (unfinished) link.target = '_self';
    link.id = 'history-previous';
    get('history-list').after(link);
  }

  async function refreshHistory(force = false) {
    const run = ++historyRun;
    const button = get('history-refresh');
    button.disabled = true;
    loadRecords();
    renderHistory();
    showPreviousLink();
    const tokens = [...statusElements.keys()];
    if (validToken(oldToken) && !historyRecords.has(oldToken)) tokens.push(oldToken);
    const needsQuery = tokens.filter(t => force || Date.now() - (statusCache.get(t)?.checkedAt || 0) >= 30000);
    const note = get('history-note');
    note.textContent = needsQuery.length ? '正在查询最新进度…' : '';
    let next = 0;
    let unavailable = false;
    let stop = false;
    async function queryNext() {
      while (run === historyRun && !stop && next < needsQuery.length) {
        const t = needsQuery[next++];
        try {
          const result = await request('invitation', {token:t});
          if (run !== historyRun) return;
          if (result?.state !== 'available' && !Object.hasOwn(states, result?.state)) throw new Error('Unknown state');
          statusCache.set(t, {state:result.state, verification:result.verification, checkedAt:Date.now()});
          if (t === oldToken) { previousState = result.state; showPreviousLink(); }
          const label = statusElements.get(t);
          if (label) label.textContent = historyStatus(result) || states[result.state]?.[0] || '待核对';
          const link = historyDetailLinks.get(t);
          if (link) link.textContent = result.verification ? '查看邮箱验证' : '查看详情';
        } catch (err) {
          if (run !== historyRun) return;
          unavailable = true;
          const label = statusElements.get(t);
          if (label && [404,410].includes(err.status)) label.textContent = '进度链接不可用';
          else if (!err.status || err.status === 429 || err.status >= 500) stop = true;
        }
      }
    }
    await Promise.all([queryNext(), queryNext(), queryNext()]);
    if (run === historyRun) {
      button.disabled = false;
      note.textContent = unavailable ? '部分进度暂时无法更新，可点击「刷新进度」重试。' : '';
    }
  }

  historyOpen.addEventListener('click', () => {
    if (privateView || sending || !historyPanel.hidden) return;
    form.hidden = true;
    historyPanel.hidden = false;
    historyOpen.setAttribute('aria-expanded', 'true');
    get('history-title').focus();
    refreshHistory();
  });
  get('history-back').addEventListener('click', () => {
    historyRun++;
    historyPanel.hidden = true;
    historyOpen.setAttribute('aria-expanded', 'false');
    form.hidden = false;
    historyOpen.focus();
  });
  get('history-refresh').addEventListener('click', () => refreshHistory(true));
  let historyStorageTimer;
  window.addEventListener('storage', event => {
    if (!event.key?.startsWith(historyPrefix) || historyPanel.hidden || privateView) return;
    clearTimeout(historyStorageTimer);
    historyStorageTimer = setTimeout(() => {
      if (!historyPanel.hidden) refreshHistory();
    }, 100);
  });
  function guestInput(guest, name) {
    return guest.querySelector('input[name="' + name + '"]');
  }

  function updateBadge(guest) {
    const name = ['firstName', 'lastName'].map(key => guestInput(guest, key).value.trim()).filter(Boolean).join(' ');
    guestInput(guest, 'badgeName').placeholder = name || '默认使用英文全名（名 姓）';
  }

  function teamSubmission() {
    return batchMode || list.children.length > 1 || attempt?.kind === 'batch';
  }

  function clearConsent() {
    for (const input of form.querySelectorAll('input[type=checkbox]')) input.checked = false;
  }

  function refreshGuests() {
    const guests = [...list.children];
    const locked = sending || Boolean(attempt);
    const team = teamSubmission();
    add.hidden = privateView;
    historyOpen.disabled = sending;
    add.disabled = locked || guests.length >= 60;
    add.lastChild.textContent = guests.length >= 60 ? ' 已达到每次 60 位上限' : ' 添加一位嘉宾';
    for (const [i, guest] of guests.entries()) {
      const n = i + 1;
      const title = guest.querySelector('h3');
      title.textContent = '嘉宾 ' + n;
      title.id = 'guest-title-' + n;
      guest.setAttribute('aria-labelledby', title.id);
      const remove = guest.querySelector('.remove-guest');
      remove.hidden = guests.length === 1 || add.hidden;
      remove.disabled = locked;
      remove.setAttribute('aria-label', '移除嘉宾 ' + n);
      const hint = guest.querySelector('.email-hint');
      hint.id = 'email-hint-' + n;
      guestInput(guest, 'email').setAttribute('aria-describedby', hint.id);
      for (const input of guest.querySelectorAll('input')) {
        if (input.name === 'accessCode') {
          input.readOnly = sending;
          continue;
        }
        input.readOnly = locked;
        const purpose = input.autocomplete.split(' ').pop();
        input.autocomplete = 'section-guest' + n + ' ' + purpose;
      }
      updateBadge(guest);
    }
    const personal = get('personal-consents');
    personal.hidden = team; personal.disabled = team || sending;
    const group = get('team-consents');
    group.hidden = !team; group.disabled = !team || sending;
    submit.disabled = sending;
    submit.textContent = sending ? '正在提交…' : attempt ? '用原资料重试' : guests.length > 1 ? '下一步（' + guests.length + ' 位嘉宾）' : '下一步';
  }

  function appendGuest(person) {
    const guest = guestTemplate.cloneNode(true);
    for (const key of fields) guestInput(guest, key).value = person?.[key] || '';
    list.append(guest);
    return guest;
  }

  function changedGuests() {
    clearConsent();
    errorNote.hidden = true;
    for (const input of list.querySelectorAll('input')) input.setCustomValidity('');
  }

  add.addEventListener('click', () => {
    if (sending || attempt || privateView || list.children.length >= 60) return;
    const guest = appendGuest();
    changedGuests();
    refreshGuests();
    guestInput(guest, 'lastName').focus();
  });

  list.addEventListener('click', event => {
    const remove = event.target.closest('.remove-guest');
    if (!remove || sending || attempt || list.children.length === 1) return;
    const guest = remove.closest('.guest-card');
    const next = guest.nextElementSibling || guest.previousElementSibling;
    guest.remove();
    changedGuests();
    refreshGuests();
    guestInput(next, 'lastName').focus();
  });
  list.addEventListener('input', event => {
    if (event.target.name === 'accessCode') {
      for (const input of list.querySelectorAll('input[name="accessCode"]')) input.setCustomValidity('');
      errorNote.hidden = true;
      return;
    }
    changedGuests();
    updateBadge(event.target.closest('.guest-card'));
  });

  function collectEntries() {
    const emails = new Map();
    const entries = [];
    for (const [i, guest] of [...list.children].entries()) {
      const attendee = {consentPhoto:true, consentData:true};
      for (const key of fields) {
        const input = guestInput(guest, key);
        const value = input.value.trim();
        if (/[\p{Cc}\p{Cf}]/u.test(input.value) || (input.required && !value)) {
          input.setCustomValidity('请补全此项，并移除不可见字符。');
        }
        attendee[key] = key === 'email' ? value : value.replace(/\s+/gu, ' ');
      }
      const fullName = attendee.firstName + ' ' + attendee.lastName;
      attendee.fullName = fullName;
      if (fullName.length > 200) guestInput(guest, 'firstName').setCustomValidity('英文姓名合计最多可填写 200 个字符。');
      const email = guestInput(guest, 'email');
      const address = attendee.email.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)) email.setCustomValidity('请填写完整的收票邮箱。');
      if (emails.has(address)) email.setCustomValidity('此邮箱与嘉宾 ' + emails.get(address) + ' 重复，请核对。');
      emails.set(address, i + 1);
      const invalid = guest.querySelector('input:invalid');
      if (invalid) { invalid.reportValidity(); return null; }
      attendee.badgeName ||= fullName;
      entries.push({requestId:!teamSubmission() && requestId ? requestId : crypto.randomUUID(), attendee});
    }
    return entries;
  }

  function forgetAttempt(kind) {
    remember(kind === 'batch' ? batchKey : singleAttemptKey, '');
    if (kind === 'single') {
      requestId = '';
      remember(requestKey, '');
    }
    attempt = null;
  }

  function showSuccess(entries, results, durable) {
    notice.textContent = '已收到 ' + results.length + ' 位嘉宾的报名资料。请把下方对应的个人进度链接分别发给本人，以便在需要时用手机验证邮箱。';
    if (!durable) notice.textContent += '此浏览器暂时无法长期保存记录，请在关闭页面前复制进度链接。';
    if (results.length > 1) {
      const people = document.createElement('ul');
      people.className = 'batch-progress-links';
      entries.forEach(({attendee}, index) => {
        const row = document.createElement('li');
        const name = attendee.firstName + ' ' + attendee.lastName;
        row.append(name + ' · ', historyLink(results[index].token, '查看个人进度与验证步骤'));
        people.append(row);
      });
      notice.append(people);
      const safeCell = value => /^[=+\-@＝＋－＠]/u.test(value.trimStart()) ? "'" + value : value;
      const content = entries.map(({attendee}, i) =>
        [attendee.firstName + ' ' + attendee.lastName, attendee.email, progressUrl(results[i].token)].map(safeCell).join('\t')
      ).join('\n');
      const actions = document.createElement('span');
      actions.className = 'history-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '复制本次进度链接';
      const feedback = document.createElement('span');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(content);
          feedback.textContent = '已复制本次名单和进度链接。';
        } catch {
          feedback.textContent = '请点右上角「查看进度」，逐位复制对应链接。';
        }
      });
      const restart = document.createElement('button');
      restart.type = 'button';
      restart.textContent = '继续填写其他嘉宾';
      restart.addEventListener('click', () => {
        form.classList.remove('batch-complete');
        notice.hidden = true;
        guestInput(list.firstElementChild, 'accessCode').focus();
      });
      actions.append(copy, restart, feedback);
      notice.append(actions);
      form.classList.add('batch-complete');
    }
    notice.hidden = false;
    notice.focus();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || state !== 'available' || !form.reportValidity()) return;
    const kind = teamSubmission() ? 'batch' : 'single';
    const codes = [...list.children].map(guest => guestInput(guest, 'accessCode').value);
    for (const [index, code] of codes.entries()) {
      if (!/^[0-9]{6}$/.test(code) || codes.indexOf(code) !== index) {
        const input = guestInput(list.children[index], 'accessCode');
        input.setCustomValidity('请为每位嘉宾填写各自的六位数字报名码，同行嘉宾需分别使用不同的码。');
        input.reportValidity();
        return;
      }
    }
    if (!attempt) {
      const entries = collectEntries();
      if (!entries) return;
      attempt = {kind, entries};
      if (kind === 'single') {
        requestId = entries[0].requestId;
        remember(requestKey, requestId);
      }
      remember(kind === 'batch' ? batchKey : singleAttemptKey, JSON.stringify({attempt, origin:batchMode ? 'team' : 'root'}));
    }
    sending = true; busy = true;
    errorNote.hidden = true;
    refreshGuests();
    try {
      let results;
      // Attach the secrets only to this request. Entries are also used to persist retry drafts.
      const outgoing = attempt.entries.map((entry, index) => ({...entry, accessCode:codes[index]}));
      if (kind === 'single') {
        const receipt = await request('registration', {...outgoing[0], ...(privateView ? {token} : {})});
        results = [receipt];
      } else {
        const data = await request('registrations/batch', {entries:outgoing});
        results = data?.results;
      }
      if (!Array.isArray(results) || results.length !== attempt.entries.length ||
          !results.every(r => r && validToken(r.token) && Object.hasOwn(states, r.state))) throw new Error('Unconfirmed');
      const submittedAt = Date.now();
      const entries = attempt.entries;
      const durable = results.map((r, i) => {
        const person = entries[i].attendee;
        return saveRecord({name:person.firstName + ' ' + person.lastName, token:r.token, state:r.state, submittedAt});
      }).every(Boolean);
      forgetAttempt(kind);
      if (results.length === 1) {
        token = results[0].token;
        form.reset();
        if (!privateView) {
          location.assign(progressUrl(token));
          return;
        }
        history.replaceState(null, '', progressUrl(token));
        render(results[0]);
        title.focus();
      } else {
        list.replaceChildren();
        appendGuest();
        form.reset();
        clearConsent();
        errorNote.hidden = true;
        showForm();
        showSuccess(entries, results, durable);
      }
    } catch (err) {
      const prefix = Number.isInteger(err.row) ? '嘉宾 ' + err.row + '：' : '';
      const messages = {
        400:'请核对姓名、邮箱和两项授权。', 403:'请重新打开原申请链接。',
        409:kind === 'single' ? '该邮箱或邀请已有申请记录，请使用先前的进度链接。' : prefix + '申请资料有冲突，请核对是否已提交。已申请的嘉宾可以从本次名单中移除。',
        410:'本次赠票申请已截止。', 413:'名单过大，请分次提交。',
        422:prefix + '请核对姓名、收票邮箱和两项授权。',
        429:'提交过于频繁，请保留本页，稍后重试。'
      };
      if ([400,403,409,410,413,422].includes(err.status)) forgetAttempt(kind);
      const codeMessages = {
        ACCESS_CODE_UNAVAILABLE: prefix + '报名码无效或已使用，请核对六位数字，或联系发码的 UXUY 工作人员。',
        CAPACITY_FULL: '本场赠票名额已满，请联系 UXUY 工作人员。'
      };
      errorNote.textContent = codeMessages[err.code] || messages[err.status] || '暂时无法确认提交结果，请用原资料和同一个报名码重试。';
      errorNote.hidden = false;
      if (err.code === 'ACCESS_CODE_UNAVAILABLE') {
        guestInput(list.children[(err.row || 1) - 1] || list.firstElementChild, 'accessCode').focus();
      }
    } finally {
      sending = false; busy = false;
      if (!form.hidden) refreshGuests();
    }
  });

  function restoreSavedSubmission(key, defaultKind) {
    try {
      const saved = JSON.parse(read(key) || '{}');
      if (defaultKind === 'batch' && !batchMode && saved.origin !== 'root') return false;
      if (!saved.attempt?.entries?.length) return false;
      attempt = {kind:defaultKind, entries:saved.attempt.entries};
      list.replaceChildren();
      for (const {attendee} of attempt.entries) appendGuest(attendee);
      clearConsent();
      showForm();
      errorNote.textContent = '上次提交的结果待确认。请重新填写每位嘉宾原来的报名码，核对资料并勾选授权后重试。';
      errorNote.hidden = false;
      return true;
    } catch { remember(key, ''); return false; }
  }

  if (privateView) {
    if (validToken(token)) {
      showStatus('正在查询进度', '请稍候。');
      checkStatus();
    } else {
      showStatus('链接不可用', '请重新打开保存的完整进度链接。');
    }
  } else {
    historyOpen.hidden = false;
    migrateBatchReceipts();
    if (!(restoreSavedSubmission(batchKey, 'batch') || (!batchMode && restoreSavedSubmission(singleAttemptKey, 'single')))) showForm();
  }
})();
