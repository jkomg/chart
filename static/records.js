// Sections built from extracted documents (/api/clinical): history, labs, records, medications,
// family history, genetics. Every item links back to the page it came from. Sections keep their
// starter content until this account has extracted data.
(() => {
  const { el, day, sourceButton, canViewSource, body, chip } = chart.clinicalUI;
  const KINDS = { lab: 'Lab results', genetic: 'Genetic report', visit: 'Visit', er: 'Emergency visit', imaging: 'Imaging',
                  monitor: 'Monitoring', sleep: 'Sleep study', other: 'Document' };
  let data = null, docsByName = {};
  const uploadedDocuments = [...document.querySelectorAll('#documents .document-card')].map(a => decodeURIComponent(a.getAttribute('href').slice(5)));
  function syncProviderDocuments() {
    const entries = [...document.querySelectorAll('#documents [data-provider-document]')];
    entries.forEach(entry => { entry.hidden = !canViewSource(entry.dataset.providerDocument); });
    const count = document.querySelector('.nav-item[data-tab="documents"] em');
    if (count) count.textContent = entries.filter(entry => !entry.hidden).length;
    const empty = document.querySelector('#documents .provider-sources-empty');
    if (empty) empty.hidden = chart.mode !== 'provider' || entries.some(entry => !entry.hidden);
  }
  document.addEventListener('chart:mode', syncProviderDocuments);
  document.addEventListener('chart:sourceSelection', syncProviderDocuments);

  // Long notes (e.g. 93 genes tested) fold away so the result stays readable.
  const longText = (text, limit = 220) => text.length <= limit ? el('p', { class: 'vital-meta' }, text)
    : el('details', { class: 'more' }, el('summary', {}, `${text.slice(0, limit).replace(/\s+\S*$/, '')}… Show details`), el('p', { class: 'vital-meta' }, text));
  const card = (title, ...kids) => el('article', { class: 'vital-card' }, title ? el('h2', { class: 'card-title' }, title) : null, ...kids);

  // ---------- family history ----------
  const familyOrder = ['Mother', 'Father', 'Brother', 'Maternal Grandmother', 'Maternal Grandfather', 'Paternal Grandmother', 'Paternal Grandfather'];
  const familyAliases = new Map([
    ['mom', 'Mother'], ['mum', 'Mother'], ['mother', 'Mother'],
    ['dad', 'Father'], ['father', 'Father'],
    ['brother', 'Brother'],
    ['maternal grandma', 'Maternal Grandmother'], ['maternal grandmother', 'Maternal Grandmother'],
    ['paternal grandma', 'Paternal Grandmother'], ['paternal grandmother', 'Paternal Grandmother'],
    ['maternal grandpa', 'Maternal Grandfather'], ['maternal grandfather', 'Maternal Grandfather'],
    ['paternal grandpa', 'Paternal Grandfather'], ['paternal grandfather', 'Paternal Grandfather']
  ]);
  const familyKey = relation => familyAliases.get(relation.trim().toLocaleLowerCase()) || relation.trim().toLocaleLowerCase();
  const familyLabel = relation => familyAliases.get(relation.trim().toLocaleLowerCase()) || relation.trim();
  function renderFamily() {
    const list = el('div', { class: 'family-grid' });
    const members = new Map();
    for (const row of data.family_history) {
      const relation = familyLabel(row.relation || 'Family member');
      const key = familyKey(relation);
      if (!members.has(key)) members.set(key, { relation, rows: [] });
      members.get(key).rows.push(row);
    }
    const orderedMembers = [...members.entries()].sort(([keyA, a], [keyB, b]) => {
      const rankA = familyOrder.indexOf(a.relation), rankB = familyOrder.indexOf(b.relation);
      if ((rankA < 0) !== (rankB < 0)) return rankA < 0 ? 1 : -1;
      if (rankA >= 0 && rankA !== rankB) return rankA - rankB;
      return a.relation.localeCompare(b.relation) || keyA.localeCompare(keyB);
    });
    const destinations = [...new Set([...familyOrder, ...[...members.values()].map(member => member.relation)])];
    for (const [memberKey, { relation, rows }] of orderedMembers) {
      const conditions = rows.filter(row => row.condition?.trim());
      const profile = el('details', { class: 'family-profile' },
        el('summary', { class: 'family-profile-summary' },
          el('span', { class: 'family-profile-name' }, relation),
          el('span', { class: 'family-profile-count' }, `${conditions.length} ${conditions.length === 1 ? 'condition' : 'conditions'}`),
          el('span', { class: 'family-profile-chevron', 'aria-hidden': 'true' }, '⌄')),
        el('div', { class: 'family-profile-content' }));
      const content = profile.querySelector('.family-profile-content');
      profile.insertBefore(chart.preparation.familyMemberDetails(relation), content);
      for (const row of rows) {
        const item = el('article', { class: 'family-condition' },
          el('div', {}, el('h2', {}, row.condition || 'No condition details recorded')));
        chart.preparation.decorate(item, 'family_history', row);
        const move = el('details', { class: 'family-move owner-only' }, el('summary', {}, 'Move to another member'));
        const target = el('select', { 'aria-label': `Move ${row.condition || 'family history item'} to another member` });
        target.append(el('option', { value: '', selected: true, disabled: true }, 'Choose a relative'));
        for (const destination of destinations.filter(name => familyKey(name) !== memberKey)) target.append(el('option', { value: destination }, destination));
        const moveButton = el('button', { type: 'button', class: 'outline-button compact' }, 'Move condition');
        const moveError = el('span', { class: 'family-move-error', role: 'alert' });
        moveButton.addEventListener('click', async () => {
          if (!target.value) { moveError.textContent = 'Choose a relative first.'; return; }
          moveButton.disabled = true; moveError.textContent = '';
          try { await chart.preparation.moveFamilyRow(row, target.value); }
          catch (error) { moveError.textContent = error.message; moveButton.disabled = false; }
        });
        move.append(target, moveButton, moveError);
        item.append(move);
        const remove = el('button', { type: 'button', class: 'text-button family-delete owner-only' }, 'Remove');
        remove.addEventListener('click', () => chart.preparation.deleteRow('family_history', row));
        item.append(remove);
        content.append(item);
      }
      content.append(chart.preparation.addButton('family_history', 'Add condition', { relation }));
      list.append(profile);
    }
    body('family', chart.preparation.addButton('family_history', 'Add family member', { newFamilyMember: true }),
      members.size ? list : el('p', { class: 'family-empty' }, 'No family members added yet. Add a member to start a separate profile for their history.'));
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
    body('medications', chart.preparation.addButton('medications'), el('p', { class: 'vital-meta' }, 'Source records and notes are labeled below.'), rows.length ? list : el('p', {}, 'No medications recorded.'));
  }

  // ---------- medical records ----------
  function renderDocuments() {
    const section = document.getElementById('documents');
    const uploaded = uploadedDocuments;
    const known = new Set(data.documents.map(d => d.document));
    const list = el('div', { class: 'record-list' });
    let year = null, yearContent = null;
    for (const d of data.documents) {
      const y = d.unextracted ? 'Uploaded, not yet extracted' : (d.date || '').slice(0, 4) || 'Undated';
      if (y !== year) {
        year = y;
        const group = el('details', { class: 'record-year' });
        group.open = true;
        group.append(el('summary', { class: 'timeline-year' }, y || 'Undated'));
        yearContent = el('div', { class: 'record-year-content' });
        group.append(yearContent);
        list.append(group);
      }
      const row = el('a', { class: 'record-row', href: `#doc/${encodeURIComponent(d.document)}` },
        el('div', { class: 'pdf-icon' }, 'PDF'),
        el('div', { class: 'record-copy' },
          el('div', { class: 'record-title' }, el('b', {}, d.title || d.document), chip(KINDS[d.kind] || 'Document')),
          el('p', { class: 'vital-meta' }, [day(d.date), d.provider, d.clinician].filter(Boolean).join(' · ')),
          d.summary ? el('div', { class: 'record-summary-block' },
            el('span', { class: 'record-summary-label' }, 'At a glance'),
            el('p', { class: 'record-summary' }, d.summary)) : null),
        el('span', { class: 'record-arrow' }, '→'));
      const entry = el('article', { class: 'document-entry' }, row);
      entry.dataset.providerDocument = d.document;
      entry.hidden = !canViewSource(d.document);
      chart.preparation.decorate(entry, 'documents', d);
      const include = el('input', { type: 'checkbox', 'aria-label': `Include ${d.title || d.document} source in Provider view` });
      include.checked = chart.preparation.isSourceIncluded(d.document);
      const flagError = el('span', { class: 'source-flag-error', role: 'alert' });
      include.addEventListener('change', async () => {
        const next = include.checked;
        include.disabled = true; flagError.textContent = '';
        try { await chart.preparation.setSourceIncluded(d.document, next); }
        catch (error) { include.checked = !next; flagError.textContent = error.message; }
        finally { include.disabled = false; }
      });
      entry.append(el('label', { class: 'source-inclusion owner-only' }, include, el('span', {}, 'Include source in Provider view')),
        flagError);
      yearContent.append(entry);
    }
    const deletedDocuments = new Set((data.deleted_entries?.documents || []).map(d => d.document));
    const extra = uploaded.filter(n => !known.has(n) && !deletedDocuments.has(n));
    if (extra.length) {
      const group = el('details', { class: 'record-year' });
      group.open = true;
      group.append(el('summary', { class: 'timeline-year' }, 'Uploaded, not yet extracted'));
      const content = el('div', { class: 'record-year-content' });
      group.append(content);
      extra.forEach(n => {
        const entry = el('a', { class: 'record-row', href: `#doc/${encodeURIComponent(n)}`, 'data-provider-document': n });
        entry.append(el('div', { class: 'pdf-icon' }, 'PDF'), el('div', { class: 'record-copy' }, el('b', {}, n)), el('span', { class: 'record-arrow' }, '→'));
        content.append(entry);
      });
      list.append(group);
    }
    const search = el('input', { type: 'search', class: 'search-input', placeholder: 'Search documents', 'aria-label': 'Search documents' });
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      list.querySelectorAll('.record-row').forEach(r => { r.hidden = q && !r.textContent.toLowerCase().includes(q); });
      if (q) list.querySelectorAll('.record-year').forEach(group => {
        group.open = [...group.querySelectorAll('.record-row')].some(row => !row.hidden);
      });
    });
    const upload = section.querySelector('.upload-banner');
    body('documents', el('div', { class: 'filter-row plain' }, search),
      el('p', { class: 'vital-meta owner-only' }, 'Select only the source PDFs you may need during the visit. Unselected PDFs stay out of Provider view.'),
      el('p', { class: 'provider-sources-empty provider-only' }, 'No source PDFs selected for Provider view. In Prepare, include the records you want to open during the visit.'),
      list, upload || '');
    syncProviderDocuments();
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

    // Standalone reports belong in Genetics without pretending their contents are individual
    // clinical findings. Their source remains governed by the Prepare source-selection flag.
    for (const report of data.documents.filter(d => d.kind === 'genetic' && !clinicalRows.some(f => f.document === d.document))) {
      kids.push(card(report.title || report.document,
        el('p', { class: 'vital-meta' }, [day(report.date), report.provider, 'Genetic report'].filter(Boolean).join(' · ')),
        report.summary ? el('p', { class: 'vital-meta' }, report.summary) : null,
        canViewSource(report.document) ? sourceButton(report.document, null, 'Open report →') : null));
    }

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
