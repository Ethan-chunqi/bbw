'use strict';

(() => {
  const get = id => document.getElementById(id);
  const form = get('registration');
  const progress = get('application-progress');
  if (!progress || !form.elements.firstName || !form.elements.lastName || !get('batch-form')) {
    const fresh = new URL(location.href);
    if (fresh.searchParams.get('form') !== 'batch-20261120') {
      fresh.searchParams.set('form', 'batch-20261120');
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
    if (nextToken !== token) { requestId = ''; remember(requestKey, ''); }
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
    get('entry-modes').hidden = Boolean(token);
    form.hidden = false;
    submit.disabled = false;
  }

  function showStatus(heading, detail, retry = false, personal = false) {
    clearTimeout(timer);
    form.hidden = true;
    get('entry-modes').hidden = true;
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

  form.addEventListener('input', event => {
    if (event.target.setCustomValidity) event.target.setCustomValidity('');
    if (['firstName', 'lastName'].includes(event.target.name)) {
      const fields = form.elements;
      fields.firstName.setCustomValidity('');
      fields.lastName.setCustomValidity('');
      fields.badgeName.placeholder = [fields.firstName.value, fields.lastName.value]
        .map(value => value.trim()).filter(Boolean).join(' ') || '默认使用英文全名';
    }
    errorNote.hidden = true;
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || state !== 'available') return;
    const fields = form.elements;
    for (const field of [fields.lastName, fields.firstName, fields.badgeName]) {
      if (/\p{Cc}|\p{Cf}/u.test(field.value) || (field.required && !field.value.trim())) {
        field.setCustomValidity('请填写姓名，并移除不可见字符。');
        field.reportValidity();
        return;
      }
    }
    const normalize = value => value.trim().replace(/\s+/gu, ' ');
    const firstName = normalize(fields.firstName.value);
    const lastName = normalize(fields.lastName.value);
    const fullName = firstName + ' ' + lastName;
    if (fullName.length > 200) {
      fields.firstName.setCustomValidity('英文姓名合计最多可填写 200 个字符。');
      fields.firstName.reportValidity();
      return;
    }
    const attendee = {
      firstName, lastName, fullName, badgeName: normalize(fields.badgeName.value) || fullName,
      email: fields.email.value.trim(),
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

  function openBatch() {
    const batch = get('batch-form');
    const paste = get('batch-paste');
    const send = get('batch-submit');
    const picker = get('entry-modes');
    const problem = get('batch-error');
    const receiptCard = get('batch-result');
    const key = 'bbw-guest-batch:' + base.pathname;
    let rows = [];
    let attempt = null;
    let receipts = [];

    form.hidden = true;
    picker.hidden = false;
    batch.hidden = false;
    get('single-mode').removeAttribute('aria-current');
    get('batch-mode').setAttribute('aria-current', 'page');

    function readRows() {
      const parsed = [];
      const errors = [];
      const emails = new Map();
      const lines = paste.value.split(/\r\n?|\n/);
      const seenHeader = cols =>
        /^(姓|姓（英文或拼音）|last ?name|surname)$/i.test(cols[0]) &&
        /^(名|名（英文或拼音）|first ?name|given ?name)$/i.test(cols[1]) &&
        /^(邮箱|(?:本人)?收票邮箱|e-?mail(?: address)?)$/i.test(cols[2]);
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const cols = line.split(line.includes('\t') ? '\t' : ',').map(v => v.trim());
        if (count === 0 && !parsed.length && seenHeader(cols)) continue;
        if (++count > 60) {
          errors.push('每次最多提交 60 人，请拆分名单。');
          break;
        }
        const [lastName, firstName, email, badgeName = ''] = cols;
        const lineNo = i + 1;
        let reason;
        if (cols.length < 3 || cols.length > 4) reason = '请按「姓、名、收票邮箱、胸牌显示名（选填）」排列各列。';
        else if (!lastName || !firstName || (firstName + ' ' + lastName).length > 200 || badgeName.length > 200) reason = '请核对姓、名和胸牌名，姓名最多 200 个字符。';
        else if (cols.some(v => /[\p{Cc}\p{Cf}]/u.test(v))) reason = '资料中有不可见字符，请重新输入。';
        else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254) reason = '请核对收票邮箱。';
        else if (emails.has(email.toLowerCase())) reason = '收票邮箱与第 ' + emails.get(email.toLowerCase()) + ' 行重复。';
        if (reason) errors.push('第 ' + lineNo + ' 行：' + reason);
        else {
          emails.set(email.toLowerCase(), lineNo);
          parsed.push({lineNo, lastName, firstName, email, badgeName});
        }
      }
      if (paste.value.trim() && !count) errors.push('请在表头下方添加嘉宾资料。');
      return {parsed, errors};
    }

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

    function preview() {
      const {parsed, errors} = readRows();
      rows = parsed;
      const note = get('batch-input-error');
      note.hidden = !errors.length;
      note.textContent = errors.join('\n');
      paste.setCustomValidity(errors[0] || '');
      get('batch-preview').hidden = !parsed.length;
      get('preview-title').textContent = '名单预览 · ' + parsed.length + ' 位嘉宾';
      get('preview-rows').replaceChildren(...rows.map(person => {
        const item = personItem(person);
        const badge = document.createElement('small');
        badge.textContent = '胸牌：' + (person.badgeName || person.firstName + ' ' + person.lastName);
        item.append(badge);
        return item;
      }));
      send.disabled = !parsed.length || !!errors.length || busy;
      send.textContent = '提交 ' + parsed.length + ' 位嘉宾的申请';
      if (!parsed.length) send.textContent = '批量提交申请';
    }

    function progressUrl(person) {
      const url = new URL(base);
      url.hash = new URLSearchParams({invite:person.token});
      return url.href;
    }

    function showReceipts() {
      batch.hidden = true;
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

    function setSending(value) {
      busy = value;
      paste.readOnly = value || Boolean(attempt);
      send.disabled = value;
      get('batch-photo').disabled = value;
      get('batch-data').disabled = value;
    }

    paste.addEventListener('input', () => {
      get('batch-photo').checked = false;
      get('batch-data').checked = false;
      problem.hidden = true;
      preview();
    });
    batch.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !batch.reportValidity() || !rows.length) return;
      if (!attempt) {
        const entries = rows.map(({lineNo, ...attendee}) => ({
          requestId:crypto.randomUUID(), attendee:{...attendee, consentPhoto:true, consentData:true}
        }));
        attempt = {text:paste.value, entries};
        remember(key, JSON.stringify({attempt}));
      }
      problem.hidden = true;
      setSending(true);
      send.textContent = '正在提交…';
      try {
        const data = await request('registrations/batch', {entries:attempt.entries});
        if (data?.results?.length !== rows.length || !data.results.every(r => r && typeof r.token === 'string' && r.token && Object.hasOwn(states, r.state))) throw new Error('Unconfirmed');
        receipts = rows.map(({firstName,lastName,email}, i) => ({firstName,lastName,email,token:data.results[i].token}));
        attempt = null;
        remember(key, JSON.stringify({receipts}));
        batch.reset();
        showReceipts();
      } catch (err) {
        const prefix = rows[err.row - 1] ? '第 ' + rows[err.row - 1].lineNo + ' 行：' : '';
        const messages = {
          400:'请核对名单和授权后重新提交。', 403:'请使用官方申请页重新打开。',
          409:prefix + '申请信息有冲突，请核对是否已提交。请移除已申请的嘉宾后再提交其余名单。',
          410:'本次赠票申请已截止。', 413:'名单过大，请拆分后提交。',
          422:prefix + '请核对姓名、收票邮箱和两项授权后再试。',
          429:'提交过于频繁，请保留本页，稍后重试。'
        };
        if ([400,403,409,410,413,422].includes(err.status)) {
          attempt = null;
          remember(key, '');
        }
        problem.textContent = messages[err.status] || '暂时无法确认结果。请保留本页，点击下方按钮，用原名单重试。';
        problem.hidden = false;
      } finally {
        setSending(false);
        send.textContent = attempt ? '用原名单重试' : '提交 ' + rows.length + ' 位嘉宾的申请';
      }
    });
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
    get('batch-next').addEventListener('click', () => {
      remember(key, '');
      receipts = [];
      get('result-rows').replaceChildren();
      get('batch-copy-note').textContent = '';
      receiptCard.hidden = true;
      batch.hidden = false;
      problem.hidden = true;
      preview();
      paste.focus();
    });
    try {
      const saved = JSON.parse(read(key) || '{}');
      if (saved.receipts?.length) {
        receipts = saved.receipts;
        showReceipts();
        return;
      }
      if (saved.attempt?.entries?.length && typeof saved.attempt.text === 'string') {
        attempt = saved.attempt;
        paste.value = attempt.text;
        paste.readOnly = true;
        problem.textContent = '上次提交的结果待确认。请核对原名单并勾选授权，然后重试。';
        problem.hidden = false;
      }
    } catch { remember(key, ''); }
    preview();
    if (attempt) send.textContent = '用原名单重试';
  }

  if (batchMode) openBatch();
  else if (token) { showStatus('正在查询进度', '请稍候。'); checkStatus(); }
  else showForm();
})();
