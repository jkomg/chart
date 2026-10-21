(() => {
  const host = document.querySelector('.provider-settings-body');
  if (!host) return;
  const labels = {
    goals: 'Issues and visit priorities', timeline: 'Timeline', history: 'Medical history', medications: 'Medications', labs: 'Labs',
    vitals: 'Vitals', family: 'Family history', genetics: 'Genetics', documents: 'Medical records'
  };
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) if (value != null) key === 'class' ? node.className = value : node.setAttribute(key, value);
    kids.forEach(kid => kid && node.append(kid));
    return node;
  };
  async function load() {
    const response = await fetch('/api/provider-access', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Provider access settings could not be loaded.');
    const data = await response.json();
    host.replaceChildren();
    if (!data.providers.length) { host.append(el('p', {}, 'No provider accounts are configured yet.')); return; }
    for (const provider of data.providers) {
      const documentInputs = new Map();
      const sectionInputs = {};
      const status = el('p', { class: 'provider-settings-status', role: 'status' });
      const sectionGroup = el('fieldset', { class: 'provider-access-group' }, el('legend', {}, 'Sections available in presentation mode'));
      for (const section of data.sections) {
        const input = el('input', { type: 'checkbox', checked: provider.sections[section], 'aria-label': labels[section], 'data-provider-section': section });
        sectionInputs[section] = input;
        sectionGroup.append(el('label', { class: 'provider-access-choice' }, input, el('span', {}, labels[section])));
      }
      const documentGroup = el('fieldset', { class: 'provider-access-group' }, el('legend', {}, 'Individual medical records'));
      if (!data.documents.length) documentGroup.append(el('p', { class: 'vital-meta' }, 'No PDFs are uploaded to Mia’s account yet.'));
      for (const doc of data.documents) {
        const input = el('input', { type: 'checkbox', checked: provider.documents.includes(doc.filename), 'aria-label': doc.name });
        documentInputs.set(doc.filename, input);
        const note = 'Selecting this makes the PDF available in Provider view';
        documentGroup.append(el('label', { class: 'provider-access-choice' }, input,
          el('span', {}, el('b', {}, doc.name), el('small', {}, note))));
      }
      const save = el('button', { type: 'button', class: 'primary-button compact' }, 'Save provider access');
      save.addEventListener('click', async () => {
        save.disabled = true; status.textContent = 'Saving…';
        try {
          const result = await fetch(`/api/provider-access/${encodeURIComponent(provider.username)}`, {
            method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sections: Object.keys(sectionInputs).reduce((result, key) => {
                result[key] = sectionInputs[key].checked;
                return result;
              }, {}),
              documents: [...documentInputs].filter(([, input]) => input.checked).map(([filename]) => filename)
            })
          });
          const body = await result.json();
          if (!result.ok) throw new Error(body.error || 'Could not save provider access.');
          status.textContent = 'Saved. These permissions take effect the next time this provider loads the chart.';
        } catch (error) { status.textContent = error.message; }
        finally { save.disabled = false; }
      });
      const heading = el('div', { class: 'provider-access-heading' },
        el('div', {}, el('h2', {}, provider.display_name),
          el('p', { class: 'vital-meta' }, `Login: ${provider.username} · read-only presentation access to Mia’s chart`)));
      host.append(el('article', { class: 'provider-access-card' }, heading, sectionGroup, documentGroup,
        el('div', { class: 'provider-access-actions' }, save, status)));
    }
  }
  load().catch(error => { host.replaceChildren(el('p', { role: 'alert' }, error.message)); });
})();
