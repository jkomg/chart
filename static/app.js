const tabs = [...document.querySelectorAll('.nav-item')];
const panels = [...document.querySelectorAll('.tab-panel')];
const breadcrumb = document.querySelector('.breadcrumb');
const toast = document.querySelector('.toast');

// Every view has a URL hash (#vitals, #doc/<file>/<page>) so the browser's back button
// walks through what you looked at, including in and out of source documents.
window.chart = window.chart || {};
chart.lastTab = 'goals';

function activate(name, { scroll = true } = {}) {
  const tab = document.querySelector(`.nav-item[data-tab="${name}"]`);
  const panel = document.getElementById(name);
  if (!tab || !panel) return false;
  tabs.forEach(item => item.classList.toggle('active', item === tab));
  panels.forEach(item => item.classList.toggle('active', item === panel));
  const label = [...tab.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
  breadcrumb.innerHTML = `${breadcrumb.dataset.root} <span>/</span> <b>${label.toUpperCase()}</b>`;
  tab.scrollIntoView({ block: 'nearest', inline: 'center' });
  if (scroll) window.scrollTo({ top: 0 });
  chart.lastTab = name;
  document.dispatchEvent(new CustomEvent('chart:tab', { detail: name }));
  return true;
}

function route() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith('doc/')) {
    const [, file, page] = hash.match(/^doc\/(.+?)(?:\/(\d+))?$/) || [];
    document.dispatchEvent(new CustomEvent('chart:doc', { detail: { file, page: Number(page) || 1 } }));
    return;
  }
  document.dispatchEvent(new CustomEvent('chart:doc', { detail: null }));
  const [name, query] = hash.split('?');
  chart.query = new URLSearchParams(query || '');
  if (name !== chart.lastTab || !document.querySelector('.tab-panel.active')) activate(name || 'goals') || activate('goals');
}

chart.go = hash => { if (location.hash.slice(1) !== hash) location.hash = hash; };
chart.openDoc = (file, page) => chart.go(`doc/${encodeURIComponent(file)}${page ? `/${page}` : ''}`);
// Update the current entry (filters, etc.) without adding a history step.
chart.replaceQuery = params => history.replaceState(null, '', `#${chart.lastTab}?${new URLSearchParams(params)}`);

tabs.forEach(tab => tab.addEventListener('click', () => chart.go(tab.dataset.tab)));
document.querySelectorAll('[data-tab]:not(.nav-item)').forEach(link => link.addEventListener('click', () => chart.go(link.dataset.tab)));
window.addEventListener('hashchange', route);
route();

let toastTimer;
chart.toast = message => {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
};
document.querySelectorAll('[data-toast]').forEach(button => button.addEventListener('click', () => chart.toast(button.dataset.toast.replace('.negative', ''))));

// A presentation mode on the signed-in account, not a separate provider login.
chart.mode = 'provider';
chart.setMode = (mode, navigate = false) => {
  if (mode === 'provider' && chart.hasUnsavedPreparation?.()) {
    if (!confirm('Discard unsaved edits and switch to Provider view?')) return;
    document.dispatchEvent(new CustomEvent('chart:discardPreparation'));
  }
  chart.mode = mode === 'owner' ? 'owner' : 'provider';
  document.body.dataset.mode = chart.mode;
  document.getElementById('view-label').textContent = chart.mode === 'provider' ? 'Provider view' : 'Prepare for visit';
  try { sessionStorage.setItem(`chart-mode:${document.body.dataset.account}`, chart.mode); } catch {}
  document.dispatchEvent(new CustomEvent('chart:mode', { detail: chart.mode }));
  if (navigate && chart.mode === 'provider') chart.go('goals');
};
document.querySelectorAll('.mode-action').forEach(button => button.addEventListener('click', () => chart.setMode(button.dataset.mode, true)));
try { chart.setMode(sessionStorage.getItem(`chart-mode:${document.body.dataset.account}`)); } catch { chart.setMode('provider'); }
