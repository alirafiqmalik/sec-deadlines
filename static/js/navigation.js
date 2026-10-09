/* Navigation disclosures stay independent of deadline filtering and storage. */
(() => {
  const nav = document.querySelector('.site-nav');
  if (!nav) return;

  const toggles = Array.from(nav.querySelectorAll('[data-nav-toggle]'));

  function setExpanded(button, expanded) {
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    button.setAttribute('aria-expanded', String(expanded));
    panel.hidden = !expanded;
    if (!expanded) {
      panel.querySelectorAll('[data-nav-toggle]').forEach(child => setExpanded(child, false));
    }
  }

  function closeAll() {
    toggles.forEach(button => setExpanded(button, false));
  }

  toggles.forEach(button => {
    button.addEventListener('click', () => {
      setExpanded(button, button.getAttribute('aria-expanded') !== 'true');
    });
  });

  document.addEventListener('click', event => {
    if (!nav.contains(event.target)) closeAll();
  });

  nav.addEventListener('focusout', event => {
    if (!nav.contains(event.relatedTarget)) closeAll();
  });

  nav.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const open = toggles.slice().reverse().find(button => {
      const panel = document.getElementById(button.getAttribute('aria-controls'));
      return button.getAttribute('aria-expanded') === 'true' &&
        (button === event.target || panel.contains(event.target));
    });
    if (open) {
      event.preventDefault();
      setExpanded(open, false);
      open.focus();
    }
  });

  window.matchMedia('(min-width: 48rem)').addEventListener('change', closeAll);
})();
