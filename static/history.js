// Keep documented status and every source; an old mention is not confirmation of current status.
(() => {
  const { el, day, sourceButton, accordion, body } = chart.clinicalUI;
  chart.renderHistory = data => {
    const { events, diagnoses, allergies } = data;
    const search = el('input', { type: 'search', class: 'search-input', placeholder: 'Search conditions, procedures, or visits', 'aria-label': 'Search medical history' });
    const results = el('div', { class: 'history-sections' });
    const status = el('p', { class: 'search-status', role: 'status' });
    const openSections = new Set(['Allergies', 'Active conditions', 'Conditions · status unconfirmed']);
    const matches = row => Object.values(row).filter(v => typeof v === 'string').join(' ').toLowerCase().includes(search.value.trim().toLowerCase());
    const groupConditions = rows => {
      const grouped = new Map();
      for (const row of [...rows].sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
        const key = row.name.toLowerCase();
        const existing = grouped.get(key);
        grouped.set(key, { ...row, sources: [...(existing?.sources || []), row] });
      }
      return [...grouped.values()];
    };
    const allConditions = groupConditions(diagnoses);
    const buckets = [
      ['Allergies', allergies, 'allergy'],
      ['Active conditions', allConditions.filter(d => /^active$/i.test(d.status || '')), 'condition'],
      ['Suspected conditions', allConditions.filter(d => /^suspected$/i.test(d.status || '')), 'condition'],
      ['Conditions · status unconfirmed', allConditions.filter(d => !/^(active|suspected|history|resolved)$/i.test(d.status || '')), 'condition'],
      ['Historical or resolved conditions', allConditions.filter(d => /^(history|resolved)$/i.test(d.status || '')), 'condition'],
      ['Procedures & surgeries', events.filter(e => /surg|procedure|operation/i.test(e.type || '')), 'event']
    ];
    const visits = events.filter(e => !/surg|procedure|operation/i.test(e.type || ''));
    for (const year of [...new Set(visits.map(e => (e.date || '').slice(0, 4)))].sort().reverse()) {
      buckets.push([`Visits & events · ${year || 'Undated'}`, visits.filter(e => (e.date || '').slice(0, 4) === year), 'event']);
    }
    function draw() {
      const query = search.value.trim();
      let count = 0;
      results.replaceChildren();
      for (const [title, rows, type] of buckets) {
        const shown = rows.filter(row => matches(row) || row.sources?.some(matches));
        if (!shown.length) continue;
        count += shown.length;
        const list = el('div', { class: 'history-list' });
        for (const row of shown) {
          const entry = el('article', { class: 'history-entry' },
            el('h3', {}, row.name || row.substance || row.title),
            el('p', { class: 'vital-meta' }, type === 'allergy' ? row.reaction || 'Reaction not recorded' :
              [day(row.date), row.status || (type === 'condition' ? 'Status unconfirmed' : row.type)].filter(Boolean).join(' · ')));
          if (row.detail || row.note) entry.append(el('p', { class: 'history-note' }, row.detail || row.note));
          if (row.sources) {
            const sources = el('details', { class: 'condition-sources' }, el('summary', {}, `${row.sources.length} source record${row.sources.length === 1 ? '' : 's'}`));
            for (const src of [...row.sources].reverse()) sources.append(el('div', {}, sourceButton(src.document, src.page, `${day(src.date)} · ${src.status || 'Status unconfirmed'} · source →`)));
            entry.append(sources);
          } else entry.append(sourceButton(row.document, row.page));
          list.append(entry);
        }
        const section = accordion(title, `${shown.length} ${shown.length === 1 ? 'entry' : 'entries'}`, list, Boolean(query) || openSections.has(title));
        section.addEventListener('toggle', () => { if (!search.value.trim()) section.open ? openSections.add(title) : openSections.delete(title); });
        results.append(section);
      }
      status.textContent = query ? `${count} matching ${count === 1 ? 'entry' : 'entries'}` : '';
      if (!count) results.append(el('p', {}, query ? 'No history matches your search.' : 'No medical history recorded.'));
    }
    search.addEventListener('input', draw);
    body('history', el('div', { class: 'filter-row plain' }, search),
      el('p', { class: 'vital-meta' }, 'Status reflects the latest source mention and may need confirmation.'), status, results);
    draw();
  };
})();
