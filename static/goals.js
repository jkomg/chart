// Current visit priorities, closed visit records, and ongoing issues.
(() => {
  const section = document.getElementById('goals');
  if (!section) return;
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) if (value != null) key === 'class' ? node.className = value : node.setAttribute(key, value);
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  };
  const normalizeItems = items => (Array.isArray(items) ? items : []).map((item, index) => ({
    priority: index + 1,
    doing: typeof item === 'string' ? '' : (item?.doing || ''),
    goal: typeof item === 'string' ? item : (item?.goal || ''),
    direction: typeof item === 'string' ? '' : (item?.direction || ''),
    addressed: Boolean(item?.addressed),
  }));
  const normalizeVisit = visit => ({
    date: typeof visit?.date === 'string' ? visit.date : '',
    closed_at: typeof visit?.closed_at === 'string' ? visit.closed_at : '',
    items: normalizeItems(visit?.items),
    questions: Array.isArray(visit?.questions) ? visit.questions : [],
  });
  const normalizeGoals = value => {
    value ||= {};
    // Existing flat priorities become the active visit without losing their details.
    const active = value.current_visit || { items: value.items, questions: value.questions };
    return {
      current_visit: normalizeVisit(active),
      visits: (Array.isArray(value.visits) ? value.visits : []).map(normalizeVisit),
      issues: (Array.isArray(value.issues) ? value.issues : []).filter(issue => issue && typeof issue.title === 'string').map(issue => ({ title: issue.title, detail: issue.detail || '' })),
    };
  };
  let goals = normalizeGoals(JSON.parse(document.getElementById('goals-data').textContent));
  const priorityList = section.querySelector('.priority-list');
  const questionList = section.querySelector('[data-key="questions"]');
  const historyList = section.querySelector('.visit-history');
  const issuesList = section.querySelector('.issues-list');
  const visitDate = section.querySelector('.visit-date');
  const closeVisitButton = section.querySelector('.close-visit');
  const navItem = document.querySelector('.nav-item[data-tab="goals"]');
  const fields = [
    ['doing', null, 'Treatments, tests, or steps already underway'],
    ['goal', 'Goal', 'What you hope to achieve or understand'],
    ['direction', 'Requested clinical direction', 'The advice, decision, or next step you want from your clinician'],
  ];
  let saving = false;
  const dirtyCards = new Set();
  const previousUnsavedCheck = chart.hasUnsavedPreparation || (() => false);
  chart.hasUnsavedPreparation = () => dirtyCards.size > 0 || previousUnsavedCheck();
  const localToday = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  };
  const dateLabel = date => date ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : 'Date not set';
  const snapshot = value => JSON.parse(JSON.stringify(value));

  async function save(next) {
    if (saving || chart.mode !== 'owner') return false;
    saving = true;
    const controls = [...section.querySelectorAll('button, textarea, input')].map(control => [control, control.disabled]);
    controls.forEach(([control]) => { control.disabled = true; });
    try {
      const res = await fetch('/api/goals', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      if (res.status === 401) { location.href = '/login'; return false; }
      if (!res.ok) throw new Error((await res.json()).error || 'Could not save issues and visit priorities.');
      goals = normalizeGoals(await res.json());
      dirtyCards.clear(); render();
      return true;
    } catch (error) {
      chart.toast(error.message || 'Couldn’t save. Check the connection and try again.');
      return false;
    } finally {
      saving = false;
      controls.forEach(([control, disabled]) => { if (control.isConnected) control.disabled = disabled; });
    }
  }

  function renderPriority(item, index, items, owner, archived = false) {
    const card = el('article', { class: `priority-card${owner ? ' priority-card-editing' : ' priority-card-provider'}${archived ? ' priority-card-archived' : ''}` });
    const priorityLabel = `Priority ${index + 1}`;
    const heading = el('div', { class: 'priority-card-heading' });
    if (owner && !archived) {
      const actions = el('div', { class: 'priority-actions' });
      for (const [offset, symbol, action] of [[-1, '↑', 'Move up'], [1, '↓', 'Move down']]) {
        const button = el('button', { type: 'button', class: 'outline-button compact', 'aria-label': `${action} priority ${index + 1}` }, symbol);
        button.disabled = index + offset < 0 || index + offset >= items.length || dirtyCards.size > 0;
        button.addEventListener('click', () => save({ ...goals, current_visit: { ...goals.current_visit, items: normalizeItems(items.map((entry, at) => at === index ? items[index + offset] : at === index + offset ? items[index] : entry)) } }));
        actions.append(button);
      }
      const remove = el('button', { type: 'button', class: 'text-button priority-remove' }, 'Remove');
      remove.disabled = dirtyCards.size > 0;
      remove.addEventListener('click', () => { if (confirm(`Remove priority ${index + 1} from this visit?`)) save({ ...goals, current_visit: { ...goals.current_visit, items: items.filter((_, at) => at !== index) } }); });
      actions.append(remove); heading.append(actions); card.append(heading);
    }
    if (owner && !archived) {
      const form = el('form', { class: 'priority-fields priority-form' });
      const inputs = {};
      for (const [key, label, placeholder] of fields) {
        const input = el('textarea', { rows: 3, maxlength: 5000, 'aria-label': label || priorityLabel, placeholder });
        input.value = item[key]; inputs[key] = input;
        form.append(el('label', { class: `priority-field priority-field-${key}` }, el('span', {}, label || priorityLabel), input));
      }
      const addressed = el('input', { type: 'checkbox', 'aria-label': `Mark priority ${index + 1} addressed` });
      addressed.checked = item.addressed;
      const statusLabel = el('label', { class: 'priority-addressed' }, addressed, el('span', {}, 'Addressed during this visit'));
      form.append(statusLabel);
      const footer = el('div', { class: 'priority-form-footer' });
      const status = el('span', { class: 'save-status', role: 'status' });
      const saveButton = el('button', { type: 'submit', class: 'primary-button compact' }, 'Save priority details');
      footer.append(status, saveButton); form.append(footer);
      const updateDirty = () => {
        const dirty = fields.some(([key]) => inputs[key].value !== item[key]) || addressed.checked !== item.addressed;
        dirty ? dirtyCards.add(index) : dirtyCards.delete(index);
        status.textContent = dirty ? 'Unsaved changes' : 'Saved';
        card.classList.toggle('priority-unsaved', dirty);
        section.querySelectorAll('.priority-actions button').forEach(button => { if (button.getAttribute('aria-label') || button.classList.contains('priority-remove')) button.disabled = dirtyCards.size > 0; });
        section.querySelectorAll('.priority-add,.close-visit,.visit-date,.goal-form button,.goal-form input,.issues-list button,.issues-list input,.issues-list textarea').forEach(control => {
          if (control.classList.contains('visit-date')) control.disabled = !owner || dirtyCards.size > 0;
          else control.disabled = dirtyCards.size > 0;
        });
      };
      form.addEventListener('input', updateDirty);
      form.addEventListener('submit', event => {
        event.preventDefault();
        const updated = { ...item, ...Object.fromEntries(fields.map(([key]) => [key, inputs[key].value.trim()])), addressed: addressed.checked };
        save({ ...goals, current_visit: { ...goals.current_visit, items: items.map((entry, at) => at === index ? updated : entry) } });
      });
      card.append(form);
    } else {
      const content = el('div', { class: 'priority-fields priority-readonly' });
      let populated = false;
      for (const [key, label] of fields) {
        if (!item[key]) continue;
        populated = true;
        content.append(el('section', { class: `priority-field priority-field-${key}` }, el('h3', {}, label || priorityLabel), el('p', {}, item[key])));
      }
      if (!populated) content.append(el('p', { class: 'vital-meta goal-empty' }, 'Details have not been added yet.'));
      if (archived) content.append(el('p', { class: `visit-item-status${item.addressed ? ' addressed' : ''}` }, item.addressed ? 'Addressed' : 'Not addressed · carried forward'));
      card.append(content);
    }
    return card;
  }

  function renderQuestions(list, questions, owner, visit) {
    list.replaceChildren();
    if (!questions.length) list.append(el('p', { class: 'vital-meta goal-empty' }, 'No questions added yet.'));
    questions.forEach((text, index) => {
      const row = el('div', { class: 'goal-row' }, el('span', { class: 'question-number' }, String(index + 1).padStart(2, '0')), el('span', { class: 'goal-text' }, text));
      if (owner) {
        const edit = el('button', { type: 'button', class: 'text-button' }, 'Edit');
        edit.addEventListener('click', () => {
          const input = el('input', { type: 'text', class: 'search-input', maxlength: 2000, value: text, 'aria-label': 'Edit question' });
          const form = el('form', { class: 'goal-form' }, input, el('button', { type: 'submit', class: 'primary-button compact' }, 'Save'));
          form.addEventListener('submit', event => { event.preventDefault(); const next = [...questions]; next[index] = input.value.trim(); save({ ...goals, [visit]: { ...goals[visit], questions: next.filter(Boolean) } }); });
          row.replaceChildren(form); input.focus();
        });
        const remove = el('button', { type: 'button', class: 'text-button' }, 'Remove');
        remove.addEventListener('click', () => { if (confirm(`Remove this question?\n\n${text}`)) save({ ...goals, [visit]: { ...goals[visit], questions: questions.filter((_, at) => at !== index) } }); });
        row.append(el('span', { class: 'goal-actions' }, edit, remove));
      }
      list.append(row);
    });
    if (owner) {
      const input = el('input', { type: 'text', class: 'search-input', maxlength: 2000, placeholder: 'Add a question', 'aria-label': 'Add a question' });
      const form = el('form', { class: 'goal-form' }, input, el('button', { type: 'submit', class: 'primary-button compact' }, 'Add question'));
      form.addEventListener('submit', event => { event.preventDefault(); const text = input.value.trim(); if (text) save({ ...goals, [visit]: { ...goals[visit], questions: [...questions, text] } }); });
      list.append(form);
    }
  }

  function renderHistory(owner) {
    if (!historyList) return;
    historyList.replaceChildren();
    if (!goals.visits.length) historyList.append(el('p', { class: 'vital-meta goal-empty' }, 'Closed visits will be saved here.'));
    goals.visits.forEach((visit, index) => {
      const entry = el('details', { class: 'visit-history-entry' });
      entry.append(el('summary', {}, el('span', { class: 'visit-history-date' }, dateLabel(visit.date || visit.closed_at)),
        el('span', { class: 'visit-history-count' }, `${visit.items.length} ${visit.items.length === 1 ? 'priority' : 'priorities'}`)));
      if (visit.date && visit.closed_at && visit.date !== visit.closed_at) entry.append(el('p', { class: 'vital-meta visit-closed-date' }, `Closed ${dateLabel(visit.closed_at)}`));
      const content = el('div', { class: 'visit-history-content' });
      visit.items.forEach((item, itemIndex) => content.append(renderPriority(item, itemIndex, visit.items, false, true)));
      if (visit.questions.length) {
        content.append(el('h3', { class: 'visit-history-questions-title' }, 'Questions'));
        visit.questions.forEach(question => content.append(el('p', { class: 'visit-history-question' }, question)));
      }
      if (owner) {
        const restore = el('button', { type: 'button', class: 'outline-button compact visit-reopen' }, 'Reopen visit');
        restore.addEventListener('click', () => {
          if (!confirm('Reopen this visit? Its priorities and questions will become the current visit.')) return;
          const current = snapshot(goals.current_visit);
          const prior = goals.visits.filter((_, at) => at !== index);
          if (current.items.length || current.questions.length) prior.unshift({ ...current, closed_at: localToday() });
          save({ ...goals, current_visit: { ...visit, closed_at: '' }, visits: prior });
        });
        content.append(restore);
      }
      entry.append(content); historyList.append(entry);
    });
  }

  function renderIssues(owner) {
    if (!issuesList) return;
    issuesList.replaceChildren();
    if (!goals.issues.length) issuesList.append(el('p', { class: 'vital-meta goal-empty' }, 'Ongoing issues you want to track will appear here.'));
    goals.issues.forEach((issue, index) => {
      const card = el('article', { class: 'ongoing-issue' });
      if (!owner) {
        card.append(el('h3', {}, issue.title), issue.detail ? el('p', {}, issue.detail) : null);
      } else {
        const form = el('form', { class: 'issue-form' });
        const title = el('input', { type: 'text', maxlength: 2000, required: true, 'aria-label': 'Issue' }); title.value = issue.title;
        const detail = el('textarea', { rows: 2, maxlength: 5000, 'aria-label': 'Issue details', placeholder: 'Details or notes' }); detail.value = issue.detail;
        form.append(el('label', {}, 'Issue', title), el('label', {}, 'Details', detail));
        const actions = el('div', { class: 'issue-actions' });
        const saveIssue = el('button', { type: 'submit', class: 'primary-button compact' }, 'Save issue');
        const prioritize = el('button', { type: 'button', class: 'outline-button compact' }, 'Add to this visit');
        prioritize.addEventListener('click', () => save({ ...goals, current_visit: { ...goals.current_visit, items: [...goals.current_visit.items, { doing: '', goal: issue.title, direction: '', addressed: false }] } }));
        const remove = el('button', { type: 'button', class: 'text-button' }, 'Remove');
        remove.addEventListener('click', () => { if (confirm(`Remove issue “${issue.title}”?`)) save({ ...goals, issues: goals.issues.filter((_, at) => at !== index) }); });
        actions.append(saveIssue, prioritize, remove); form.append(actions);
        form.addEventListener('submit', event => {
          event.preventDefault();
          if (!title.value.trim()) return;
          const issues = [...goals.issues]; issues[index] = { title: title.value.trim(), detail: detail.value.trim() };
          save({ ...goals, issues });
        });
        card.append(form);
      }
      issuesList.append(card);
    });
    if (owner) {
      const form = el('form', { class: 'issue-form issue-new-form' });
      const title = el('input', { type: 'text', maxlength: 2000, required: true, placeholder: 'Add an ongoing issue', 'aria-label': 'New issue' });
      const detail = el('textarea', { rows: 2, maxlength: 5000, placeholder: 'Details or notes', 'aria-label': 'New issue details' });
      form.append(el('label', {}, 'Issue', title), el('label', {}, 'Details', detail), el('button', { type: 'submit', class: 'outline-button priority-add' }, '＋ Add issue'));
      form.addEventListener('submit', event => { event.preventDefault(); if (title.value.trim()) save({ ...goals, issues: [...goals.issues, { title: title.value.trim(), detail: detail.value.trim() }] }); });
      issuesList.append(form);
    }
  }

  function render() {
    const owner = chart.mode === 'owner';
    const current = goals.current_visit;
    if (visitDate) {
      visitDate.value = current.date;
      visitDate.disabled = !owner || dirtyCards.size > 0;
    }
    if (closeVisitButton) { closeVisitButton.hidden = !owner; closeVisitButton.disabled = dirtyCards.size > 0 || (!current.items.length && !current.questions.length); }
    priorityList.replaceChildren();
    if (!current.items.length) priorityList.append(el('p', { class: 'vital-meta goal-empty' }, 'No visit priorities added yet.'));
    current.items.forEach((item, index) => priorityList.append(renderPriority(item, index, current.items, owner)));
    if (owner) {
      const add = el('button', { type: 'button', class: 'outline-button priority-add' }, '＋ Add a visit priority');
      add.disabled = dirtyCards.size > 0;
      add.addEventListener('click', () => save({ ...goals, current_visit: { ...current, items: [...current.items, { doing: '', goal: '', direction: '', addressed: false }] } }));
      priorityList.append(add);
    }
    renderQuestions(questionList, current.questions, owner, 'current_visit');
    renderHistory(owner); renderIssues(owner);
    if (navItem) {
      navItem.querySelector('em')?.remove();
      if (goals.issues.length) navItem.append(' ', el('em', {}, String(Math.min(goals.issues.length, 99))));
    }
  }

  if (visitDate) visitDate.addEventListener('change', () => save({ ...goals, current_visit: { ...goals.current_visit, date: visitDate.value } }));
  if (closeVisitButton) closeVisitButton.addEventListener('click', () => {
    if (chart.mode !== 'owner') return;
    const current = snapshot(goals.current_visit);
    const carry = current.items.filter(item => !item.addressed).map(item => ({ ...item, addressed: false }));
    const message = `Close this visit and save it in Previous visits?${carry.length ? ` ${carry.length} unaddressed ${carry.length === 1 ? 'priority will' : 'priorities will'} carry forward.` : ''}`;
    if (!confirm(message)) return;
    save({ ...goals, visits: [{ ...current, closed_at: localToday() }, ...goals.visits], current_visit: { date: '', items: carry, questions: [] } });
  });
  document.addEventListener('chart:mode', render);
  document.addEventListener('chart:discardPreparation', () => { dirtyCards.clear(); render(); });
  render();
})();
