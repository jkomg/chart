// Patient-authored summaries, notes, and record updates. Imported source rows are never changed.
(() => {
  const { el } = chart.clinicalUI;
  const saved = JSON.parse(document.getElementById('preparation-data').textContent);
  const labels = {
    diagnoses: { name: 'Condition', status: 'Status', date: 'Date', note: 'Details' },
    allergies: { substance: 'Allergen', reaction: 'Reaction' },
    events: { title: 'Event or procedure', type: 'Type', date: 'Date', detail: 'Details' },
    medications: { name: 'Medication', dose: 'Dose', schedule: 'Schedule', context: 'Status / context', date: 'Date confirmed' },
    family_history: { relation: 'Relation', condition: 'Condition' },
    lab_results: {}
  };
  const titles = { diagnoses: 'condition', allergies: 'allergy', events: 'event or procedure', medications: 'medication', family_history: 'family history', lab_results: 'lab note' };
  let modalDirty = false;
  const dirtySections = new Set();
  chart.hasUnsavedPreparation = () => modalDirty || dirtySections.size > 0;
  async function write(url, method, data) {
    const response = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    if (response.status === 401) { location.href = '/login'; throw new Error('Please sign in again.'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save. Try again.');
    return result;
  }

  for (const section of document.querySelectorAll('.tab-panel')) {
    const key = 'section:' + section.id;
    let value = saved[key] || { summary: '', notes: '' };
    const host = el('article', { class: 'preparation-section' });
    const display = el('div', { class: 'patient-summary' });
    const form = el('form', { class: 'owner-only preparation-form' });
    const summary = el('textarea', { rows: 3, maxlength: 10000, 'aria-label': 'Section summary' });
    const notes = el('textarea', { rows: 4, maxlength: 10000, 'aria-label': 'Section notes' });
    const message = el('p', { class: 'save-status', role: 'status' });
    const save = el('button', { type: 'submit', class: 'primary-button compact' }, 'Save summary & notes');
    const cancel = el('button', { type: 'button', class: 'outline-button compact' }, 'Cancel');
    const editor = el('details', { class: 'owner-only section-editor' }, el('summary', {}, 'Edit summary & notes'), form);
    form.append(el('label', {}, 'Summary for the provider', summary), el('label', {}, 'Notes', notes),
      el('p', { class: 'vital-meta' }, 'Saved summaries and notes appear in Provider view as patient-provided information.'),
      el('div', { class: 'editor-actions' }, save, cancel), message);
    function render() {
      summary.value = value.summary; notes.value = value.notes;
      display.replaceChildren();
      if (value.summary || value.notes) {
        display.append(el('p', { class: 'patient-label' }, 'Patient-provided'));
        if (value.summary) display.append(el('h2', {}, 'Summary'), el('p', { class: 'patient-text' }, value.summary));
        if (value.notes) display.append(el('details', { class: 'patient-notes' }, el('summary', {}, 'Notes'), el('p', { class: 'patient-text' }, value.notes)));
      }
      display.hidden = !value.summary && !value.notes;
      host.classList.toggle('has-content', Boolean(value.summary || value.notes));
      dirtySections.delete(section.id);
    }
    form.addEventListener('input', () => {
      const dirty = summary.value !== value.summary || notes.value !== value.notes;
      dirty ? dirtySections.add(section.id) : dirtySections.delete(section.id);
      message.textContent = dirty ? 'Unsaved changes' : '';
    });
    cancel.addEventListener('click', () => { render(); editor.open = false; message.textContent = ''; });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (chart.mode !== 'owner') return;
      save.disabled = cancel.disabled = summary.disabled = notes.disabled = true;
      message.textContent = 'Saving…';
      try {
        value = await write(`/api/preparation/sections/${section.id}`, 'PUT', { summary: summary.value, notes: notes.value });
        render(); editor.open = false; chart.toast('Summary and notes saved.');
      } catch (error) { message.textContent = error.message; }
      finally { save.disabled = cancel.disabled = summary.disabled = notes.disabled = false; }
    });
    document.addEventListener('chart:discardPreparation', () => { render(); editor.open = false; message.textContent = ''; });
    host.append(display, editor);
    section.querySelector('.page-heading').after(host);
    render();
  }

  const dialog = el('dialog', { class: 'record-editor', 'aria-labelledby': 'record-editor-title' });
  document.body.append(dialog);
  dialog.addEventListener('cancel', event => {
    if (modalDirty && !confirm('Discard unsaved record changes?')) event.preventDefault();
    else modalDirty = false;
  });
  async function refreshRecords() {
    modalDirty = false;
    dialog.close();
    const refreshed = await chart.reloadClinical();
    chart.toast(refreshed ? 'Patient update saved.' : 'Saved. Reload to refresh your records.');
  }
  function editRecord(table, row) {
    if (chart.mode !== 'owner') return;
    dialog.replaceChildren();
    const form = el('form', { class: 'preparation-form' });
    const inputs = {};
    form.append(el('h2', { id: 'record-editor-title' }, `${row ? 'Edit' : 'Add'} ${titles[table]}`),
      el('p', { class: 'vital-meta' }, row?.document ? 'Your update is shown separately from the original source record.' : 'This will be labeled as patient-entered information.'));
    for (const [field, label] of Object.entries(labels[table])) {
      let input;
      if (field === 'status') {
        input = el('select', {});
        for (const [value, text] of [['', 'Unconfirmed'], ['active', 'Active'], ['suspected', 'Suspected'], ['history', 'Historical'], ['resolved', 'Resolved']]) input.append(el('option', { value }, text));
        const current = row?.[field] || '';
        if (current && !['active', 'suspected', 'history', 'resolved'].includes(current.toLowerCase())) input.append(el('option', { value: current }, current));
        input.value = ['active', 'suspected', 'history', 'resolved'].includes(current.toLowerCase()) ? current.toLowerCase() : current;
      } else {
        input = ['note', 'detail'].includes(field) ? el('textarea', { rows: 3, maxlength: 2000 }) : el('input', { type: field === 'date' ? 'date' : 'text', maxlength: 2000 });
        input.value = row?.[field] || '';
      }
      inputs[field] = input;
      form.append(el('label', {}, label, input));
    }
    const notes = el('textarea', { rows: 4, maxlength: 10000 });
    notes.value = row?._patient_note || '';
    form.append(el('label', {}, 'Notes for the provider', notes));
    const error = el('p', { role: 'alert', class: 'save-status' });
    const save = el('button', { type: 'submit', class: 'primary-button compact' }, 'Save');
    const cancel = el('button', { type: 'button', class: 'outline-button compact' }, 'Cancel');
    cancel.addEventListener('click', () => {
      if (!modalDirty || confirm('Discard unsaved record changes?')) { modalDirty = false; dialog.close(); }
    });
    const actions = el('div', { class: 'editor-actions' }, save, cancel);
    const url = '/api/preparation/entries/' + table + (row ? '/' + encodeURIComponent(row._key) : '');
    if (row && (row._manual || row._original)) {
      const reset = el('button', { type: 'button', class: 'text-button' }, row._manual ? 'Remove patient entry' : 'Restore original record');
      reset.addEventListener('click', async () => {
        if (!confirm(row._manual ? 'Remove this patient-entered record?' : 'Remove your update and notes, and show the original record?')) return;
        save.disabled = reset.disabled = true;
        try { await write(url, 'DELETE'); await refreshRecords(); }
        catch (failure) { error.textContent = failure.message; save.disabled = reset.disabled = false; }
      });
      actions.append(reset);
    }
    form.append(actions, error);
    form.addEventListener('input', () => { modalDirty = true; });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (chart.mode !== 'owner') return;
      const fields = {};
      for (const [field, input] of Object.entries(inputs)) {
        // Save only changed imported fields, keeping notes-only updates distinct.
        const original = row?._original ? (row._original[field] ?? '') : (row?.[field] ?? '');
        if (!row || row._manual || input.value !== original) fields[field] = input.value;
      }
      const controls = [...form.querySelectorAll('button, input, textarea, select')];
      controls.forEach(control => { control.disabled = true; });
      try { await write(url, row ? 'PUT' : 'POST', { fields, notes: notes.value }); await refreshRecords(); }
      catch (failure) { error.textContent = failure.message; controls.forEach(control => { control.disabled = false; }); }
    });
    dialog.append(form); modalDirty = false; dialog.showModal();
  }
  const addButton = (table, label) => {
    const button = el('button', { type: 'button', class: 'outline-button compact owner-only' }, label || `Add ${titles[table]}`);
    button.addEventListener('click', () => editRecord(table));
    return button;
  };
  const decorate = (container, table, row) => {
    if (row._manual || row._patient_updated || row._patient_note) {
      container.append(el('p', { class: 'patient-label' }, row._manual ? 'Patient-entered' : row._patient_updated ? 'Patient update' : 'Patient note'));
      if (row._patient_note) container.append(el('p', { class: 'patient-text' }, row._patient_note));
      if (row._patient_updated) {
        const original = el('details', { class: 'original-record' }, el('summary', {}, 'Original recorded details'));
        for (const [field, label] of Object.entries(labels[table])) {
          if (row._original?.[field]) original.append(el('p', {}, el('b', {}, `${label}: `), row._original[field]));
        }
        container.append(original);
      }
    }
    const edit = el('button', { type: 'button', class: 'text-button owner-only edit-record' }, table === 'lab_results' ? 'Edit notes' : 'Edit / add notes');
    edit.addEventListener('click', () => editRecord(table, row));
    container.append(edit);
    return container;
  };
  window.addEventListener('beforeunload', event => { if (chart.hasUnsavedPreparation()) { event.preventDefault(); event.returnValue = ''; } });
  chart.preparation = { decorate, addButton };
  document.addEventListener('chart:mode', () => { if (chart.mode === 'provider') { dialog.close(); modalDirty = false; } });
})();
