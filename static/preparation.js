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
    documents: { summary: 'Summary shown on the Medical records page' },
    lab_results: {},
    measurements: { metric: 'Measurement', taken_at: 'Date', value: 'Value' },
    cycles: { start: 'Period started', end: 'Period ended' }
  };
  const titles = { diagnoses: 'condition', allergies: 'allergy', events: 'event or procedure', medications: 'medication', family_history: 'family history', lab_results: 'lab note', clinical_genetics: 'genetic finding', genetic_findings: 'consumer genetic finding', documents: 'medical record', measurements: 'vital reading', cycles: 'period dates' };
  let modalDirty = false;
  const dirtySections = new Set();
  let deletedState = {};
  chart.hasUnsavedPreparation = () => modalDirty || dirtySections.size > 0;
  async function write(url, method, data) {
    const response = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    if (response.status === 401) { location.href = '/login'; throw new Error('Please sign in again.'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save. Try again.');
    return result;
  }

  const familySlug = relation => relation.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  chart.preparation = chart.preparation || {};
  chart.preparation.familyMemberDetails = relation => {
    const key = 'family_member:' + familySlug(relation);
    const current = saved[key] || { dob: '', deceased: false, date_of_death: '' };
    const facts = el('div', { class: 'family-member-facts' });
    const summary = el('p', { class: 'family-member-facts-summary' });
    const form = el('form', { class: 'family-member-facts-form owner-only' });
    const dob = el('input', { type: 'date', 'aria-label': `${relation} date of birth` });
    const deceased = el('input', { type: 'checkbox', 'aria-label': `${relation} deceased` });
    const deathDate = el('input', { type: 'date', 'aria-label': `${relation} date of death` });
    const status = el('span', { class: 'family-member-save-status', role: 'status' });
    const save = el('button', { type: 'submit', class: 'outline-button compact' }, 'Save');
    function render() {
      dob.value = current.dob || ''; deceased.checked = Boolean(current.deceased); deathDate.value = current.date_of_death || '';
      deathDate.hidden = !deceased.checked;
      const entries = [];
      if (current.dob) entries.push(`Born ${current.dob}`);
      entries.push(current.deceased ? `Deceased${current.date_of_death ? ` ${current.date_of_death}` : ''}` : 'Living status not specified');
      summary.textContent = entries.join(' · ');
      summary.hidden = !current.dob && !current.deceased;
    }
    deceased.addEventListener('change', () => { deathDate.hidden = !deceased.checked; });
    form.append(el('label', {}, 'DOB', dob), el('label', { class: 'family-deceased-field' }, deceased, 'Deceased'),
      el('label', { class: 'family-death-date' }, 'Date of death', deathDate), save, status);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (chart.mode !== 'owner') return;
      save.disabled = dob.disabled = deceased.disabled = deathDate.disabled = true; status.textContent = 'Saving…';
      try {
        const result = await write('/api/preparation/family-members', 'PUT', {
          relation, fields: { dob: dob.value, deceased: deceased.checked, date_of_death: deathDate.value }
        });
        Object.assign(current, result); saved[key] = current; render(); status.textContent = 'Saved';
      } catch (error) { status.textContent = error.message; }
      finally { save.disabled = dob.disabled = deceased.disabled = deathDate.disabled = false; }
    });
    render(); facts.append(summary, form); return facts;
  };

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
      el('p', { class: 'vital-meta' }, 'Saved summaries and notes appear in Provider view.'),
      el('div', { class: 'editor-actions' }, save, cancel), message);
    function render() {
      summary.value = value.summary; notes.value = value.notes;
      display.replaceChildren();
      if (value.summary || value.notes) {
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
  const recordKeys = row => row.sources?.length ? row.sources.map(source => source._key) : [row._key];
  async function refreshRecords(message = 'Note saved.', table = '') {
    modalDirty = false;
    dialog.close();
    const refreshed = ['measurements', 'cycles'].includes(table) ? await chart.reloadVitals() : await chart.reloadClinical();
    chart.toast(refreshed ? message : 'Saved. Reload to refresh your records.');
  }
  function editRecord(table, row, defaults = {}) {
    if (chart.mode !== 'owner') return;
    dialog.replaceChildren();
    const form = el('form', { class: 'preparation-form' });
    const inputs = {};
    const title = table === 'family_history' && defaults.newFamilyMember
      ? 'Add family member'
      : table === 'family_history' && defaults.relation
      ? `${row ? 'Edit' : 'Add'} family history for ${defaults.relation}`
      : table === 'documents'
      ? 'Edit medical record summary'
      : `${row ? 'Edit' : 'Add'} ${titles[table]}`;
    form.append(el('h2', { id: 'record-editor-title' }, title),
      el('p', { class: 'vital-meta' }, table === 'documents'
        ? 'This changes the summary shown in your chart. The source PDF stays unchanged.'
        : row?.document ? 'Your edits appear as a note alongside the record.' : 'You can edit or remove this entry later.'));
    for (const [field, label] of Object.entries(labels[table])) {
      let input;
      if (field === 'status') {
        input = el('select', {});
        for (const [value, text] of [['', 'Unconfirmed'], ['active', 'Active'], ['suspected', 'Suspected'], ['history', 'Historical'], ['resolved', 'Resolved']]) input.append(el('option', { value }, text));
        const current = row?.[field] || '';
        if (current && !['active', 'suspected', 'history', 'resolved'].includes(current.toLowerCase())) input.append(el('option', { value: current }, current));
        input.value = ['active', 'suspected', 'history', 'resolved'].includes(current.toLowerCase()) ? current.toLowerCase() : current;
      } else {
        input = ['note', 'detail', 'summary'].includes(field) ? el('textarea', { rows: 3, maxlength: 2000 }) : el('input', { type: field === 'date' ? 'date' : 'text', maxlength: 2000 });
        input.value = row?.[field] ?? defaults[field] ?? '';
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
    if (row && table !== 'documents') {
      const remove = el('button', { type: 'button', class: 'danger-button' }, table === 'lab_results' ? 'Delete result' : 'Delete entry');
      remove.addEventListener('click', async () => {
        if (chart.mode !== 'owner') return;
        if (!confirm('Delete this entry from the chart? You can restore it under Deleted entries in Prepare. Source PDFs are kept.')) return;
        const controls = [...form.querySelectorAll('button, input, textarea, select')];
        controls.forEach(control => { control.disabled = true; });
        try {
          await write('/api/preparation/entries/' + table, 'PATCH', { keys: recordKeys(row), deleted: true });
          await refreshRecords('Entry deleted.', table);
        } catch (failure) { error.textContent = failure.message; controls.forEach(control => { control.disabled = false; }); }
      });
      actions.append(remove);
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
      try { await write(url, row ? 'PUT' : 'POST', { fields, notes: notes.value }); await refreshRecords('Note saved.', table); }
      catch (failure) { error.textContent = failure.message; controls.forEach(control => { control.disabled = false; }); }
    });
    dialog.append(form); modalDirty = false; dialog.showModal();
  }
  const addButton = (table, label, defaults = {}) => {
    const button = el('button', { type: 'button', class: 'outline-button compact owner-only' }, label || `Add ${titles[table]}`);
    button.addEventListener('click', () => editRecord(table, null, defaults));
    return button;
  };
  const isSourceIncluded = filename => Boolean(saved[`source:${filename}`]?.included);
  const canViewSource = filename => chart.mode !== 'provider' || isSourceIncluded(filename);
  const setSourceIncluded = async (filename, included) => {
    if (chart.mode !== 'owner') throw new Error('Switch to Prepare to choose source documents.');
    const update = await write('/api/preparation/sources', 'PUT', { document: filename, included });
    saved[`source:${filename}`] = { included: update.included };
    document.dispatchEvent(new CustomEvent('chart:sourceSelection', { detail: { document: filename, included } }));
    return update;
  };
  const moveFamilyRow = async (row, relation) => {
    if (chart.mode !== 'owner') throw new Error('Switch to Prepare to edit family history.');
    const fields = { relation };
    if (row._manual) fields.condition = row.condition || '';
    else if (row._original && (row.condition ?? '') !== (row._original.condition ?? '')) fields.condition = row.condition ?? '';
    await write(`/api/preparation/entries/family_history/${encodeURIComponent(row._key)}`, 'PUT', { fields, notes: row._patient_note || '' });
    await refreshRecords(`Condition moved to ${relation}.`);
  };
  const decorate = (container, table, row) => {
    if (table === 'family_history') {
      if (row._patient_updated || row._patient_note) {
        const note = el('p', { class: 'family-patient-update' }, el('span', { class: 'family-note-label' }, 'Note'),
          row._patient_note || 'Edited condition details are shown above.');
        container.append(note);
      }
      const edit = el('button', { type: 'button', class: 'text-button owner-only edit-record' }, 'Edit / add notes');
      edit.addEventListener('click', () => editRecord(table, row));
      container.append(edit);
      return container;
    }
    if (row._patient_updated || row._patient_note) {
      container.append(el('p', { class: 'patient-label' }, 'Note'));
      if (row._patient_note) container.append(el('p', { class: 'patient-text' }, row._patient_note));
    }
    const edit = el('button', { type: 'button', class: 'text-button owner-only edit-record' }, table === 'lab_results' ? 'Edit notes' : table === 'documents' ? 'Edit summary' : 'Edit / add notes');
    edit.addEventListener('click', () => editRecord(table, row));
    container.append(edit);
    return container;
  };
  const deleteRow = async (table, row, after = refreshRecords) => {
    if (chart.mode !== 'owner' || !confirm('Remove this item from the report? You can restore it under Deleted entries in Prepare. Source files are kept.')) return;
    try {
      await write('/api/preparation/entries/' + table, 'PATCH', { keys: recordKeys(row), deleted: true });
      await after();
      chart.toast('Item removed from the report.');
    } catch (failure) { chart.toast(failure.message); }
  };
  window.addEventListener('beforeunload', event => { if (chart.hasUnsavedPreparation()) { event.preventDefault(); event.returnValue = ''; } });
  const renderDeleted = data => {
    deletedState = { ...deletedState, ...(data.deleted_entries || {}) };
    const sections = { diagnoses: 'history', allergies: 'history', events: 'history', medications: 'medications', family_history: 'family', lab_results: 'labs', documents: 'documents', clinical_genetics: 'genetics', genetic_findings: 'genetics', measurements: 'vitals', cycles: 'vitals' };
    const panels = new Map();
    for (const id of new Set(Object.values(sections))) {
      const previous = document.querySelector(`#${id} .deleted-entries`);
      panels.set(id, { open: previous?.open || false, rows: [] });
      previous?.remove();
    }
    for (const [table, rows] of Object.entries(deletedState)) {
      if (!sections[table]) continue;
      const entries = ['diagnoses', 'medications'].includes(table) ? chart.groupClinicalByName(rows) : rows;
      for (const row of entries) panels.get(sections[table]).rows.push({ table, row });
    }
    for (const [id, { open, rows }] of panels) {
      if (!rows.length) continue;
      const list = el('div', { class: 'deleted-list' });
      const panel = el('details', { class: 'deleted-entries owner-only' }, el('summary', {}, `Deleted entries (${rows.length})`), list);
      panel.open = open;
      for (const { table, row } of rows) {
        const restore = el('button', { type: 'button', class: 'outline-button compact' }, 'Restore entry');
        const error = el('p', { class: 'save-status', role: 'alert' });
        const title = row.name || row.substance || row.title || row.test || row.label || (row.metric ? `${row.metric} · ${row.taken_at}` : '') || (row.start ? `Menstrual cycle · ${row.start}` : '') || row.document || [row.relation, row.condition].filter(Boolean).join(' · ');
        const dates = [row.date || row.taken_at, recordKeys(row).length > 1 ? `${recordKeys(row).length} records` : null].filter(Boolean).join(' · ');
        const entry = el('article', { class: 'deleted-entry' }, el('div', {}, el('b', {}, title), el('p', { class: 'vital-meta' }, dates)), restore, error);
        restore.addEventListener('click', async () => {
          if (chart.mode !== 'owner') return;
          restore.disabled = true;
          try {
            await write('/api/preparation/entries/' + table, 'PATCH', { keys: recordKeys(row), deleted: false });
            const refreshed = ['measurements', 'cycles'].includes(table)
              ? await chart.reloadVitals()
              : await chart.reloadClinical();
            chart.toast(refreshed ? 'Entry restored.' : 'Restored. Reload to refresh your records.');
          } catch (failure) { error.textContent = failure.message; restore.disabled = false; }
        });
        list.append(entry);
      }
      document.getElementById(id).append(panel);
    }
  };
  chart.preparation = { editRecord, decorate, addButton, renderDeleted, deleteRow, moveFamilyRow, isSourceIncluded, canViewSource, setSourceIncluded, familyMemberDetails: chart.preparation.familyMemberDetails };
  document.addEventListener('chart:mode', () => { if (chart.mode === 'provider') { dialog.close(); modalDirty = false; } });
})();
