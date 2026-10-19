// Visit priorities are ordered records with three patient-authored fields.
(() => {
  const section = document.getElementById('goals');
  if (!section) return;
  let goals = JSON.parse(document.getElementById('goals-data').textContent);
  const lists = [...section.querySelectorAll('.goal-list')];
  const navItem = document.querySelector('.nav-item[data-tab="goals"]');
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) if (value != null) key === 'class' ? node.className = value : node.setAttribute(key, value);
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  };
  const fields = [
    ['doing', 'What’s being done', 'Treatments, tests, or steps already underway'],
    ['goal', 'Goal', 'What you hope to achieve or understand'],
    ['direction', 'Requested clinical direction', 'The advice, decision, or next step you want from your clinician'],
  ];
  const normalize = items => (items || []).map((item, index) => ({
    priority: index + 1,
    doing: typeof item === 'string' ? '' : (item?.doing || ''),
    goal: typeof item === 'string' ? item : (item?.goal || ''),
    direction: typeof item === 'string' ? '' : (item?.direction || ''),
  }));
  goals.items = normalize(goals.items);
  goals.questions ||= [];
  let saving = false;
  const dirtyCards = new Set();
  const previousUnsavedCheck = chart.hasUnsavedPreparation || (() => false);
  chart.hasUnsavedPreparation = () => dirtyCards.size > 0 || previousUnsavedCheck();

  async function save(next) {
    if (saving || chart.mode !== 'owner') return false;
    saving = true;
    const controls = [...section.querySelectorAll('button, textarea, input')].map(control => [control, control.disabled]);
    controls.forEach(([control]) => { control.disabled = true; });
    try {
      const res = await fetch('/api/goals', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      if (res.status === 401) { location.href = '/login'; return false; }
      if (!res.ok) {
        const result = await res.json();
        throw new Error(result.error || 'Could not save priorities.');
      }
      goals = await res.json();
      goals.items = normalize(goals.items);
      dirtyCards.clear();
      render();
      return true;
    } catch (error) {
      chart.toast(error.message || 'Couldn’t save. Check the connection and try again.');
      return false;
    } finally {
      saving = false;
      controls.forEach(([control, disabled]) => { if (control.isConnected) control.disabled = disabled; });
    }
  }

  function renderPriority(item, index, items, owner) {
    const card = el('article', { class: `priority-card${owner ? ' priority-card-editing' : ' priority-card-provider'}` });
    const badge = el('span', { class: 'priority-badge' }, `Priority ${index + 1}`);
    const heading = el('div', { class: 'priority-card-heading' }, badge);
    if (owner) {
      const actions = el('div', { class: 'priority-actions' });
      for (const [offset, symbol, action] of [[-1, '↑', 'Move up'], [1, '↓', 'Move down']]) {
        const button = el('button', { type: 'button', class: 'outline-button compact', 'aria-label': `${action} priority ${index + 1}` }, symbol);
        button.disabled = index + offset < 0 || index + offset >= items.length || dirtyCards.size > 0;
        button.addEventListener('click', () => save({ ...goals, items: normalize(items.map((entry, at) => at === index ? items[index + offset] : at === index + offset ? items[index] : entry)) }));
        actions.append(button);
      }
      const remove = el('button', { type: 'button', class: 'text-button priority-remove' }, 'Remove');
      remove.disabled = dirtyCards.size > 0;
      remove.addEventListener('click', () => {
        if (confirm(`Remove priority ${index + 1}?`)) save({ ...goals, items: items.filter((_, at) => at !== index) });
      });
      actions.append(remove);
      heading.append(actions);
    }
    card.append(heading);
    if (owner) {
      const form = el('form', { class: 'priority-fields priority-form' });
      const inputs = {};
      for (const [key, label, placeholder] of fields) {
        const input = el('textarea', { rows: 3, maxlength: 5000, 'aria-label': label, placeholder });
        input.value = item[key];
        inputs[key] = input;
        form.append(el('label', { class: `priority-field priority-field-${key}` }, el('span', {}, label), input));
      }
      const footer = el('div', { class: 'priority-form-footer' });
      const status = el('span', { class: 'save-status', role: 'status' });
      const saveButton = el('button', { type: 'submit', class: 'primary-button compact' }, 'Save priority details');
      footer.append(status, saveButton);
      form.append(footer);
      form.addEventListener('input', () => {
        const dirty = fields.some(([key]) => inputs[key].value !== item[key]);
        dirty ? dirtyCards.add(index) : dirtyCards.delete(index);
        status.textContent = dirty ? 'Unsaved changes' : 'Saved';
        card.classList.toggle('priority-unsaved', dirty);
        const list = section.querySelector('.priority-list');
        list.querySelectorAll('.priority-actions button').forEach(button => { if (button.getAttribute('aria-label') || button.classList.contains('priority-remove')) button.disabled = dirtyCards.size > 0; });
      });
      form.addEventListener('submit', event => {
        event.preventDefault();
        const updated = { ...item, ...Object.fromEntries(fields.map(([key]) => [key, inputs[key].value.trim()])) };
        save({ ...goals, items: items.map((entry, at) => at === index ? updated : entry) });
      });
      card.append(form);
    } else {
      const content = el('div', { class: 'priority-fields priority-readonly' });
      let populated = false;
      for (const [key, label] of fields) {
        if (!item[key]) continue;
        populated = true;
        content.append(el('section', { class: `priority-field priority-field-${key}` }, el('h3', {}, label), el('p', {}, item[key])));
      }
      if (!populated) content.append(el('p', { class: 'vital-meta' }, 'Details have not been added yet.'));
      card.append(content);
    }
    return card;
  }

  function renderQuestions(list, owner) {
    const items = goals.questions || [];
    list.replaceChildren();
    if (!items.length) list.append(el('p', { class: 'vital-meta goal-empty' }, list.dataset.empty));
    items.forEach((text, index) => {
      const row = el('div', { class: 'goal-row' }, el('span', { class: 'question-number' }, String(index + 1).padStart(2, '0')), el('span', { class: 'goal-text' }, text));
      if (owner) {
        const edit = el('button', { type: 'button', class: 'text-button' }, 'Edit');
        edit.addEventListener('click', () => {
          const input = el('input', { type: 'text', class: 'search-input', maxlength: 2000, value: text, 'aria-label': 'Edit question' });
          const form = el('form', { class: 'goal-form' }, input, el('button', { type: 'submit', class: 'primary-button compact' }, 'Save'));
          form.addEventListener('submit', event => {
            event.preventDefault(); const next = [...items]; next[index] = input.value.trim();
            save({ ...goals, questions: next.filter(Boolean) });
          });
          row.replaceChildren(form); input.focus();
        });
        const remove = el('button', { type: 'button', class: 'text-button' }, 'Remove');
        remove.addEventListener('click', () => { if (confirm(`Remove this question?\n\n${text}`)) save({ ...goals, questions: items.filter((_, at) => at !== index) }); });
        row.append(el('span', { class: 'goal-actions' }, edit, remove));
      }
      list.append(row);
    });
    if (owner) {
      const input = el('input', { type: 'text', class: 'search-input', maxlength: 2000, placeholder: 'Add a question', 'aria-label': 'Add a question' });
      const form = el('form', { class: 'goal-form' }, input, el('button', { type: 'submit', class: 'primary-button compact' }, 'Add question'));
      form.addEventListener('submit', event => { event.preventDefault(); const text = input.value.trim(); if (text) save({ ...goals, questions: [...items, text] }); });
      list.append(form);
    }
  }

  function render() {
    const owner = chart.mode === 'owner';
    for (const list of lists) {
      if (list.dataset.key === 'questions') { renderQuestions(list, owner); continue; }
      const items = normalize(goals.items);
      list.replaceChildren();
      if (!items.length) list.append(el('p', { class: 'vital-meta goal-empty' }, list.dataset.empty));
      const visibleItems = owner ? items : items.slice(0, 6);
      visibleItems.forEach((item, index) => list.append(renderPriority(item, index, items, owner)));
      if (!owner && items.length > 6) {
        const extra = el('details', { class: 'record-section goal-extra' }, el('summary', {}, el('span', { class: 'section-heading' }, 'Additional priorities'), el('span', { class: 'section-meta' }, String(items.length - 6))));
        items.slice(6).forEach((item, offset) => extra.append(renderPriority(item, offset + 6, items, false)));
        list.append(extra);
      }
      if (owner) {
        const add = el('button', { type: 'button', class: 'outline-button priority-add' }, '＋ Add a visit priority');
        add.disabled = dirtyCards.size > 0;
        add.addEventListener('click', () => save({ ...goals, items: [...items, { doing: '', goal: '', direction: '' }] }));
        list.append(add);
      }
    }
    if (navItem) {
      navItem.querySelector('em')?.remove();
      if (goals.items.length) navItem.append(' ', el('em', {}, String(Math.min(goals.items.length, 6))));
    }
  }

  document.addEventListener('chart:mode', render);
  document.addEventListener('chart:discardPreparation', () => { dirtyCards.clear(); render(); });
  render();
})();
