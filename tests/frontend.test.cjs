const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function environment(data = {}) {
  const { document, window } = parseHTML(`<html><body>
    ${['history', 'family', 'medications', 'documents', 'genetics'].map(id => `<section id="${id}"><div class="page-heading"></div><article class="preparation-section"><textarea>Unsaved ${id} draft</textarea></article><div class="starter">Starter content</div></section>`).join('')}
    <section id="goals"><input class="visit-date"><button class="close-visit"></button><div class="goal-list priority-list" data-key="items" data-label="priority" data-empty="No priorities"></div><div class="goal-list" data-key="questions" data-label="question" data-empty="No questions"></div><div class="visit-history"></div><div class="issues-list"></div><script id="goals-data" type="application/json">${JSON.stringify(data.goals || { items: [], questions: [] })}</script></section>
    <nav><button data-tab="documents"><em>0</em></button><button class="nav-item" data-tab="goals"></button></nav>
  </body></html>`);
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) if (value != null) node.setAttribute(key, value);
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  };
  const openedSources = [];
  const chart = { mode: 'owner', openDoc: (document, page) => openedSources.push([document, page]), renderLabs() {}, toast() {} };
  const includedSources = new Set(data.includedSources || []);
  const requests = [];
  const clinical = { documents: [], events: [], diagnoses: [], allergies: [], medications: [], family_history: [], clinical_genetics: [], lab_results: [], ...data };
  const context = vm.createContext({ document, window, chart, confirm: () => true,
    fetch: async (url, options = {}) => {
      if (url === '/api/goals') {
        const payload = JSON.parse(options.body); requests.push(payload);
        return { ok: true, json: async () => payload };
      }
      return { ok: true, json: async () => url === '/api/genetics' ? { findings: [], sources: [] } : clinical };
    }
  });
  window.chartKit = { el, fmtDate: date => date.toISOString().slice(0, 10), parse: value => new Date(value) };
  const run = name => vm.runInContext(readFileSync(`static/${name}.js`, 'utf8'), context);
  run('clinical-ui');
  run('record-groups');
  chart.preparation = {
    renderDeleted() {},
    isSourceIncluded: filename => includedSources.has(filename),
    canViewSource: filename => chart.mode !== 'provider' || includedSources.has(filename),
    setSourceIncluded: async (filename, included) => {
      included ? includedSources.add(filename) : includedSources.delete(filename);
      document.dispatchEvent(new window.Event('chart:sourceSelection'));
    },
    addButton: (_table, label = 'Add') => el('button', {}, label),
    familyMemberDetails: relation => el('div', { class: 'family-member-facts' }, relation),
    decorate: (container, table, row) => {
      container.append(el('button', { 'data-key': row._key, class: 'edit-record' }, 'Edit / add notes'));
    }
  };
  return { chart, document, run, context, window, openedSources, requests };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('Issues starts with visit priorities and saves the three structured details', async () => {
  const { chart, document, run, window, requests } = environment({ goals: {
    items: [{ priority: 1, doing: 'Labs ordered', goal: 'Understand fatigue', direction: 'Discuss next steps' }], questions: []
  } });
  run('goals');
  const priority = document.querySelector('.priority-card');
  assert.equal(priority.querySelector('.priority-heading'), null, 'the card has no duplicate large priority heading');
  assert.deepEqual([...priority.querySelectorAll('.priority-field>span')].map(node => node.textContent), [
    'Priority 1', 'Goal', 'Requested clinical direction'
  ]);
  const goal = priority.querySelector('[aria-label="Goal"]');
  assert.equal(goal.value, 'Understand fatigue');
  goal.value = 'Find the cause of fatigue';
  goal.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(chart.hasUnsavedPreparation(), true);
  priority.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settled();
  assert.equal(requests.at(-1).current_visit.items[0].goal, 'Find the cause of fatigue');
  assert.equal(requests.at(-1).current_visit.items[0].doing, 'Labs ordered');
  assert.equal(requests.at(-1).current_visit.items[0].direction, 'Discuss next steps');
  assert.equal(requests.at(-1).current_visit.items[0].priority, 1);
  assert.equal(chart.hasUnsavedPreparation(), false);
});

test('Closing a visit archives its priorities and carries unaddressed ones forward', async () => {
  const { document, run, window, requests } = environment({ goals: {
    current_visit: { date: '', items: [
      { doing: 'Lab ordered', goal: 'Understand results', direction: 'Review options', addressed: true },
      { doing: '', goal: 'Discuss pain', direction: 'Plan follow-up', addressed: false }
    ], questions: ['What next?'] }, visits: [], issues: []
  } });
  run('goals');
  const date = document.querySelector('.visit-date');
  date.value = '2026-10-19'; date.dispatchEvent(new window.Event('change'));
  await settled();
  document.querySelector('.close-visit').dispatchEvent(new window.Event('click'));
  await settled();
  const saved = requests.at(-1);
  assert.equal(saved.visits.length, 1);
  assert.equal(saved.visits[0].date, '2026-10-19');
  assert.equal(saved.visits[0].items[0].addressed, true);
  assert.deepEqual(saved.current_visit.items.map(item => item.goal), ['Discuss pain']);
  assert.deepEqual(saved.current_visit.questions, []);
  assert.equal(document.querySelectorAll('.visit-history-entry').length, 1);
});

test('Ongoing issues can be added and promoted to current visit priorities', async () => {
  const { document, run, requests, window } = environment();
  run('goals');
  const form = document.querySelector('.issue-new-form');
  form.querySelector('[aria-label="New issue"]').value = 'Recurring headaches';
  form.querySelector('[aria-label="New issue details"]').value = 'Track frequency and severity';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settled();
  assert.deepEqual(requests.at(-1).issues[0], { title: 'Recurring headaches', detail: 'Track frequency and severity' });
  document.querySelector('.ongoing-issue .issue-actions .outline-button').click();
  await settled();
  assert.equal(requests.at(-1).current_visit.items[0].goal, 'Recurring headaches');
});

test('Documents and Genetics retain preparation content during initial and repeated rendering', async () => {
  const { chart, document, run } = environment({
    documents: [{ document: 'sample.pdf', title: 'Sample report', date: '2025-01-01', kind: 'genetic', summary: 'The report describes the test findings and recommended follow-up.' }],
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
      if (id === 'documents') {
        assert.equal(document.querySelector('.record-summary-label').textContent, 'At a glance');
        assert.equal(document.querySelector('.record-summary').textContent, 'The report describes the test findings and recommended follow-up.');
      }
    }
    await chart.reloadClinical();
    await settled();
  }
});

test('Provider view shows only flagged source documents and Prepare can select them', async () => {
  const { chart, document, run, window, openedSources } = environment({
    documents: [
      { document: 'selected.pdf', title: 'Selected report' },
      { document: 'unselected.pdf', title: 'Unselected report' }
    ],
    medications: [{ name: 'Sample medicine', document: 'unselected.pdf', _key: 'medicine' }]
  });
  run('history'); run('records'); await settled();
  const docs = [...document.querySelectorAll('#documents .document-entry')];
  assert.equal(docs.length, 2);
  assert.equal(docs.find(entry => entry.dataset.providerDocument === 'unselected.pdf').querySelector('.source-inclusion input').checked, false);
  const checkbox = docs.find(entry => entry.dataset.providerDocument === 'unselected.pdf').querySelector('.source-inclusion input');
  chart.mode = 'provider';
  document.dispatchEvent(new window.Event('chart:mode'));
  assert.equal(docs.every(entry => entry.hidden), true);
  assert.equal(document.querySelector('.provider-sources-empty').hidden, false);
  chart.mode = 'owner';
  document.dispatchEvent(new window.Event('chart:mode'));
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event('change'));
  await settled();
  chart.mode = 'provider';
  document.dispatchEvent(new window.Event('chart:mode'));
  assert.equal(docs.find(entry => entry.dataset.providerDocument === 'selected.pdf').hidden, true);
  assert.equal(docs.find(entry => entry.dataset.providerDocument === 'unselected.pdf').hidden, false);
  assert.equal(document.querySelector('#medications .source-link').classList.contains('owner-only'), false);
  assert.equal(chart.clinicalUI.canViewSource('unselected.pdf'), true);
  chart.clinicalUI.sourceButton('selected.pdf').click();
  assert.deepEqual(openedSources, []);
  chart.clinicalUI.sourceButton('unselected.pdf', 3).click();
  assert.deepEqual(openedSources, [['unselected.pdf', 3]]);
});

test('Family history renders one expandable profile per relative with their own conditions', async () => {
  const { document, run } = environment({ family_history: [
    { relation: 'Dad', condition: 'Diabetes', _key: 'dad-diabetes' },
    { relation: 'Maternal grandparent (unspecified)', condition: 'Heart disease', _key: 'unspecified-heart' },
    { relation: 'Mom', condition: 'Asthma', document: 'family.pdf', _key: 'mom-asthma' },
    { relation: 'Mother', condition: 'Migraine', _key: 'mother-migraine' },
    { relation: 'Brother', condition: 'Seizures', _key: 'brother-seizures' },
    { relation: 'Maternal Grandmother', condition: 'Osteoporosis', _key: 'maternal-grandmother-osteoporosis' }
  ] });
  run('history'); run('records'); await settled();
  const profiles = [...document.querySelectorAll('#family .family-profile')];
  assert.equal(profiles.length, 5);
  assert.deepEqual(profiles.map(profile => profile.querySelector('.family-profile-name').textContent), [
    'Mother', 'Father', 'Brother', 'Maternal Grandmother', 'Maternal grandparent (unspecified)'
  ]);
  const mother = profiles[0];
  const dad = profiles[1];
  assert.deepEqual([...mother.querySelectorAll('.family-condition h2')].map(node => node.textContent), ['Asthma', 'Migraine']);
  assert.deepEqual([...dad.querySelectorAll('.family-condition h2')].map(node => node.textContent), ['Diabetes']);
  assert.equal(mother.querySelectorAll('.family-condition .edit-record').length, 2);
  assert.equal(mother.querySelectorAll('.family-condition .family-delete').length, 2);
  assert.equal(mother.querySelectorAll('.family-condition .eyebrow').length, 0, 'the profile already provides the family-history context');
  assert.equal(mother.querySelectorAll('.source-link').length, 0);
  assert.equal([...mother.querySelectorAll('.family-profile-content button')].at(-1).textContent, 'Add condition');
  assert.ok(mother.querySelector('.family-move').textContent.includes('Move to another member'));
  assert.ok(mother.querySelector('.family-member-facts'));
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
    assert.equal(document.querySelectorAll(`#${section} .patient-label`).length, 0);
    assert.equal(document.querySelectorAll(`#${section} .edit-record[data-key="imported-old"]`).length, 0);
    if (section === 'history') assert.ok(document.querySelector(`#${section} .condition-sources`).textContent.includes('2 source records'));
  });
}

test('Family member details save DOB and deceased status independently of conditions', async () => {
  const env = editorEnvironment();
  const { chart, document } = env;
  const facts = chart.preparation.familyMemberDetails('Mother');
  document.body.append(facts);
  facts.querySelector('[aria-label="Mother date of birth"]').value = '1970-02-03';
  facts.querySelector('[aria-label="Mother deceased"]').checked = true;
  facts.querySelector('[aria-label="Mother date of death"]').value = '2024-01-09';
  facts.querySelector('form').dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
  await settled();
  assert.deepEqual(env.requests.at(-1), {
    url: '/api/preparation/family-members', method: 'PUT',
    body: { relation: 'Mother', fields: { dob: '1970-02-03', deceased: true, date_of_death: '2024-01-09' } }
  });
});

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

test('Patient notes stay quiet without separate source-detail panels', () => {
  const { chart, document } = editorEnvironment();
  const card = document.createElement('article'); document.body.append(card);
  chart.preparation.decorate(card, 'family_history', {
    condition: 'Asthma', _patient_updated: true, _patient_note: 'Symptoms improved after treatment.',
    _original: { condition: 'Asthma, reported in childhood' }, _key: 'mom-asthma'
  });
  const update = card.querySelector('.family-patient-update');
  assert.ok(update);
  assert.equal(update.hasAttribute('open'), false, 'the update is collapsed by default');
  assert.equal(update.querySelector('summary').textContent, 'Note');
  assert.ok(update.textContent.includes('Symptoms improved after treatment.'));
  assert.equal(card.querySelector('details.original-record'), null);
  assert.ok(card.querySelector('.edit-record'));
  const diagnosis = document.createElement('article'); document.body.append(diagnosis);
  chart.preparation.decorate(diagnosis, 'diagnoses', { name: 'Example condition', _patient_updated: true, _original: { name: 'Old value' }, _key: 'condition' });
  assert.equal(diagnosis.querySelector('.patient-label').textContent, 'Note');
  assert.equal(diagnosis.querySelector('details'), null);
});

test('Medical record edit changes the page summary without offering source-record deletion', async () => {
  const env = editorEnvironment();
  const { chart, document, dialog, requests } = env;
  const card = document.createElement('article'); document.body.append(card);
  chart.preparation.decorate(card, 'documents', {
    document: 'visit.pdf', title: 'Visit note', date: '2025-01-02', provider: 'Clinic',
    clinician: 'Dr. Example', kind: 'visit', summary: 'Original summary', _key: 'document-key'
  });
  card.querySelector('.edit-record').click();
  assert.equal(dialog.open, true);
  assert.equal(card.querySelector('.edit-record').textContent, 'Edit summary');
  assert.equal(dialog.querySelector('#record-editor-title').textContent, 'Edit medical record summary');
  assert.equal(dialog.querySelector('.danger-button'), null);
  for (const [label, value] of [['Summary shown on the Medical records page', 'New concise summary'], ['Notes for the provider', 'Review this report']]) {
    const field = [...dialog.querySelectorAll('label')].find(node => node.textContent.includes(label)).querySelector('input, textarea');
    field.value = value;
  }
  dialog.querySelector('form').dispatchEvent(new env.window.Event('submit', { cancelable: true }));
  await settled();
  const saved = requests.find(request => request.url.includes('/entries/documents/'));
  assert.ok(saved);
  assert.equal(saved.body.fields.summary, 'New concise summary');
  assert.deepEqual(Object.keys(saved.body.fields), ['summary']);
  assert.equal(saved.body.notes, 'Review this report');
});

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

test('Adding a family history item from a profile keeps that relative preselected', async () => {
  const env = editorEnvironment();
  const { chart, dialog, window } = env;
  chart.preparation.addButton('family_history', 'Add condition', { relation: 'Mom' }).click();
  assert.match(dialog.querySelector('h2').textContent, /Mom/);
  assert.equal(dialog.querySelector('input').value, 'Mom');
  dialog.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settled();
  assert.equal(env.requests.at(-1).url, '/api/preparation/entries/family_history');
  assert.deepEqual(env.requests.at(-1).body, { fields: { relation: 'Mom', condition: '' }, notes: '' });
});

test('Moving a family history condition changes its relative and preserves edits and notes', async () => {
  const env = editorEnvironment();
  const { chart } = env;
  await chart.preparation.moveFamilyRow({
    _key: 'source-condition', relation: 'Maternal grandparent (unspecified)', condition: 'Arrhythmia',
    _original: { relation: 'Maternal grandparent (unspecified)', condition: 'Heart condition' },
    _patient_note: 'Confirmed with family'
  }, 'Mother');
  assert.deepEqual(env.requests[0], {
    url: '/api/preparation/entries/family_history/source-condition', method: 'PUT',
    body: { fields: { relation: 'Mother', condition: 'Arrhythmia' }, notes: 'Confirmed with family' }
  });
  assert.equal(env.toast, 'Condition moved to Mother.');
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
