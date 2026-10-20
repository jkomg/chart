// Vitals: one small chart per metric (never two scales on one plot), a shared range
// filter, tap/hover readouts that link back to the source PDF, and a table twin for each chart.
(() => {
  const section = document.getElementById('vitals');
  if (!section) return;
  const body = section.querySelector('.vitals-body');
  const SVG = 'http://www.w3.org/2000/svg';
  const DAY = 86400000;
  const RANGES = { '1m': 30, '3m': 91, '6m': 182, '1y': 365, all: Infinity };
  const SOURCES = { apple_health: 'Apple Health', oura: 'Oura', pdf: 'Clinic record', manual: 'Entered by hand', lab: 'Lab report', period_tracker: 'Period tracker backup' };
  const canViewSource = filename => chart.clinicalUI?.canViewSource(filename) ?? true;
  const CHARTS = [
    { key: 'blood_pressure', label: 'Blood pressure', unit: 'mmHg', series: ['bp_systolic', 'bp_diastolic'] },
    ...['resting_hr', 'weight', 'bmi', 'height', 'hrv_rmssd', 'hrv_sdnn', 'temp_deviation', 'vo2max']
      .map(key => ({ key, series: [key] })),
  ];
  // The server returns only the signed-in account's data; there is no way to ask for anyone else's.
  const state = { range: RANGES[chart.query?.get('range')] ? chart.query.get('range') : '6m', data: null, loaded: false };

  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) k === 'class' ? node.className = v : node.setAttribute(k, v);
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  };
  const svgEl = (tag, attrs = {}) => {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const parse = t => new Date(t.length === 10 ? `${t}T12:00:00` : t);
  const fmtDate = (d, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => d.toLocaleDateString(undefined, opts);
  const fmt = (v, decimals) => Number(v).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // ---------- filters ----------
  section.querySelectorAll('.segmented').forEach(group => {
    group.addEventListener('click', e => {
      const button = e.target.closest('button');
      if (!button) return;
      state[group.dataset.filter] = button.dataset.value;
      chart.replaceQuery({ range: state.range });
      syncFilters();
      load();
    });
  });
  function syncFilters() {
    section.querySelectorAll('.segmented').forEach(group => group.querySelectorAll('button').forEach(b => {
      const on = b.dataset.value === state[group.dataset.filter];
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    }));
  }

  async function load() {
    if (!state.data) {
      body.classList.add('refreshing');  // hold the previous render, dimmed, while fetching
      try {
        const res = await fetch('/api/vitals', { credentials: 'same-origin' });
        if (res.status === 401) { location.href = '/login'; return; }
        state.data = await res.json();
        chart.preparation.renderDeleted(state.data);
      } catch {
        body.classList.remove('refreshing');
        chart.toast('Couldn’t load vitals. Check the connection and try again.');
        return;
      }
    }
    body.classList.remove('refreshing');
    render();
  }
  chart.reloadVitals = async () => {
    state.data = null;
    await load();
    if (state.data) chart.preparation.renderDeleted(state.data);
    return Boolean(state.data);
  };

  // ---------- page ----------
  function render() {
    const data = state.data;
    const end = new Date();
    const start = state.range === 'all' ? null : new Date(end - RANGES[state.range] * DAY);
    body.replaceChildren();

    const cards = [];
    if (data.cycles.length) cards.push(cycleCard(data, start, end));
    for (const spec of CHARTS) {
      const series = spec.series.map(key => ({ key, meta: data.metrics[key], points: (data.series[key] || []).map(p => ({ ...p, d: parse(p.t) })) }))
        .filter(s => s.points.length);
      if (series.length) cards.push(metricCard(spec, series, start, end));
    }
    if (!cards.length) {
      body.append(el('div', { class: 'empty-card' }, el('div', { class: 'empty-icon' }, '♡'),
        el('h2', {}, 'No vitals yet.'),
        el('p', {}, 'Readings appear here once Apple Health, Oura, or clinic records are imported.')));
      return;
    }
    body.append(...cards);
  }

  function metricCard(spec, series, start, end) {
    const meta = series[0].meta;
    const label = spec.label || meta.label;
    const unit = spec.unit || meta.unit;
    const decimals = meta.decimals;
    const inRange = series.map(s => ({ ...s, points: s.points.filter(p => !start || p.d >= start) }));
    const card = el('article', { class: 'vital-card', id: `vital-${spec.key}` });
    const all = series.flatMap(s => s.points);
    const latestAll = all.reduce((a, b) => (b.d > a.d ? b : a));

    // Headline: latest value(s) + change across the selected range.
    const head = el('div', { class: 'vital-head' });
    const title = el('div', {}, el('h2', {}, label));
    const visible = inRange.filter(s => s.points.length);
    if (visible.length) {
      const latest = visible.map(s => s.points[s.points.length - 1]);
      const value = el('div', { class: 'vital-value' }, latest.map(p => fmt(p.v, decimals)).join(' / '), el('span', {}, ` ${unit}`));
      title.append(el('p', { class: 'vital-meta' }, `Latest · ${fmtDate(latest[0].d)}`));
      const first = visible[0].points[0], last = visible[0].points[visible[0].points.length - 1];
      const stats = el('div', { class: 'vital-stats' }, value);
      if (visible[0].points.length > 1 && series.length === 1) {
        const delta = last.v - first.v;
        const avg = visible[0].points.reduce((a, p) => a + p.v, 0) / visible[0].points.length;
        stats.append(el('p', { class: 'vital-meta' },
          `${delta >= 0 ? '+' : '−'}${fmt(Math.abs(delta), decimals)} since ${fmtDate(first.d, { month: 'short', day: 'numeric' })} · avg ${fmt(avg, decimals)}`));
      }
      head.append(title, stats);
    } else {
      head.append(title);
    }
    card.append(head);

    if (!visible.length) {
      card.append(el('p', { class: 'vital-empty' }, `No readings in this range. Last reading ${fmtDate(latestAll.d)}. `,
        rangeButton('Show all', 'all')));
      return card;
    }

    const colors = ['var(--series-1)', 'var(--series-2)'];
    const lines = inRange.map((s, i) => ({ ...s, color: colors[i], label: series.length > 1 ? s.meta.label : label }));
    if (lines.length > 1) {
      card.append(el('div', { class: 'legend' }, ...lines.map(l => el('span', {}, el('i', { style: `background:${l.color}` }), l.label))));
    }
    const range = series.length === 1 ? meta.range : null;
    const plot = el('div', { class: 'plot' });
    card.append(plot);
    drawWhenSized(plot, () => lineChart(plot, { lines, unit, decimals, range, start, end }));
    card.append(tableToggle(lines, unit, decimals));
    card.append(sourceLine(all));
    return card;
  }

  function rangeButton(text, value) {
    const b = el('button', { type: 'button', class: 'text-button' }, text);
    b.addEventListener('click', () => section.querySelector(`[data-filter="range"] [data-value="${value}"]`).click());
    return b;
  }

  function sourceLine(points) {
    const sources = [...new Set(points.map(p => SOURCES[p.source] || p.source))];
    return el('p', { class: 'vital-sources' }, `Source: ${sources.join(' · ')}`);
  }

  // Dense daily data gets a 7-day average as the trend; sparse clinic readings show every point.
  function withTrend(points) {
    let from = 0, sum = 0;
    return points.map((p, i) => {
      sum += p.v;
      while (points[from].d <= p.d - 7 * DAY) sum -= points[from++].v;
      return { ...p, avg: sum / (i - from + 1) };
    });
  }

  // Charts redraw on resize; drop the previous draw's document listeners first.
  function freshSignal(container) {
    container._listeners?.abort();
    container._listeners = new AbortController();
    return container._listeners.signal;
  }

  // ---------- line chart ----------
  function lineChart(container, { lines, unit, decimals, range, rangeLabel, start, end }) {
    container.replaceChildren();
    const signal = freshSignal(container);
    const W = container.clientWidth, H = 210;
    const m = { top: 12, right: 14, bottom: 26, left: 40 };
    const pts = lines.flatMap(l => l.points);
    const x0 = start ? +start : Math.min(...pts.map(p => +p.d)) - DAY;
    const x1 = start ? +end : Math.max(+end, ...pts.map(p => +p.d)) + DAY;
    const dense = lines.some(l => l.points.length > 40);
    const prepared = lines.map(l => ({ ...l, points: dense ? withTrend(l.points) : l.points }));

    // The axis fits the data; the typical-range band is drawn only where it overlaps.
    const lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
    const pad = (hi - lo || Math.abs(hi) * 0.1 || 1) * 0.12;
    const ticks = niceTicks(lo - pad, hi + pad, 4);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const X = t => m.left + ((t - x0) / (x1 - x0)) * (W - m.left - m.right);
    const Y = v => m.top + (1 - (v - y0) / (y1 - y0)) * (H - m.top - m.bottom);

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart-svg', role: 'img', tabindex: 0,
      'aria-label': `${lines.map(l => l.label).join(' and ')}, ${pts.length} readings. Use arrow keys to step through readings.` });

    if (range) {
      const top = Y(Math.min(range[1], y1)), bottom = Y(Math.max(range[0], y0));
      if (bottom > top) {
        svg.append(svgEl('rect', { x: m.left, y: top, width: W - m.left - m.right, height: bottom - top, class: 'band' }));
        const t = svgEl('text', { x: W - m.right - 4, y: top + 12, class: 'band-label', 'text-anchor': 'end' });
        t.textContent = rangeLabel || `typical ${range[0]}–${range[1]}`;
        svg.append(t);
      }
    }
    for (const v of ticks) {
      svg.append(svgEl('line', { x1: m.left, x2: W - m.right, y1: Y(v), y2: Y(v), class: 'grid' }));
      const t = svgEl('text', { x: m.left - 8, y: Y(v) + 4, class: 'tick', 'text-anchor': 'end' });
      t.textContent = fmt(v, Math.abs(y1 - y0) < 4 ? Math.max(decimals, 1) : 0);
      svg.append(t);
    }
    for (const t of timeTicks(x0, x1, W)) {
      const label = svgEl('text', { x: X(+t.d), y: H - 6, class: 'tick', 'text-anchor': 'middle' });
      label.textContent = t.label;
      svg.append(label);
    }

    for (const l of prepared) {
      const segments = splitOnGaps(l.points, dense ? 7 : Infinity);
      for (const seg of segments) {
        const d = seg.map((p, i) => `${i ? 'L' : 'M'}${X(+p.d).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
        svg.append(svgEl('path', { d, class: dense ? 'raw-line' : 'data-line', stroke: l.color }));
        if (dense) {
          const avg = seg.map((p, i) => `${i ? 'L' : 'M'}${X(+p.d).toFixed(1)},${Y(p.avg).toFixed(1)}`).join('');
          svg.append(svgEl('path', { d: avg, class: 'data-line', stroke: l.color }));
        }
      }
      if (!dense) for (const p of l.points) svg.append(svgEl('circle', { cx: X(+p.d), cy: Y(p.v), r: 4, class: 'dot', fill: l.color }));
    }
    if (dense) {
      const key = svgEl('text', { x: m.left + 6, y: m.top + 10, class: 'band-label' });
      key.textContent = 'thin: daily · bold: 7-day average';
      svg.append(key);
    }

    const cross = svgEl('line', { y1: m.top, y2: H - m.bottom, class: 'crosshair', visibility: 'hidden' });
    const marks = prepared.map(l => svgEl('circle', { r: 6, class: 'focus-dot', fill: l.color, visibility: 'hidden' }));
    svg.append(cross, ...marks);
    container.append(svg);

    // Readout: snaps to the nearest date, lists every series at that date.
    const dates = [...new Set(pts.map(p => +p.d))].sort((a, b) => a - b);
    const tip = el('div', { class: 'chart-tip', hidden: '' });
    container.append(tip);
    let index = -1;
    const show = (i, px) => {
      index = Math.max(0, Math.min(dates.length - 1, i));
      const t = dates[index];
      cross.setAttribute('x1', X(t)); cross.setAttribute('x2', X(t)); cross.setAttribute('visibility', 'visible');
      tip.replaceChildren();
      let sameDay = 1;
      prepared.forEach((l, li) => {
        // Clinic records can have several readings on one date with no time; list them all.
        const day = l.points.filter(q => +q.d === t);
        marks[li].setAttribute('visibility', day.length ? 'visible' : 'hidden');
        if (!day.length) return;
        sameDay = Math.max(sameDay, day.length);
        marks[li].setAttribute('cx', X(t)); marks[li].setAttribute('cy', Y(day[day.length - 1].v));
        tip.append(el('div', { class: 'tip-row' }, el('i', { style: `background:${l.color}` }),
          el('strong', {}, `${day.map(q => fmt(q.v, decimals)).join(', ')} ${unit}`), prepared.length > 1 ? el('span', {}, l.label) : null));
        if (dense && prepared.length === 1) tip.append(el('div', { class: 'tip-sub' }, `7-day average ${fmt(day[0].avg, decimals)}`));
      });
      if (sameDay > 1) tip.append(el('div', { class: 'tip-sub' }, `${sameDay} readings this day, in the order the record lists them (no times given)`));
      const p = pts.find(q => +q.d === t);
      tip.append(el('div', { class: 'tip-sub' }, fmtDate(new Date(t), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })));
      tip.append(el('div', { class: 'tip-sub' }, SOURCES[p.source] || p.source));
      if (p.note && sameDay === 1) tip.append(el('div', { class: 'tip-sub' }, p.note));  // per-reading notes would only describe the first
      if (p.doc && canViewSource(p.doc)) {
        const link = el('button', { type: 'button', class: 'tip-link' }, `View source${p.page ? ` · page ${p.page}` : ''} →`);
        link.addEventListener('click', e => { e.stopPropagation(); chart.openDoc(p.doc, p.page); });
        tip.append(link);
      }
      tip.hidden = false;
      // Inside the plot (sticky headers never cover it) and clear of both the crosshair and the
      // finger, so the tap that opened it can't land on "View source".
      const near = Math.min(X(t), px ?? X(t)), far = Math.max(X(t), px ?? X(t));
      const rightSide = far + 14 + tip.offsetWidth <= W && (near - 14 - tip.offsetWidth < 0 || far < W / 2);
      tip.style.left = `${rightSide ? far + 14 : Math.max(0, near - 14 - tip.offsetWidth)}px`;
    };
    const hide = () => { index = -1; tip.hidden = true; cross.setAttribute('visibility', 'hidden'); marks.forEach(mk => mk.setAttribute('visibility', 'hidden')); };
    const local = clientX => clientX - svg.getBoundingClientRect().left;
    const nearest = clientX => {
      const t = x0 + ((clientX - svg.getBoundingClientRect().left - m.left) / (W - m.left - m.right)) * (x1 - x0);
      let best = 0;
      dates.forEach((d, i) => { if (Math.abs(d - t) < Math.abs(dates[best] - t)) best = i; });
      return best;
    };
    svg.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') show(nearest(e.clientX), local(e.clientX)); });
    svg.addEventListener('pointerdown', e => show(nearest(e.clientX), local(e.clientX)));
    // Focus without the browser scrolling the chart (a scroll mid-tap reads as the pointer leaving).
    svg.addEventListener('mousedown', e => { e.preventDefault(); svg.dataset.pointer = ''; svg.focus({ preventScroll: true }); });
    svg.addEventListener('touchstart', () => { svg.dataset.pointer = ''; }, { passive: true });
    // Leaving the chart onto its own tooltip keeps it open, so "View source" stays clickable.
    container.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
    svg.addEventListener('keydown', e => {
      delete svg.dataset.pointer;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show(index < 0 ? dates.length - 1 : index + (e.key === 'ArrowRight' ? 1 : -1)); }
      if (e.key === 'Escape') hide();
    });
    svg.addEventListener('blur', () => setTimeout(() => { if (!container.contains(document.activeElement)) hide(); }, 0));
    document.addEventListener('pointerdown', e => { if (!container.contains(e.target)) hide(); }, { signal });
  }

  function splitOnGaps(points, maxGapDays) {
    const out = [];
    for (const p of points) {
      const seg = out[out.length - 1];
      if (seg && (p.d - seg[seg.length - 1].d) / DAY <= maxGapDays) seg.push(p); else out.push([p]);
    }
    return out;
  }

  function niceTicks(lo, hi, count) {
    const raw = (hi - lo) / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw);
    const ticks = [];
    for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.999; v += step) ticks.push(Number(v.toFixed(10)));
    return ticks;
  }

  function timeTicks(x0, x1, width) {
    const spanDays = (x1 - x0) / DAY;
    const maxTicks = Math.max(2, Math.floor(width / 70));
    const stepMonths = [1, 2, 3, 6, 12, 24, 60].find(s => spanDays / 30.4 / s <= maxTicks) || 120;
    const out = [];
    if (spanDays <= 45) {
      const stepDays = Math.ceil(spanDays / maxTicks / 7) * 7 || 7;
      for (let t = x0 + DAY; t < x1; t += stepDays * DAY) out.push({ d: new Date(t), label: fmtDate(new Date(t), { month: 'short', day: 'numeric' }) });
      return out;
    }
    const d = new Date(x0); d.setDate(1); d.setHours(12, 0, 0, 0); d.setMonth(d.getMonth() + 1);
    while (d.getMonth() % stepMonths && stepMonths <= 12) d.setMonth(d.getMonth() + 1);
    for (; +d < x1; d.setMonth(d.getMonth() + stepMonths)) {
      out.push({ d: new Date(d), label: d.getMonth() === 0 || stepMonths >= 12 ? String(d.getFullYear()) : fmtDate(d, { month: 'short' }) });
    }
    return out;
  }

  function drawWhenSized(container, draw) {
    let lastWidth = 0;
    const ro = new ResizeObserver(() => {
      if (!container.isConnected) { ro.disconnect(); return; }
      if (container.clientWidth && container.clientWidth !== lastWidth) { lastWidth = container.clientWidth; draw(); }
    });
    ro.observe(container);
  }

  // ---------- table twin ----------
  function tableToggle(lines, unit, decimals) {
    const wrap = el('div', { class: 'table-toggle' });
    const button = el('button', { type: 'button', class: 'text-button', 'aria-expanded': 'false' }, 'Show readings as a table');
    const holder = el('div', { class: 'reading-table', hidden: '' });
    button.addEventListener('click', () => {
      const open = holder.hidden;
      holder.hidden = !open;
      button.setAttribute('aria-expanded', open);
      button.textContent = open ? 'Hide table' : 'Show readings as a table';
      if (open && !holder.firstChild) holder.append(readingTable(lines, unit, decimals));
    });
    wrap.append(button, holder);
    return wrap;
  }

  function readingTable(lines, unit, decimals) {
    const byDate = new Map();
    lines.forEach((l, i) => l.points.forEach(p => {
      const key = `${p.t.slice(0, 10)}#${p.seq || 0}`;
      const row = byDate.get(key) || { d: p.d, seq: p.seq || 0, values: [], src: p, keys: [] };
      row.values[i] = p.v;
      row.keys.push(p._key);
      byDate.set(key, row);
    }));
    const table = el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Date'),
      ...lines.map(l => el('th', { class: 'num' }, `${lines.length > 1 ? l.label : 'Value'} (${unit})`)), el('th', {}, 'Source'), el('th', { class: 'owner-only' }, ''))));
    const tbody = el('tbody');
    [...byDate.values()].sort((a, b) => b.d - a.d || a.seq - b.seq).forEach(row => {
      const src = el('td', {}, SOURCES[row.src.source] || row.src.source);
      if (row.src.doc && canViewSource(row.src.doc)) {
        const b = el('button', { type: 'button', class: 'text-button' }, ` · page ${row.src.page || 1} →`);
        b.addEventListener('click', () => chart.openDoc(row.src.doc, row.src.page));
        src.append(b);
      }
      const action = el('td', {});
      const remove = el('button', { type: 'button', class: 'text-button owner-only' }, 'Delete result');
      remove.addEventListener('click', () => chart.preparation.deleteRow('measurements', { sources: row.keys.map(_key => ({ _key })) }, chart.reloadVitals));
      action.append(remove);
      const valueCells = lines.map((line, i) => {
        const cell = el('td', { class: 'num' }, row.values[i] == null ? '—' : fmt(row.values[i], decimals));
        const point = line.points.find(p => p.t.slice(0, 10) === row.d.toISOString().slice(0, 10) && (p.seq || 0) === row.seq);
        if (point) {
          const edit = el('button', { type: 'button', class: 'text-button owner-only' }, 'Edit');
          edit.addEventListener('click', () => chart.preparation.editRecord('measurements', {
            ...point, metric: line.key, taken_at: point.t, value: String(point.v), _key: point._key,
          }));
          cell.append(edit);
        }
        return cell;
      });
      tbody.append(el('tr', {}, el('td', {}, fmtDate(row.d)), ...valueCells, src, action));
    });
    table.append(tbody);
    return table;
  }

  // ---------- menstrual cycle ----------
  function cycleCard(data, start, end) {
    const cycles = data.cycles.map(c => ({ ...c, s: parse(c.start), e: c.end ? parse(c.end) : null }));
    const withLength = cycles.slice(0, -1).map((c, i) => ({ ...c, length: Math.round((cycles[i + 1].s - c.s) / DAY) }));
    const recent = withLength.slice(-6);
    const periodDays = cycles.filter(c => c.e).slice(-6).map(c => Math.round((c.e - c.s) / DAY) + 1);
    const last = cycles[cycles.length - 1];
    const cycleDay = Math.floor((new Date().setHours(12, 0, 0, 0) - last.s) / DAY) + 1;

    const card = el('article', { class: 'vital-card cycle-card', id: 'vital-cycle' });
    card.append(el('div', { class: 'vital-head' }, el('div', {}, el('h2', {}, 'Menstrual cycle'),
      el('p', { class: 'vital-meta' }, `${cycles.length} periods recorded since ${fmtDate(cycles[0].s, { month: 'short', year: 'numeric' })}`))));

    const tile = (label, value, sub) => el('div', { class: 'stat-tile' }, el('p', { class: 'eyebrow' }, label), el('div', { class: 'stat-value' }, value), el('p', { class: 'vital-meta' }, sub));
    card.append(el('div', { class: 'stat-row' },
      tile('Last period started', fmtDate(last.s, { month: 'short', day: 'numeric' }), `Cycle day ${cycleDay} today`),
      recent.length ? tile('Typical cycle', `${median(recent.map(c => c.length))} days`,
        `Range ${Math.min(...recent.map(c => c.length))}–${Math.max(...recent.map(c => c.length))} over last ${recent.length}`) : null,
      periodDays.length ? tile('Typical period', `${median(periodDays)} days`, `Range ${Math.min(...periodDays)}–${Math.max(...periodDays)}`) : null));

    const shown = cycles.filter(c => !start || (c.e || c.s) >= start);
    if (!shown.length) {
      card.append(el('p', { class: 'vital-empty' }, 'No periods in this range. ', rangeButton('Show all', 'all')));
      // Historical rows may fall outside the selected chart range but remain editable in Prepare.
      card.append(cycleTable(cycles, withLength));
      return card;
    }
    card.append(el('p', { class: 'eyebrow chart-label' }, 'Periods'));
    const strip = el('div', { class: 'plot strip' });
    card.append(strip);
    drawWhenSized(strip, () => periodStrip(strip, shown, start, end));

    const lengths = withLength.filter(c => !start || c.s >= start);
    if (lengths.length > 1) {
      card.append(el('p', { class: 'eyebrow chart-label' }, 'Cycle length (days from one period start to the next)'));
      const plot = el('div', { class: 'plot' });
      card.append(plot);
      const points = lengths.map(c => ({ t: c.start, d: c.s, v: c.length, source: c.source, doc: c.doc, page: c.page, note: c.note }));
      const lines = [{ label: 'Cycle length', color: 'var(--series-1)', points }];
      drawWhenSized(plot, () => lineChart(plot, { lines, unit: 'days', decimals: 0, range: [21, 35], start, end }));
    }
    card.append(cycleTable(cycles, withLength));
    card.append(sourceLine(cycles));
    return card;
  }

  function periodStrip(container, cycles, start, end) {
    container.replaceChildren();
    const signal = freshSignal(container);
    const W = container.clientWidth, H = 56, m = { left: 8, right: 8 };
    const x0 = start ? +start : +cycles[0].s - 7 * DAY;
    const x1 = Math.max(+end, ...cycles.map(c => +(c.e || c.s))) + DAY;
    const X = t => m.left + ((t - x0) / (x1 - x0)) * (W - m.left - m.right);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart-svg', role: 'img',
      'aria-label': `${cycles.length} periods in this range` });
    svg.append(svgEl('line', { x1: m.left, x2: W - m.right, y1: 20, y2: 20, class: 'grid' }));
    for (const t of timeTicks(x0, x1, W)) {
      svg.append(svgEl('line', { x1: X(+t.d), x2: X(+t.d), y1: 8, y2: 32, class: 'grid' }));
      const label = svgEl('text', { x: X(+t.d), y: H - 6, class: 'tick', 'text-anchor': 'middle' });
      label.textContent = t.label;
      svg.append(label);
    }
    const tip = el('div', { class: 'chart-tip', hidden: '' });
    for (const c of cycles) {
      const xa = X(Math.max(+c.s, x0)), xb = X(+(c.e || c.s) + DAY);
      const bar = svgEl('rect', { x: xa, y: 12, width: Math.max(xb - xa - 2, 4), height: 16, rx: 4, class: 'period-bar', tabindex: 0 });
      const hit = svgEl('rect', { x: xa - 8, y: 0, width: Math.max(xb - xa, 4) + 16, height: 40, fill: 'transparent' });
      const open = e => {
        e?.stopPropagation();
        const days = c.e ? Math.round((c.e - c.s) / DAY) + 1 : null;
        tip.replaceChildren(el('div', { class: 'tip-row' }, el('strong', {}, days ? `${days} days` : 'Start only')),
          el('div', { class: 'tip-sub' }, `${fmtDate(c.s)}${c.e ? ` – ${fmtDate(c.e, { month: 'short', day: 'numeric' })}` : ''}`),
          el('div', { class: 'tip-sub' }, SOURCES[c.source] || c.source));
        if (c.doc && canViewSource(c.doc)) {
          const link = el('button', { type: 'button', class: 'tip-link' }, `View source${c.page ? ` · page ${c.page}` : ''} →`);
          link.addEventListener('click', ev => { ev.stopPropagation(); chart.openDoc(c.doc, c.page); });
          tip.append(link);
        }
        tip.hidden = false;
        tip.style.left = `${Math.min(Math.max(xa, 0), W - tip.offsetWidth)}px`;
      };
      hit.addEventListener('pointerdown', open);
      bar.addEventListener('pointerdown', open);
      bar.addEventListener('focus', () => open());
      hit.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') open(); });
      svg.append(bar, hit);
    }
    container.append(svg, tip);
    document.addEventListener('pointerdown', e => { if (!container.contains(e.target)) tip.hidden = true; }, { signal });
  }

  function cycleTable(cycles, withLength) {
    const lengthByStart = new Map(withLength.map(c => [c.start, c.length]));
    const wrap = el('div', { class: 'table-toggle' });
    const button = el('button', { type: 'button', class: 'text-button', 'aria-expanded': 'false' }, chart.mode === 'owner' ? 'Edit period dates' : 'Show periods as a table');
    document.addEventListener('chart:mode', () => {
      button.textContent = holder.hidden ? (chart.mode === 'owner' ? 'Edit period dates' : 'Show periods as a table') : 'Hide table';
    });
    const holder = el('div', { class: 'reading-table', hidden: '' });
    button.addEventListener('click', () => {
      const open = holder.hidden;
      holder.hidden = !open;
      button.setAttribute('aria-expanded', open);
      button.textContent = open ? 'Hide table' : (chart.mode === 'owner' ? 'Edit period dates' : 'Show periods as a table');
      if (!open || holder.firstChild) return;
      const tbody = el('tbody');
    [...cycles].reverse().forEach(c => {
      const actions = el('td', {});
      const edit = el('button', { type: 'button', class: 'text-button owner-only' }, 'Edit');
      edit.addEventListener('click', () => chart.preparation.editRecord('cycles', c));
      actions.append(edit);
      const remove = el('button', { type: 'button', class: 'text-button owner-only' }, 'Delete');
      remove.addEventListener('click', () => chart.preparation.deleteRow('cycles', c, chart.reloadVitals));
      actions.append(remove);
      tbody.append(el('tr', {},
        el('td', {}, fmtDate(c.s)), el('td', {}, c.e ? fmtDate(c.e) : '—'),
        el('td', { class: 'num' }, c.e ? String(Math.round((c.e - c.s) / DAY) + 1) : '—'),
        el('td', { class: 'num' }, lengthByStart.has(c.start) ? String(lengthByStart.get(c.start)) : '—'), actions));
    });
      holder.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Started'), el('th', {}, 'Ended'),
        el('th', { class: 'num' }, 'Period days'), el('th', { class: 'num' }, 'Cycle length'))), tbody));
    });
    wrap.append(button, holder);
    return wrap;
  }

  // Shared with labs.js so every trend chart behaves the same way.
  window.chartKit = { lineChart, drawWhenSized, tableToggle, el, parse, fmt, fmtDate, SOURCES };

  // ---------- boot ----------
  syncFilters();
  const start = () => { if (!state.loaded) { state.loaded = true; load(); } };
  document.addEventListener('chart:tab', e => { if (e.detail === 'vitals') start(); });
  if (section.classList.contains('active')) start();
})();
