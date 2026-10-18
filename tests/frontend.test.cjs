const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function environment(data = {}) {
  const { document, window } = parseHTML(`<html><body>
    ${['history', 'family', 'medications', 'documents', 'genetics'].map(id => `<section id="${id}"><div class="page-heading"></div><article class="preparation-section"><textarea>Unsaved ${id} draft</textarea></article><div class="starter">Starter content</div></section>`).join('')}
    <nav><button data-tab="documents"><em>0</em></button></nav>
  </body></html>`);
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) if (value != null) node.setAttribute(key, value);
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  };
  const chart = { openDoc() {}, renderLabs() {} };
  const clinical = { documents: [], events: [], diagnoses: [], allergies: [], medications: [], family_history: [], clinical_genetics: [], lab_results: [], ...data };
  const context = vm.createContext({ document, window, chart,
    fetch: async url => ({ ok: true, json: async () => url === '/api/genetics' ? { findings: [], sources: [] } : clinical })
  });
  window.chartKit = { el, fmtDate: date => date.toISOString().slice(0, 10), parse: value => new Date(value) };
  const run = name => vm.runInContext(readFileSync(`static/${name}.js`, 'utf8'), context);
  run('clinical-ui');
  run('record-groups');
  chart.preparation = {
    renderDeleted() {},
    addButton: () => el('button', {}, 'Add'),
    decorate: (container, table, row) => {
      if (row._manual) container.append(el('p', { class: 'patient-label' }, 'Patient-entered'));
      container.append(el('button', { 'data-key': row._key, class: 'edit-record' }, 'Edit / add notes'));
    }
  };
  return { chart, document, run, context, window };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('Documents and Genetics retain preparation content during initial and repeated rendering', async () => {
  const { chart, document, run } = environment({
    documents: [{ document: 'sample.pdf', title: 'Sample report', date: '2025-01-01', kind: 'genetic' }],
    clinical_genetics: [{ document: 'sample.pdf', test: 'Sample genetic test', gene: 'EXAMPLE', page: 2 }]
  });
  const hosts = ['documents', 'genetics'].map(id => document.querySelector(`#${id} .preparation-section`));
  run('history');
  run('records');
  await settled();
  for (let pass = 0; pass < 2; pass++) {
    for (const [i, id] of ['documents', 'genetics'].entries()) {
      assert.ok(document.querySelector(`#${id} .preparation-section`) === hosts[i], `${id} keeps the original preparation host`);
      assert.equal(hosts[i].querySelector('textarea').value, `Unsaved ${id} draft`);
      assert.ok(document.querySelector(`#${id} .data-body`).textContent.includes(id === 'documents' ? 'Sample report' : 'EXAMPLE'));
    }
    await chart.reloadClinical();
    await settled();
  }
});

for (const [table, section, selector] of [['diagnoses', 'history', '.history-entry'], ['medications', 'medications', '.medication-row']]) {
  test(`${table}: same-name manual entries stay visible and individually editable`, async () => {
    const rows = [
      { name: 'Sample name', date: '2025-01-01', document: 'source.pdf', page: 1, status: 'active', _key: 'imported-old' },
      { name: 'Sample name', date: '2026-01-01', document: 'source.pdf', page: 2, status: 'active', _key: 'imported-latest' },
      { name: 'sample NAME', date: null, status: 'active', _manual: true, _key: 'manual-undated' },
      { name: 'Sample name', date: '2024-01-01', status: 'active', _manual: true, _key: 'manual-dated' },
      { name: 'Sample name', date: null, status: 'active', _manual: true, _key: 'manual-second' }
    ];
    const { chart, document, run } = environment({ [table]: rows });
    run('history');
    if (section === 'history') chart.renderHistory({ events: [], diagnoses: rows, allergies: [] });
    else { run('records'); await settled(); }
    const cards = [...document.querySelectorAll(`#${section} ${selector}`)];
    assert.equal(cards.length, 4, 'One latest imported summary plus all three manual entries');
    for (const key of ['imported-latest', 'manual-undated', 'manual-dated', 'manual-second']) {
      assert.equal(document.querySelectorAll(`#${section} .edit-record[data-key="${key}"]`).length, 1);
    }
    assert.equal(document.querySelectorAll(`#${section} .patient-label`).length, 3);
    assert.equal(document.querySelectorAll(`#${section} .edit-record[data-key="imported-old"]`).length, 0);
    if (section === 'history') assert.ok(document.querySelector(`#${section} .condition-sources`).textContent.includes('2 source records'));
  });
}

function editorEnvironment() {
  const env = environment();
  const { chart, document, run, context } = env;
  const bootstrap = document.createElement('script');
  bootstrap.id = 'preparation-data'; bootstrap.textContent = '{}';
  document.body.append(bootstrap);
  chart.mode = 'owner'; chart.toast = message => { env.toast = message; };
  chart.reloadClinical = async () => { env.refreshes++; return true; };
  env.refreshes = 0; env.requests = []; env.confirmed = true; env.failure = false;
  context.confirm = () => env.confirmed;
  context.fetch = async (url, options) => {
    env.requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return { ok: !env.failure, status: env.failure ? 500 : 200, json: async () => env.failure ? { error: 'Deletion failed' } : { ok: true } };
  };
  run('preparation');
  const dialog = document.querySelector('dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  env.dialog = dialog;
  return env;
}

test('Delete entry confirms, removes the complete source group, and preserves drafts on failure', async () => {
  const env = editorEnvironment();
  const { chart, document, dialog } = env;
  const card = document.createElement('article'); document.body.append(card);
  chart.preparation.decorate(card, 'diagnoses', { name: 'Sample condition', _key: 'latest', document: 'sample.pdf', sources: [{ _key: 'older' }, { _key: 'latest' }] });
  card.querySelector('.edit-record').click();
  const remove = dialog.querySelector('.danger-button');
  assert.equal(remove.textContent, 'Delete entry');
  env.confirmed = false; remove.click(); await settled();
  assert.equal(env.requests.length, 0);
  env.confirmed = true; env.failure = true;
  const name = dialog.querySelector('input'); name.value = 'Unsaved change';
  remove.click(); await settled();
  assert.equal(dialog.open, true);
  assert.equal(name.value, 'Unsaved change');
  assert.equal(remove.disabled, false);
  assert.ok(dialog.textContent.includes('Deletion failed'));
  assert.equal(env.refreshes, 0);
  env.failure = false; remove.click(); await settled();
  assert.deepEqual(env.requests.at(-1), { url: '/api/preparation/entries/diagnoses', method: 'PATCH', body: { keys: ['older', 'latest'], deleted: true } });
  assert.equal(dialog.open, false);
  assert.equal(env.toast, 'Entry deleted.');
  assert.equal(env.refreshes, 1);
});

test('Deleted entries can be restored in Prepare and remain unavailable in Provider mode', async () => {
  const env = editorEnvironment();
  const { chart, document } = env;
  chart.preparation.renderDeleted({ deleted_entries: { medications: [
    { name: 'Sample medication', date: '2025-01-01', document: 'sample.pdf', _key: 'older' },
    { name: 'Sample medication', date: '2026-01-01', document: 'sample.pdf', _key: 'latest' },
    { name: 'Sample medication', _manual: true, _key: 'manual' }
  ] } });
  const list = document.querySelector('#medications .deleted-entries');
  assert.ok(list.classList.contains('owner-only'));
  assert.ok(list.textContent.includes('Deleted entries (2)'));
  const restore = list.querySelector('button');
  chart.mode = 'provider'; restore.click(); await settled();
  assert.equal(env.requests.length, 0);
  chart.mode = 'owner'; restore.click(); await settled();
  assert.deepEqual(env.requests[0].body, { keys: ['older', 'latest'], deleted: false });
  assert.equal(env.toast, 'Entry restored.');
  assert.equal(env.refreshes, 1);
});
