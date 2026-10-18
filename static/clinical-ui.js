// Shared clinical UI. All content is inserted as text; source PDFs stay account scoped.
(() => {
  const { el, fmtDate, parse } = window.chartKit;
  let documents = {};
  const day = t => t ? fmtDate(parse(t)) : 'Date unknown';
  const sourceButton = (doc, page, text = 'View source →') => {
    if (!doc) return el('span', { class: 'vital-meta' }, 'Source unavailable');
    const button = el('button', { type: 'button', class: 'source-link' }, text);
    button.addEventListener('click', () => chart.openDoc(doc, page));
    return button;
  };
  const accordion = (title, meta, content, open = false) => {
    const details = el('details', { class: 'record-section' },
      el('summary', {}, el('span', { class: 'section-heading' }, title), el('span', { class: 'section-meta' }, meta)),
      el('div', { class: 'section-content' }, content));
    details.open = open;
    return details;
  };
  const body = (id, ...kids) => {
    const section = document.getElementById(id);
    let holder = section.querySelector('.data-body');
    if (!holder) {
      holder = el('div', { class: 'data-body' });
      [...section.children].filter(c => !c.classList.contains('page-heading') && !c.classList.contains('filter-row') && !c.classList.contains('preparation-section') && c.tagName !== 'FORM').forEach(c => c.remove());
      section.append(holder);
    }
    holder.replaceChildren(...kids);
    return holder;
  };
  chart.clinicalUI = { el, day, sourceButton, accordion, body,
    chip: (text, tone = '') => el('span', { class: `chip ${tone}` }, text),
    docTitle: name => documents[name]?.title || name,
    setDocuments: rows => { documents = Object.fromEntries(rows.map(d => [d.document, d])); }
  };
})();
