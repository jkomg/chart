// Sections built from extracted documents (/api/clinical): history, labs, records, medications,
// family history, genetics. Every item links back to the page it came from. Sections keep their
// starter content until this account has extracted data.
(() => {
  const kit = window.chartKit;
  const { el, fmtDate, parse } = kit;
  const DAY = 86400000;
  const KINDS = { lab: 'Lab results', genetic: 'Genetic test', visit: 'Visit', er: 'Emergency visit', imaging: 'Imaging',
                  monitor: 'Monitoring', sleep: 'Sleep study', other: 'Document' };
  let data = null, docsByName = {};

  const day = t => (t ? fmtDate(parse(t)) : 'Date unknown');
  const sourceButton = (doc, page, text) => {
    const b = el('button', { type: 'button', class: 'source-link' }, text || `View source${page ? ` · page ${page}` : ''} →`);
    b.addEventListener('click', e => { e.stopPropagation(); chart.openDoc(doc, page); });
    return b;
  };
  const docTitle = name => docsByName[name]?.title || name;
  const body = (id, ...kids) => {
    const section = document.getElementById(id);
    let holder = section.querySelector('.data-body');
    if (!holder) {
      holder = el('div', { class: 'data-body' });
      [...section.children].filter(c => !c.classList.contains('page-heading') && !c.classList.contains('filter-row') && c.tagName !== 'FORM').forEach(c => c.remove());
      section.append(holder);
    }
    holder.replaceChildren(...kids);
    return holder;
  };
  // Long notes (e.g. 93 genes tested) fold away so the result stays readable.
  const longText = (text, limit = 220) => text.length <= limit ? el('p', { class: 'vital-meta' }, text)
    : el('details', { class: 'more' }, el('summary', {}, `${text.slice(0, limit).replace(/\s+\S*$/, '')}… Show details`), el('p', { class: 'vital-meta' }, text));
  const card = (title, ...kids) => el('article', { class: 'vital-card' }, title ? el('h2', { class: 'card-title' }, title) : null, ...kids);
  const chip = (text, tone) => el('span', { class: `chip ${tone || ''}` }, text);

  // ---------- medical history ----------
  function renderHistory() {
    const { events, diagnoses, allergies } = data;
    if (!events.length && !diagnoses.length) return;
    const kids = [];
    if (diagnoses.length) {
      const byName = new Map();
      for (const d of [...diagnoses].sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
        const key = d.name.toLowerCase();
        byName.set(key, { ...byName.get(key), ...d, first: byName.get(key)?.first || d.date });
      }
      const list = el('div', { class: 'condition-list' });
      const rank = d => ({ active: 0, suspected: 1, history: 2, resolved: 3 }[(d.status || '').toLowerCase()] ?? 2);
      const sorted = [...byName.values()].sort((a, b) => rank(a) - rank(b) || (b.date || '').localeCompare(a.date || ''));
      for (const d of sorted) {
        list.append(el('div', { class: 'condition-row' },
          el('div', {}, el('b', {}, d.name), el('p', { class: 'vital-meta' },
            [d.icd10, d.first ? `since ${day(d.first)}` : null, d.status].filter(Boolean).join(' · '))),
          sourceButton(d.document, d.page, 'Source →')));
      }
      kids.push(card('Conditions', list));
    }
    if (allergies.length) {
      kids.push(card('Allergies', el('div', { class: 'chip-row' },
        ...allergies.map(a => chip(a.reaction ? `${a.substance} · ${a.reaction}` : a.substance, 'warn')))));
    }
    const timeline = el('div', { class: 'timeline' });
    let year = null;
    for (const e of events) {
      const y = (e.date || '').slice(0, 4);
      if (y !== year) { year = y; timeline.append(el('p', { class: 'eyebrow timeline-year' }, y || 'Undated')); }
      timeline.append(el('article', { class: 'timeline-item' },
        el('div', { class: 'timeline-date' }, e.date ? fmtDate(parse(e.date), { month: 'short', day: 'numeric' }) : '—'),
        el('div', { class: 'timeline-dot' }),
        el('div', { class: 'timeline-card' }, chip((e.type || 'event').toUpperCase()), el('h2', {}, e.title),
          e.detail ? el('p', {}, e.detail) : null,
          el('p', { class: 'vital-meta' }, docTitle(e.document)), sourceButton(e.document, e.page))));
    }
    if (events.length) kids.push(timeline);
    body('history', ...kids);
  }

  // ---------- family history ----------
  function renderFamily() {
    if (!data.family_history.length) return;
    const byRelation = new Map();
    data.family_history.forEach(f => byRelation.set(f.relation, [...(byRelation.get(f.relation) || []), f]));
    body('family', el('div', { class: 'family-grid' }, ...[...byRelation].map(([relation, rows]) =>
      el('article', { class: 'family-card' }, el('p', { class: 'eyebrow' }, relation),
        ...rows.map(r => el('h2', {}, r.condition)), sourceButton(rows[0].document, rows[0].page, 'Source →')))));
  }

  // ---------- medications ----------
  function renderMedications() {
    if (!data.medications.length) return;
    const latest = new Map();
    for (const m of [...data.medications].sort((a, b) => (a.date || '').localeCompare(b.date || ''))) latest.set(m.name.toLowerCase(), m);
    const rows = [...latest.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    body('medications', el('p', { class: 'vital-meta list-note' }, 'As recorded in source documents. Check with the current prescriber for what’s active today.'),
      el('div', { class: 'medication-list' }, ...rows.map(m => el('article', { class: 'medication-row' },
        el('div', { class: 'med-icon' }, '＋'),
        el('div', { class: 'med-copy' }, el('h2', {}, m.name),
          el('p', {}, [m.dose, m.schedule].filter(Boolean).join(' · ') || '—'),
          el('p', { class: 'vital-meta' }, `${m.context || 'recorded'} · ${day(m.date)}`)),
        sourceButton(m.document, m.page, 'Source →')))));
  }

  // ---------- medical records ----------
  function renderDocuments() {
    if (!data.documents.length) return;
    const section = document.getElementById('documents');
    const uploaded = [...section.querySelectorAll('.document-card')].map(a => decodeURIComponent(a.getAttribute('href').slice(5)));
    const known = new Set(data.documents.map(d => d.document));
    const list = el('div', { class: 'record-list' });
    let year = null;
    for (const d of data.documents) {
      const y = (d.date || '').slice(0, 4);
      if (y !== year) { year = y; list.append(el('p', { class: 'eyebrow timeline-year' }, y || 'Undated')); }
      const row = el('a', { class: 'record-row', href: `#doc/${encodeURIComponent(d.document)}` },
        el('div', { class: 'pdf-icon' }, 'PDF'),
        el('div', { class: 'record-copy' },
          el('div', { class: 'record-title' }, el('b', {}, d.title || d.document), chip(KINDS[d.kind] || 'Document')),
          el('p', { class: 'vital-meta' }, [day(d.date), d.provider, d.clinician].filter(Boolean).join(' · ')),
          d.summary ? el('p', { class: 'record-summary' }, d.summary) : null),
        el('span', { class: 'record-arrow' }, '→'));
      list.append(row);
    }
    const extra = uploaded.filter(n => !known.has(n));
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

  // ---------- labs ----------
  // Labs print their own section headings; group by clinical category instead, in the order a
  // clinician scans a chart. First matching rule wins.
  const CATEGORIES = [
    ['Screening scores', /\bvcs\b|cirs|imbalance score|dysbiosis score|\(iad\) score|visual contrast/],
    ['Cancer screening', /galleri|multi-cancer/],
    ['Women’s health', /pap |pap specimen|^hpv|hcg/],
    ['Autonomic & vascular testing', /brachial|arterial compliance|augmentation index|autonomic|cardiac output|stroke volume|dicrotic|ejection elasticity|reflection index|stiffness index|e\/i ratio|valsalva|30:15|coronary respiratory|dpti|tilt test|sudomotor|bioelectrical|blood volume|mean arterial|qrs|qtc|stress index|functional age/],
    ['Lung function', /fev1|fvc|fef25|expiratory|lung age/],
    ['Brain & cognitive testing', /^eeg|^erp|reaction time|missed responses|wrong responses/],
    ['Clotting', /^inr$|prothrombin time|thromboplastin|fibrinogen/],
    ['Body measurements', /body mass index|waist/],
    ['Sleep & heart monitoring', /sleep study|apnea|hypopnea|holter|desaturation|\(odi\)|respiratory indicator|flow limitation|snoring|breaths/],
    ['Stool & gut', /stool|fecal|calprotectin|lactoferrin|charcot|firmicutes|helicobacter|beta-glucuronidase|pancreatic elastase|occult blood/],
    ['Urine organic & amino acids', /kynurenic\/quinolinic/, /mmol\/mol creatinine|micromol\/g creatinine|mcg\/g creatinine|ug\/g cr/],
    ['Urinalysis', /^urine |, urine|urine\)|\burine\b|specific gravity|urobilinogen/],
    ['Blood count (CBC)', /hemoglobin$|^hemoglobin|hematocrit|red blood cell|white blood cell|platelet|^mcv|^mch|^rdw|^mpv|neutrophil|lymphocyte|monocyte|eosinophil|basophil|immature gran|nucleated rbc|morphology|smear|total cells counted/],
    ['Diabetes & metabolism', /a1c|insulin|c-peptide|leptin|adiponectin|glucose/],
    ['Kidney & electrolytes', /^bun|creatinine|egfr|sodium|potassium|chloride|carbon dioxide|calcium|anion gap|osmolality|uric acid/],
    ['Liver, pancreas & muscle', /creatine kinase|^alt$|^ast$|alkaline phosphatase|bilirubin|^ggt|amylase|lipase|^albumin|globulin|protein, total/],
    ['Lipids & heart', /cholesterol|hdl|ldl|triglyceride|apolipoprotein|lipoprotein|natriuretic|bnp|troponin|homocysteine|d-dimer/],
    ['Thyroid', /tsh|\bt3\b|\bt4\b|thyroglobulin|thyroid peroxidase|thyroxine|triiodothyronine/],
    ['Iron', /^iron|ferritin|iron binding|uibc/],
    ['Hormones', /estradiol|testosterone|dhea|^fsh|^lh$|prolactin|sex hormone|progesterone|cortisol|cortisone|mullerian|igf-1|androstenedione|dihydrotestosterone|aldosterone|renin|antidiuretic|melanocyte|vasoactive|melatonin/],
    ['Vitamins & minerals', /vitamin|folate|b12|magnesium|zinc|copper|selenium|iodine|ceruloplasmin|methylmalonic/],
    ['Fatty acids', /omega|fatty acid|linoleic|linolenic|oleic|palmit|stearic|arachid|behenic|lignoceric|nervonic|myristic|margaric|pentadecanoic|tricosanoic|vaccenic|elaidic|eicos|docosa|\bepa\b|\bdha\b|\bdpa\b|trans fat|aa\/epa/],
    ['Infectious disease', /sars-cov|covid|hiv|hsv|hpv|chlamydia|gonorrh|trichomonas|rpr|lyme|culture|susceptibility|candida/],
    ['Toxins & metals', /lead|mercury|arsenic|aluminum|kryptopyrrole/],
    ['Inflammation & immune', /crp|sedimentation|\bana\b|complement|rheumatoid|dsdna|^anti-|^ig[agem]|igg subclass|hla|histamine|tgf|mmp-9|vegf|gliadin|transglutaminase|ige|pai-1|antibody screen/],
    ['Oral health', /oral bacteria/],
    ['Blood type', /abo group|rh type/],
  ];
  // Display order (matching order above is about specificity, not importance).
  const ORDER = ['Out of range at last test', 'Blood count (CBC)', 'Kidney & electrolytes', 'Liver, pancreas & muscle', 'Lipids & heart',
    'Diabetes & metabolism', 'Thyroid', 'Hormones', 'Iron', 'Vitamins & minerals', 'Inflammation & immune', 'Clotting',
    'Infectious disease', 'Women’s health', 'Cancer screening', 'Urinalysis', 'Stool & gut', 'Urine organic & amino acids',
    'Fatty acids', 'Toxins & metals', 'Oral health', 'Blood type', 'Sleep & heart monitoring', 'Autonomic & vascular testing',
    'Lung function', 'Brain & cognitive testing', 'Body measurements', 'Screening scores', 'Other'];
  const categoryOf = g => {
    const name = g.test.toLowerCase(), unit = (g.latest.unit || '').toLowerCase();
    for (const [label, byName, byUnit] of CATEGORIES) if ((byName && byName.test(name)) || (byUnit && byUnit.test(unit))) return label;
    return 'Other';
  };

  const labState = { query: '', flagged: false, open: new Set() };
  function labGroups() {
    const byTest = new Map();
    for (const r of data.lab_results) {
      const key = r.test.toLowerCase();
      if (!byTest.has(key)) byTest.set(key, { test: r.test, rows: [] });
      byTest.get(key).rows.push(r);
    }
    for (const g of byTest.values()) {
      g.rows.sort((a, b) => (a.taken_at || '').localeCompare(b.taken_at || ''));
      g.latest = g.rows[g.rows.length - 1];
      g.panel = categoryOf(g);
      g.flagged = ['high', 'low', 'abnormal'].includes((g.latest.flag || '').toLowerCase());
      g.numeric = g.rows.filter(r => r.value != null);
    }
    return [...byTest.values()];
  }

  function flagChip(flag) {
    const f = (flag || '').toLowerCase();
    if (f === 'high') return chip('▲ High', 'bad');
    if (f === 'low') return chip('▼ Low', 'bad');
    if (f === 'abnormal') return chip('● Abnormal', 'bad');
    return null;
  }

  const valueText = r => (r.value != null ? `${kit.fmt(r.value, r.value % 1 ? (Math.abs(r.value) < 10 ? 2 : 1) : 0)}${r.unit ? ` ${r.unit}` : ''}` : `${r.value_text ?? '—'}${r.unit && r.value_text && /\d/.test(r.value_text) ? ` ${r.unit}` : ''}`);
  const refText = r => r.ref_text || (r.ref_low != null && r.ref_high != null ? `${r.ref_low}–${r.ref_high}` : r.ref_low != null ? `> ${r.ref_low}` : r.ref_high != null ? `< ${r.ref_high}` : '');

  function sparkline(rows) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 80 24'); svg.setAttribute('class', 'spark'); svg.setAttribute('aria-hidden', 'true');
    if (rows.length < 2) return svg;
    const xs = rows.map(r => +parse(r.taken_at)), ys = rows.map(r => r.value);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const X = x => 2 + ((x - x0) / (x1 - x0 || 1)) * 76, Y = y => 21 - ((y - y0) / (y1 - y0 || 1)) * 18;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', rows.map((r, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(''));
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', X(xs[xs.length - 1])); dot.setAttribute('cy', Y(ys[ys.length - 1])); dot.setAttribute('r', 2.5);
    svg.append(path, dot);
    return svg;
  }

  function labDetail(g) {
    const box = el('div', { class: 'lab-detail' });
    const latest = g.latest;
    if (g.numeric.length >= 2) {
      const plot = el('div', { class: 'plot' });
      const points = g.numeric.map(r => ({ t: r.taken_at, d: parse(r.taken_at), v: r.value, source: 'lab', doc: r.document, page: r.page,
                                           note: [r.provider, r.flag ? r.flag.toUpperCase() : null].filter(Boolean).join(' · ') || null }));
      const lo = latest.ref_low, hi = latest.ref_high;
      const range = lo != null || hi != null ? [lo ?? -Infinity, hi ?? Infinity] : null;
      const decimals = Math.max(...g.numeric.map(r => (String(r.value).split('.')[1] || '').length), 0);
      box.append(plot);
      kit.drawWhenSized(plot, () => kit.lineChart(plot, { lines: [{ label: g.test, color: 'var(--series-1)', points }], unit: latest.unit || '',
        decimals: Math.min(decimals, 2), range, rangeLabel: range ? `reference ${refText(latest)}` : null, start: null, end: new Date() }));
    }
    const tbody = el('tbody');
    [...g.rows].reverse().forEach(r => tbody.append(el('tr', {},
      el('td', {}, day(r.taken_at)), el('td', { class: 'num' }, valueText(r)), el('td', {}, flagChip(r.flag) || ''),
      el('td', {}, refText(r)), el('td', {}, sourceButton(r.document, r.page, `${docTitle(r.document)} · p.${r.page || 1} →`)))));
    box.append(el('div', { class: 'reading-table' }, el('table', {}, el('thead', {}, el('tr', {},
      el('th', {}, 'Date'), el('th', { class: 'num' }, 'Result'), el('th', {}, 'Flag'), el('th', {}, 'Reference'), el('th', {}, 'Source'))), tbody)));
    if (new Set(g.rows.map(r => r.unit)).size > 1) box.append(el('p', { class: 'vital-meta' }, 'Note: results were reported in different units; the chart may mix them.'));
    return box;
  }

  function renderLabs() {
    if (!data.lab_results.length) return;
    const groups = labGroups();
    const section = document.getElementById('labs');
    if (!section.querySelector('.filter-row')) {
      const search = el('input', { type: 'search', class: 'search-input', placeholder: 'Find a test (e.g. ferritin, TSH)', 'aria-label': 'Find a test' });
      search.addEventListener('input', () => { labState.query = search.value.trim().toLowerCase(); drawLabList(); });
      const toggle = el('button', { type: 'button', class: 'toggle-button', 'aria-pressed': 'false' }, 'Out of range only');
      toggle.addEventListener('click', () => { labState.flagged = !labState.flagged; toggle.setAttribute('aria-pressed', labState.flagged); toggle.classList.toggle('on', labState.flagged); drawLabList(); });
      section.querySelector('.page-heading').after(el('div', { class: 'filter-row' }, search, toggle));
    }
    const flaggedCount = groups.filter(g => g.flagged).length;
    const dates = [...new Set(data.lab_results.map(r => r.taken_at))].sort();
    const summary = el('p', { class: 'vital-meta list-note' },
      `${groups.length} tests across ${dates.length} draw dates, ${day(dates[0])} – ${day(dates[dates.length - 1])}. ${flaggedCount} flagged out of range at their latest result.`);
    const list = el('div', { class: 'lab-list' });
    body('labs', summary, list);

    function drawLabList() {
      const shown = groups.filter(g => (!labState.flagged || g.flagged) && (!labState.query || g.test.toLowerCase().includes(labState.query)
        || g.rows.some(r => (r.test_reported || '').toLowerCase().includes(labState.query))));
      const byPanel = new Map();
      // Out-of-range results lead (also listed under their own category below).
      if (!labState.query && !labState.flagged) byPanel.set('Out of range at last test', shown.filter(g => g.flagged));
      shown.forEach(g => byPanel.set(g.panel, [...(byPanel.get(g.panel) || []), g]));
      list.replaceChildren();
      if (!shown.length) { list.append(el('p', { class: 'vital-empty' }, 'No tests match.')); return; }
      for (const [panel, items] of [...byPanel].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))) {
        list.append(el('p', { class: 'eyebrow timeline-year' }, panel));
        for (const g of items.sort((a, b) => a.test.localeCompare(b.test))) {
          const key = `${panel}::${g.test}`;
          const open = labState.open.has(key);
          const row = el('button', { type: 'button', class: `lab-item${g.flagged ? ' flagged' : ''}`, 'aria-expanded': String(open) },
            el('span', { class: 'lab-name' }, el('b', {}, g.test), el('small', {}, `${g.rows.length} result${g.rows.length > 1 ? 's' : ''} · latest ${day(g.latest.taken_at)}`)),
            g.numeric.length >= 2 ? sparkline(g.numeric) : el('span', { class: 'spark' }),
            el('span', { class: 'lab-value' }, valueText(g.latest)),
            el('span', { class: 'lab-flag' }, flagChip(g.latest.flag) || ''),
            el('span', { class: 'lab-ref' }, refText(g.latest)));
          const wrap = el('div', { class: 'lab-wrap' }, row);
          if (open) wrap.append(labDetail(g));
          row.addEventListener('click', () => {
            labState.open.has(key) ? labState.open.delete(key) : labState.open.add(key);
            const nowOpen = labState.open.has(key);
            row.setAttribute('aria-expanded', String(nowOpen));
            wrap.querySelector('.lab-detail')?.remove();
            if (nowOpen) wrap.append(labDetail(g));
          });
          list.append(wrap);
        }
      }
    }
    drawLabList();
  }

  // ---------- genetics ----------
  async function renderGenetics() {
    const section = document.getElementById('genetics');
    if (!section) return;
    const consumer = await fetch('/api/genetics', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({ findings: [], sources: [] }));
    const clinicalRows = data.clinical_genetics;
    const kids = [];
    const tone = c => /^pathogenic|likely pathogenic/i.test(c || '') ? 'bad' : /uncertain|vus/i.test(c || '') ? 'warn' : /negative|benign/i.test(c || '') ? 'good' : '';

    if (clinicalRows.length) {
      const byDoc = new Map();
      clinicalRows.forEach(f => byDoc.set(f.document, [...(byDoc.get(f.document) || []), f]));
      for (const [doc, findings] of byDoc) {
        const meta = docsByName[doc] || {};
        const rows = findings.map(f => el('div', { class: 'gene-row' },
          el('div', { class: 'gene-main' }, el('b', {}, f.gene || f.test || 'Result'),
            el('span', { class: 'mono' }, [f.variant, f.protein].filter(Boolean).join(' ') || ''),
            f.condition ? el('p', { class: 'vital-meta' }, [f.condition, f.inheritance].filter(Boolean).join(' · ')) : null,
            f.note ? longText(f.note) : null),
          el('div', { class: 'gene-side' }, chip(f.classification || 'Reported', tone(f.classification)),
            f.zygosity ? el('span', { class: 'vital-meta' }, f.zygosity) : null, sourceButton(f.document, f.page, 'Source →'))));
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
          el('td', {}, el('b', {}, f.label), f.condition ? el('div', { class: 'vital-meta' }, f.condition) : null, f.note ? el('div', { class: 'vital-meta' }, f.note) : null),
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
      if (!res.ok) return;
      data = await res.json();
    } catch { return; }
    docsByName = Object.fromEntries(data.documents.map(d => [d.document, d]));
    renderHistory(); renderFamily(); renderMedications(); renderDocuments(); renderLabs(); renderGenetics();
  }
  load();
})();
