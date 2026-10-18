// Goals: two plain lists (goals, questions for the next visit) the account can add to, edit,
// and remove from. Every change saves the whole set to /api/goals.
(() => {
  const section = document.getElementById('goals');
  if (!section) return;
  let goals = JSON.parse(document.getElementById('goals-data').textContent);
  const lists = [...section.querySelectorAll('.goal-list')];
  const navItem = document.querySelector('.nav-item[data-tab="goals"]');

  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) k === 'class' ? node.className = v : node.setAttribute(k, v);
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  };

  async function save(next) {
    try {
      const res = await fetch('/api/goals', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      if (res.status === 401) { location.href = '/login'; return false; }
      if (!res.ok) throw new Error(res.status);
      goals = await res.json();
      render();
      return true;
    } catch {
      chart.toast('Couldn’t save. Check the connection and try again.');
      return false;
    }
  }
  const change = (key, fn) => save({ ...goals, [key]: fn([...goals[key]]) });

  function editor(value, onSave, onCancel, label) {
    const input = el('input', { type: 'text', class: 'search-input', value, 'aria-label': label, maxlength: 2000 });
    const form = el('form', { class: 'goal-form' }, input, el('button', { type: 'submit', class: 'primary-button compact' }, onCancel ? 'Save' : 'Add'));
    if (onCancel) {
      const cancel = el('button', { type: 'button', class: 'outline-button compact' }, 'Cancel');
      cancel.addEventListener('click', onCancel);
      form.append(cancel);
    }
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return onCancel?.();
      input.disabled = true;
      if (!(await onSave(text))) input.disabled = false;
    });
    input.addEventListener('keydown', e => { if (e.key === 'Escape' && onCancel) onCancel(); });
    return { form, input };
  }

  function render() {
    for (const list of lists) {
      const { key, label, empty } = list.dataset;
      const items = goals[key] || [];
      list.replaceChildren();
      if (!items.length) list.append(el('p', { class: 'vital-meta goal-empty' }, empty));
      items.forEach((text, i) => {
        const row = el('div', { class: 'goal-row' }, el('span', { class: 'question-number' }, String(i + 1).padStart(2, '0')), el('span', { class: 'goal-text' }, text));
        const edit = el('button', { type: 'button', class: 'text-button' }, 'Edit');
        const remove = el('button', { type: 'button', class: 'text-button' }, 'Remove');
        edit.addEventListener('click', () => {
          const { form, input } = editor(text, t => change(key, xs => { xs[i] = t; return xs; }), render, `Edit ${label}`);
          row.replaceWith(el('div', { class: 'goal-row' }, form));
          input.focus();
        });
        remove.addEventListener('click', () => { if (confirm(`Remove this ${label}?\n\n${text}`)) change(key, xs => { xs.splice(i, 1); return xs; }); });
        row.append(el('span', { class: 'goal-actions' }, edit, remove));
        list.append(row);
      });
      const { form, input } = editor('', t => change(key, xs => [...xs, t]), null, `Add a ${label}`);
      input.placeholder = `Add a ${label}`;
      list.append(form);
    }
    if (navItem) {
      navItem.querySelector('em')?.remove();
      if (goals.items.length) navItem.append(' ', el('em', {}, String(goals.items.length)));
    }
  }

  render();
})();
