/* Navigation only: no access tokens, answers or submission state are read. */
(() => {
  const header = document.querySelector('.jk-header');
  const menu = header?.querySelector('.jk-menu-button');
  if (menu) {
    header.classList.add('jk-menu-ready');
    const close = () => { header.classList.remove('jk-menu-open'); menu.setAttribute('aria-expanded', 'false'); };
    menu.addEventListener('click', () => {
      const open = header.classList.toggle('jk-menu-open');
      menu.setAttribute('aria-expanded', String(open));
    });
    header.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); menu.focus(); } });
    header.querySelectorAll('.jk-nav a').forEach(a => a.addEventListener('click', close));
    const wide = matchMedia('(min-width: 701px)');
    wide.addEventListener('change', close);
  }
  const groups = [...document.querySelectorAll('details.jk-group')];
  if (!groups.length) return;
  const key = 'jacky-library-sections-v1';
  let printing = false, printState = [];
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch (_) {}
  const expand = document.querySelector('.jk-expand');
  const syncLabel = () => { if (expand) expand.textContent = groups.every(g => g.open) ? 'Close all' : 'Open all'; };
  groups.forEach(g => {
    g.open = saved?.[g.id] === true;
    g.addEventListener('toggle', () => {
      if (printing) return;
      syncLabel();
      try { localStorage.setItem(key, JSON.stringify(Object.fromEntries(groups.map(d => [d.id, d.open])))); } catch (_) {}
    });
  });
  expand?.addEventListener('click', () => { const open = !groups.every(g => g.open); groups.forEach(g => g.open = open); syncLabel(); });
  const reveal = () => {
    const target = groups.find(g => '#' + g.id === location.hash);
    if (target) { target.open = true; requestAnimationFrame(() => target.scrollIntoView({block:'start'})); }
  };
  addEventListener('hashchange', reveal);
  reveal(); syncLabel();
  addEventListener('beforeprint', () => { printing = true; printState = groups.map(g => g.open); groups.forEach(g => g.open = true); });
  addEventListener('afterprint', () => { groups.forEach((g,i) => g.open = printState[i]); setTimeout(() => { printing = false; syncLabel(); }, 0); });
})();
