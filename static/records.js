// Sections built from extracted documents (/api/clinical): history, labs, records, medications,
// family history, genetics. Every item links back to the page it came from. Sections keep their
// starter content until this account has extracted data.
(() => {
  const { el, day, sourceButton, body, chip } = chart.clinicalUI;
  const KINDS = { lab: 'Lab results', genetic: 'Genetic test', visit: 'Visit', er: 'Emergency visit', imaging: 'Imaging',
                  monitor: 'Monitoring', sleep: 'Sleep study', other: 'Document' };
  let data = null, docsByName = {};
  const uploadedDocuments = [...document.querySelectorAll('#documents .document-card')].map(a => decodeURIComponent(a.getAttribute('href').slice(5)));

  // Long notes (e.g. 93 genes tested) fold away so the result stays readable.
  const longText = (text, limit = 220) => text.length <= limit ? el('p', { class: 'vital-meta' }, text)
    : el('details', { class: 'more' }, el('summary', {}, `${text.slice(0, limit).replace(/\s+\S*$/, '')}… Show details`), el('p', { class: 'vital-meta' }, text));
  const card = (title, ...kids) => el('article', { class: 'vital-card' }, title ? el('h2', { class: 'card-title' }, title) : null, ...kids);

  // ---------- family history ----------
  function renderFamily() {
    const list = el('div', { class: 'family-grid' });
    for (const row of data.family_history) {
      const card = el('article', { class: 'family-card' }, el('p', { class: 'eyebrow' }, row.relation), el('h2', {}, row.condition));
      if (row.document) card.append(sourceButton(row.document, row.page));
      chart.preparation.decorate(card, 'family_history', row);
      list.append(card);
    }
    body('family', chart.preparation.addButton('family_history'), data.family_history.length ? list : el('p', {}, 'No family history recorded.'));
  }

  // ---------- medications ----------
  function renderMedications() {
    const rows = chart.groupClinicalByName(data.medications).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const list = el('div', { class: 'medication-list' });
    for (const row of rows) {
      const copy = el('div', { class: 'med-copy' }, el('h2', {}, row.name), el('p', {}, [row.dose, row.schedule].filter(Boolean).join(' · ') || '—'),
        el('p', { class: 'vital-meta' }, `${row.context || 'recorded'} · ${day(row.date)}`));
      chart.preparation.decorate(copy, 'medications', row);
      const card = el('article', { class: 'medication-row' }, copy);
      if (row.document) card.append(sourceButton(row.document, row.page));
      list.append(card);
    }
    body('medications', chart.preparation.addButton('medications'), el('p', { class: 'vital-meta' }, 'Source records and patient updates are labeled below.'), rows.length ? list : el('p', {}, 'No medications recorded.'));
  }

  // ---------- medical records ----------
  function renderDocuments() {
    const section = document.getElementById('documents');
    const uploaded = uploadedDocuments;
    const known = new Set(data.documents.map(d => d.document));
    const list = el('div', { class: 'record-list' });
    let year = null;
    for (const d of data.documents) {
      const y = d.unextracted ? 'Uploaded, not yet extracted' : (d.date || '').slice(0, 4) || 'Undated';
      if (y !== year) { year = y; list.append(el('p', { class: 'eyebrow timeline-year' }, y || 'Undated')); }
      const row = el('a', { class: 'record-row', href: `#doc/${encodeURIComponent(d.document)}` },
        el('div', { class: 'pdf-icon' }, 'PDF'),
        el('div', { class: 'record-copy' },
          el('div', { class: 'record-title' }, el('b', {}, d.title || d.document), chip(KINDS[d.kind] || 'Document')),
          el('p', { class: 'vital-meta' }, [day(d.date), d.provider, d.clinician].filter(Boolean).join(' · ')),
          d.summary ? el('p', { class: 'record-summary' }, d.summary) : null),
        el('span', { class: 'record-arrow' }, '→'));
      const entry = el('article', { class: 'document-entry' }, row);
      chart.preparation.decorate(entry, 'documents', d);
      list.append(entry);
    }
    const deletedDocuments = new Set((data.deleted_entries?.documents || []).map(d => d.document));
    const extra = uploaded.filter(n => !known.has(n) && !deletedDocuments.has(n));
    if (extra.length) {
      list.append(el('p', { class: 'eyebrow timeline-year' }, 'Uploaded, not yet extracted'));
      extra.forEach(n => list.append(el('a', { class: 'record-row', href: `#doc/${encodeURIComponent(n)}` },
        el('div', { class: 'pdf-icon' }, 'PDF'), el('div', { class: 'record-copy' }, el('b', {}, n)), el('span', { class: 'record-arrow' }, '→'))));
    }
    const search = el('input', { type: 'search', class: 'search-input', placeholder: 'Search documents', 'aria-label': 'Search documents' });
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      list.querySelectorAll('.record-row').forEach(r => { r.hidden = q && !r.textContent.toLowerCase().includes(q); });
    });
    const upload = section.querySelector('.upload-banner');
    body('documents', el('div', { class: 'filter-row plain' }, search), list, upload || '');
    const count = document.querySelector('.nav-item[data-tab="documents"] em');
    if (count) count.textContent = data.documents.length + extra.length;
  }

  // ---------- genetics ----------
  async function renderGenetics() {
    const section = document.getElementById('genetics');
    if (!section) return;
    const consumer = await fetch('/api/genetics', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({ findings: [], sources: [] }));
    data.deleted_entries ||= {};
    data.deleted_entries.genetic_findings = consumer.deleted_entries || [];
    chart.preparation.renderDeleted(data);
    const clinicalRows = data.clinical_genetics;
    const kids = [];
    const tone = c => /^pathogenic|likely pathogenic/i.test(c || '') ? 'bad' : /uncertain|vus/i.test(c || '') ? 'warn' : /negative|benign/i.test(c || '') ? 'good' : '';

    if (clinicalRows.length) {
      const byDoc = new Map();
      clinicalRows.forEach(f => byDoc.set(f.document, [...(byDoc.get(f.document) || []), f]));
      for (const [doc, findings] of byDoc) {
        const meta = docsByName[doc] || {};
        const rows = findings.map(f => {
          const row = el('div', { class: 'gene-row' },
            el('div', { class: 'gene-main' }, el('b', {}, f.gene || f.test || 'Result'),
              el('span', { class: 'mono' }, [f.variant, f.protein].filter(Boolean).join(' ') || ''),
              f.condition ? el('p', { class: 'vital-meta' }, [f.condition, f.inheritance].filter(Boolean).join(' · ')) : null,
              f.note ? longText(f.note) : null),
            el('div', { class: 'gene-side' }, chip(f.classification || 'Reported', tone(f.classification)),
              f.zygosity ? el('span', { class: 'vital-meta' }, f.zygosity) : null, sourceButton(f.document, f.page, 'Source →')));
          chart.preparation.decorate(row, 'clinical_genetics', f);
          return row;
        });
        kids.push(el('article', { class: 'vital-card' },
          el('div', { class: 'vital-head' }, el('div', {}, el('h2', { class: 'card-title' }, meta.title || findings[0].test || doc),
            el('p', { class: 'vital-meta' }, [day(meta.date), meta.provider, 'Clinical test'].filter(Boolean).join(' · ')))),
          meta.summary ? longText(meta.summary, 420) : null, ...rows));
      }
    }

    if (consumer.findings.length) {
      kids.push(el('div', { class: 'caveat' }, el('b', {}, 'Consumer DNA data is not a clinical test. '),
        'Results below come from a consumer genotyping chip. These chips are reliable for common variants but often wrong for rare ones: in one study, about 40% of rare variants found in raw consumer data were false positives on clinical confirmation. Confirm anything here with clinical testing before acting on it.'));
      const groups = [['clinvar', 'Rare variants ClinVar lists as pathogenic (unconfirmed)'], ['panel', 'Common variants'], ['pgx', 'Medication-related genes']];
      for (const [cat, title] of groups) {
        const rows = consumer.findings.filter(f => f.category === cat);
        if (!rows.length) continue;
        const tbody = el('tbody');
        rows.forEach(f => tbody.append(el('tr', { class: f.detected ? 'detected' : '' },
          (() => { const cell = el('td', {}, el('b', {}, f.label), f.condition ? el('div', { class: 'vital-meta' }, f.condition) : null, f.note ? el('div', { class: 'vital-meta' }, f.note) : null); chart.preparation.decorate(cell, 'genetic_findings', f); return cell; })(),
          el('td', {}, f.result, f.classification ? el('div', { class: 'vital-meta' }, `${f.classification}${f.review_stars ? ` · ${'★'.repeat(f.review_stars)}` : ''}`) : null),
          el('td', { class: 'mono' }, `${f.rsid.replace(/,/g, ', ')}\n${f.genotype || '--'}`))));
        kids.push(card(title, el('div', { class: 'reading-table tall' }, el('table', {}, el('thead', {}, el('tr', {},
          el('th', {}, 'Variant'), el('th', {}, 'Result'), el('th', {}, 'Marker · genotype'))), tbody))));
      }
      const src = consumer.sources[0];
      if (src) kids.push(el('p', { class: 'vital-sources' }, `Source: ${src.provider} raw data (${src.markers?.toLocaleString()} markers, ${src.build}), matched against ClinVar downloaded ${src.clinvar_release}.`));
    }
    if (kids.length) body('genetics', ...kids);
  }

  async function load() {
    try {
      const res = await fetch('/api/clinical', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch {
      for (const id of ['history', 'labs', 'family', 'medications']) body(id, el('p', { role: 'alert' }, 'Records could not be loaded. Reload the page to try again.'));
      return false;
    }
    docsByName = Object.fromEntries(data.documents.map(d => [d.document, d]));
    chart.clinicalUI.setDocuments(data.documents);
    chart.renderHistory(data); renderFamily(); renderMedications(); renderDocuments(); chart.renderLabs(data); renderGenetics();
    chart.preparation.renderDeleted(data);
    return true;
  }
  chart.reloadClinical = load;
  load();
})();
