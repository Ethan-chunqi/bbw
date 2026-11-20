'use strict';

(() => {
  const get = id => document.getElementById(id);
  const form = get('registration');
  const progress = get('application-progress');
  if (!progress || !form.elements.firstName || !form.elements.lastName || !get('add-guest')) {
    const fresh = new URL(location.href);
    if (fresh.searchParams.get('form') !== 'guests-20261120') {
      fresh.searchParams.set('form', 'guests-20261120');
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
  const requestKey = 'bbw-guest-request:' + base.pathname;
  const batchKey = 'bbw-guest-batch:' + base.pathname;
  const singleAttemptKey = requestKey + ':attempt';
  const list = get('guest-list');
  const guestTemplate = list.firstElementChild.cloneNode(true);
  const add = get('add-guest');
  const receiptCard = get('batch-result');
  const fields = ['lastName', 'firstName', 'email', 'badgeName'];
  let attempt = null;
  let receipts = [];
  const states = {
    pending: ['申请已提交，等待审核', 'UXUY 收到了你的申请。审核通过后，UXUY 将代你办理活动报名和领票。'],
    declined: ['申请未通过', '如需了解具体情况，请联系发出邀请的 UXUY 工作人员。'],
    approved: ['审核已通过', 'UXUY 已通过你的申请，接下来将办理报名和领票。'],
    queued: ['审核已通过', '你的报名资料已进入领票办理队列。'],
    processing: ['正在办理领票', 'UXUY 正在为你办理活动报名和领票。'],
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
  const batchMode = !fragment.has('invite') && new URL(location.href).searchParams.get('mode') === 'batch';
  if (fragment.has('invite')) {
    const nextToken = fragment.get('invite').trim();
    if (nextToken !== token) { requestId = ''; remember(requestKey, ''); remember(singleAttemptKey, ''); }
    setToken(nextToken);
    const cleanUrl = new URL(location.href);
    cleanUrl.hash = '';
    cleanUrl.searchParams.delete('mode');
    history.replaceState(null, '', cleanUrl.href);
  }
  window.addEventListener('hashchange', () => {
    if (new URLSearchParams(location.hash.slice(1)).has('invite')) location.reload();
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
    receiptCard.hidden = true;
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

  function personItem(person) {
    const item = document.createElement('li');
    const info = document.createElement('div');
    const name = document.createElement('strong');
    const email = document.createElement('span');
    name.textContent = person.firstName + ' ' + person.lastName;
    email.textContent = person.email;
    info.append(name, email);
    item.append(info);
    return item;
  }

  function progressUrl(person) {
    const url = new URL(base);
    url.hash = new URLSearchParams({invite:person.token});
    return url.href;
  }

  function showReceipts() {
    form.hidden = true;
    receiptCard.hidden = false;
    get('batch-result-title').textContent = receipts.length + ' 份嘉宾申请已提交';
    get('result-rows').replaceChildren(...receipts.map(person => {
      const item = personItem(person);
      const link = document.createElement('a');
      link.href = progressUrl(person);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '查看进度';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-person';
      copy.textContent = '复制链接';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(link.href);
          get('batch-copy-note').textContent = '已复制 ' + person.firstName + ' ' + person.lastName + ' 的进度链接。';
        } catch {
          get('batch-copy-note').textContent = '请长按或右键点击这位嘉宾的「查看进度」，选择复制链接。';
          link.focus();
        }
      });
      const actions = document.createElement('div');
      actions.className = 'person-actions';
      actions.append(link, copy);
      item.append(actions);
      return item;
    }));
    get('batch-result-title').focus();
  }

  get('copy-batch').addEventListener('click', async () => {
    const spreadsheetCell = value => /^[=+\-@＝＋－＠]/u.test(value.trimStart()) ? "'" + value : value;
    const content = receipts.map(p => [p.firstName + ' ' + p.lastName, p.email, progressUrl(p)].map(spreadsheetCell).join('\t')).join('\n');
    try {
      await navigator.clipboard.writeText(content);
      get('batch-copy-note').textContent = '已复制全部姓名、邮箱和进度链接，可粘贴到内部表格。';
    } catch {
      get('batch-copy-note').textContent = '请逐人长按或右键点击「查看进度」，选择复制链接。';
    }
  });
  let sending = false;

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
    add.hidden = !batchMode && Boolean(token);
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
    submit.textContent = sending ? '正在提交…' : attempt ? '用原资料重试' : team ? '提交 ' + guests.length + ' 位嘉宾的申请' : '提交申请';
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
    if (sending || attempt || (!batchMode && token) || list.children.length >= 60) return;
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

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || state !== 'available' || !form.reportValidity()) return;
    const kind = teamSubmission() ? 'batch' : 'single';
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
      if (kind === 'single') {
        const receipt = await request('registration', {...attempt.entries[0], ...(token ? {token} : {})});
        if (!receipt || !Object.hasOwn(states, receipt.state)) throw new Error('Unconfirmed');
        if (typeof receipt.token === 'string' && receipt.token) setToken(receipt.token);
        if (!token) throw new Error('Missing receipt');
        forgetAttempt(kind);
        form.reset();
        render(receipt);
        title.focus();
      } else {
        const data = await request('registrations/batch', {entries:attempt.entries});
        if (data?.results?.length !== attempt.entries.length || !data.results.every(r => r && typeof r.token === 'string' && r.token && Object.hasOwn(states, r.state))) throw new Error('Unconfirmed');
        receipts = attempt.entries.map(({attendee:{firstName,lastName,email}}, i) => ({firstName,lastName,email,token:data.results[i].token}));
        attempt = null;
        remember(batchKey, JSON.stringify({receipts, origin:batchMode ? 'team' : 'root'}));
        form.reset();
        showReceipts();
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
      errorNote.textContent = messages[err.status] || '暂时无法确认提交结果，请用原资料重试。';
      errorNote.hidden = false;
    } finally {
      sending = false; busy = false;
      if (!form.hidden) refreshGuests();
    }
  });

  get('batch-next').addEventListener('click', () => {
    remember(batchKey, '');
    receipts = [];
    receiptCard.hidden = true;
    get('result-rows').replaceChildren();
    get('batch-copy-note').textContent = '';
    list.replaceChildren();
    const guest = appendGuest();
    clearConsent();
    errorNote.hidden = true;
    showForm();
    guestInput(guest, 'lastName').focus();
  });

  function restoreSavedSubmission(key, defaultKind) {
    try {
      const saved = JSON.parse(read(key) || '{}');
      if (defaultKind === 'batch' && !batchMode && saved.origin !== 'root') return false;
      if (saved.receipts?.length) {
        receipts = saved.receipts;
        showReceipts();
        return true;
      }
      if (!saved.attempt?.entries?.length) return false;
      attempt = {kind:defaultKind, entries:saved.attempt.entries};
      list.replaceChildren();
      for (const {attendee} of attempt.entries) appendGuest(attendee);
      clearConsent();
      showForm();
      errorNote.textContent = '上次提交的结果待确认，请核对资料、勾选授权后重试。';
      errorNote.hidden = false;
      return true;
    } catch { remember(key, ''); return false; }
  }

  if (!batchMode && token) {
    showStatus('正在查询进度', '请稍候。');
    checkStatus().then(() => {
      if (state === 'available') restoreSavedSubmission(singleAttemptKey, 'single');
    });
  } else if (!(restoreSavedSubmission(batchKey, 'batch') || (!batchMode && restoreSavedSubmission(singleAttemptKey, 'single')))) {
    showForm();
  }
})();
