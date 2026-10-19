// Lab browsing, using normalized clinical records and shared source links.
(() => {
  const { el, day, body, chip, docTitle, sourceButton } = chart.clinicalUI;
  const kit = window.chartKit;
  const { parse } = kit;
  let data;
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
    if (/a1c/.test(name)) return 'Diabetes & metabolism';
    for (const [label, byName, byUnit] of CATEGORIES) if ((byName && byName.test(name)) || (byUnit && byUnit.test(unit))) return label;
    return 'Other';
  };

  const labState = { query: '', flagged: false, open: new Set(), sections: new Set() };
  // An explicit common-test list keeps specialized tests out of the default view.
  const COMMON = /^(white blood cell count|red blood cell count|hemoglobin|hematocrit|mcv|mch|mchc|rdw.*|platelets?|platelet count|mpv|neutrophils.*|lymphocytes.*|monocytes.*|eosinophils.*|basophils.*|glucose|bun|bun\/creatinine ratio|creatinine|egfr|sodium|potassium|chloride|carbon dioxide|calcium|protein, total|total protein|albumin|globulin|albumin\/globulin ratio|bilirubin, total|total bilirubin|alkaline phosphatase|ast|alt|cholesterol, total|total cholesterol|hdl cholesterol|ldl cholesterol|non-hdl cholesterol|triglycerides|cholesterol\/hdl ratio|hemoglobin a1c|hba1c|a1c)$/i;
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

  // flag_calculated: the lab printed no flag; the server compared the value to the printed range.
  function flagChip(flag, calculated) {
    const f = (flag || '').toLowerCase();
    const calc = c => { if (calculated) { c.textContent += ' (calc.)'; c.title = 'Calculated from the printed range; the lab did not flag this result'; } return c; };
    if (f === 'high') return calc(chip('▲ High', 'bad'));
    if (f === 'low') return calc(chip('▼ Low', 'bad'));
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
                                           note: [r.provider, r.flag ? `${r.flag.toUpperCase()}${r.flag_calculated ? ' (calculated from printed range)' : ''}` : null].filter(Boolean).join(' · ') || null }));
      const lo = latest.ref_low, hi = latest.ref_high;
      const range = lo != null || hi != null ? [lo ?? -Infinity, hi ?? Infinity] : null;
      const decimals = Math.max(...g.numeric.map(r => (String(r.value).split('.')[1] || '').length), 0);
      box.append(plot);
      kit.drawWhenSized(plot, () => kit.lineChart(plot, { lines: [{ label: g.test, color: 'var(--series-1)', points }], unit: latest.unit || '',
        decimals: Math.min(decimals, 2), range, rangeLabel: range ? `reference ${refText(latest)}` : null, start: null, end: new Date() }));
    }
    const tbody = el('tbody');
    [...g.rows].reverse().forEach(r => tbody.append(el('tr', {},
      el('td', {}, day(r.taken_at)), el('td', { class: 'num' }, valueText(r)), el('td', {}, flagChip(r.flag, r.flag_calculated) || ''),
      el('td', {}, refText(r)), el('td', {}, sourceButton(r.document, r.page, `${docTitle(r.document)} · p.${r.page || 1} →`)))));
    box.append(el('div', { class: 'reading-table' }, el('table', {}, el('thead', {}, el('tr', {},
      el('th', {}, 'Date'), el('th', { class: 'num' }, 'Result'), el('th', {}, 'Flag'), el('th', {}, 'Reference'), el('th', {}, 'Source'))), tbody)));
    if (new Set(g.rows.map(r => r.unit)).size > 1) box.append(el('p', { class: 'vital-meta' }, 'Note: results were reported in different units; the chart may mix them.'));
    const notes = el('div', { class: 'lab-patient-notes' }, el('h3', {}, 'Notes by result date'));
    for (const row of [...g.rows].reverse()) {
      const entry = el('div', { class: 'lab-result-note' }, el('p', { class: 'vital-meta' }, day(row.taken_at)));
      chart.preparation.decorate(entry, 'lab_results', row);
      if (!row._patient_note) entry.classList.add('owner-only');
      notes.append(entry);
    }
    if (!g.rows.some(row => row._patient_note)) notes.classList.add('owner-only');
    box.append(notes);
    return box;
  }

  function renderLabs() {
    if (!data.lab_results.length) { body('labs', el('p', {}, 'No lab results recorded.')); return; }
    const groups = labGroups();
    const section = document.getElementById('labs');
    section.querySelector('.filter-row')?.remove();
    if (!section.querySelector('.filter-row')) {
      const search = el('input', { type: 'search', class: 'search-input', placeholder: 'Search all tests, including collapsed categories', 'aria-label': 'Find a test' });
      search.value = labState.query;
      search.addEventListener('input', () => { labState.query = search.value.trim().toLowerCase(); drawLabList(); });
      const toggle = el('button', { type: 'button', class: 'toggle-button', 'aria-pressed': 'false' }, 'Out of range only');
      toggle.setAttribute('aria-pressed', String(labState.flagged));
      toggle.classList.toggle('on', labState.flagged);
      toggle.addEventListener('click', () => { labState.flagged = !labState.flagged; toggle.setAttribute('aria-pressed', labState.flagged); toggle.classList.toggle('on', labState.flagged); drawLabList(); });
      section.querySelector('.page-heading').after(el('div', { class: 'filter-row' }, search, toggle));
    }
    const flaggedCount = groups.filter(g => g.flagged).length;
    const dates = [...new Set(data.lab_results.map(r => r.taken_at).filter(Boolean))].sort();
    const summary = el('p', { class: 'lab-overview' },
      `${groups.length} tests across ${dates.length} draw dates, ${day(dates[0])} – ${day(dates[dates.length - 1])}. ${flaggedCount} flagged out of range at their latest result.`);
    const list = el('div', { class: 'lab-list' });
    body('labs', summary, list);

    function drawLabList() {
      const shown = groups.filter(g => (!labState.flagged || g.flagged) && (!labState.query || g.test.toLowerCase().includes(labState.query)
        || g.panel.toLowerCase().includes(labState.query) || g.rows.some(r => [r.test_reported, r.panel, r.provider, r._patient_note].filter(Boolean).join(' ').toLowerCase().includes(labState.query))));
      list.replaceChildren();
      if (!shown.length) { list.append(el('p', { class: 'vital-empty' }, 'No tests match.')); return; }
      const filtering = Boolean(labState.query || labState.flagged);
      for (const [tier, common] of [['Common labs', true], ['Other tests', false]]) {
        const tierGroups = shown.filter(g => COMMON.test(g.test) === common);
        if (!tierGroups.length) continue;
        list.append(el('h2', { class: 'lab-tier-heading' }, tier));
        const byPanel = new Map();
        tierGroups.forEach(g => byPanel.set(g.panel, [...(byPanel.get(g.panel) || []), g]));
        for (const [panel, items] of [...byPanel].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))) {
          const sectionKey = `${tier}::${panel}`;
          const sectionList = el('div', { class: 'lab-list' });
          const flags = items.filter(g => g.flagged).length;
          const accordion = chart.clinicalUI.accordion(panel, `${items.length} test${items.length === 1 ? '' : 's'}${flags ? ` · ${flags} flagged` : ''}`, sectionList,
            filtering || labState.sections.has(sectionKey) || (common && labState.sections.has(panel)));
          accordion.addEventListener('toggle', () => {
            if (filtering) return;
            labState.sections.delete(panel);
            accordion.open ? labState.sections.add(sectionKey) : labState.sections.delete(sectionKey);
          });
          list.append(accordion);
          for (const g of items.sort((a, b) => a.test.localeCompare(b.test))) {
            const key = `${panel}::${g.test}`;
            const open = labState.open.has(key);
            const row = el('button', { type: 'button', class: `lab-item${g.flagged ? ' flagged' : ''}`, 'aria-expanded': String(open) },
              el('span', { class: 'lab-name' }, el('b', {}, g.test), el('small', {}, `${g.rows.length} result${g.rows.length > 1 ? 's' : ''} · latest ${day(g.latest.taken_at)} · history ▾`)),
              g.numeric.length >= 2 ? sparkline(g.numeric) : el('span', { class: 'spark' }),
              el('span', { class: 'lab-value' }, valueText(g.latest)),
              el('span', { class: 'lab-flag' }, flagChip(g.latest.flag, g.latest.flag_calculated) || ''),
              el('span', { class: 'lab-ref' }, (refText(g.latest) ? `Reference: ${refText(g.latest)}` : 'Reference range not reported') + (g.rows.some(r => r._patient_note) ? ' · Note available in history' : '')));
            const wrap = el('div', { class: 'lab-wrap' }, row);
            if (open) wrap.append(labDetail(g));
            row.addEventListener('click', () => {
              labState.open.has(key) ? labState.open.delete(key) : labState.open.add(key);
              const nowOpen = labState.open.has(key);
              row.setAttribute('aria-expanded', String(nowOpen));
              wrap.querySelector('.lab-detail')?.remove();
              if (nowOpen) wrap.append(labDetail(g));
            });
            sectionList.append(wrap);
          }
        }
      }
    }
    drawLabList();
  }

  chart.renderLabs = clinical => { data = clinical; renderLabs(); };
})();
