const tabs = [...document.querySelectorAll('.nav-item')];
const panels = [...document.querySelectorAll('.tab-panel')];
const breadcrumb = document.querySelector('.breadcrumb');
const toast = document.querySelector('.toast');

function activate(name) {
  const tab = document.querySelector(`.nav-item[data-tab="${name}"]`);
  const panel = document.getElementById(name);
  if (!tab || !panel) return;
  tabs.forEach(item => item.classList.toggle('active', item === tab));
  panels.forEach(item => item.classList.toggle('active', item === panel));
  breadcrumb.innerHTML = `OUR HOUSEHOLD <span>/</span> <b>${tab.textContent.replace(/\d+$/, '').trim().toUpperCase()}</b>`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

tabs.forEach(tab => tab.addEventListener('click', () => activate(tab.dataset.tab)));
document.querySelectorAll('[data-tab]').forEach(link => link.addEventListener('click', () => activate(link.dataset.tab)));

let toastTimer;
document.querySelectorAll('[data-toast]').forEach(button => button.addEventListener('click', () => {
  toast.textContent = button.dataset.toast.replace('.negative', '');
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}));
