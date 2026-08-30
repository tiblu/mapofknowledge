/* ══════════════════════════════════════════════════════════════════════════
   HELP HINTS — js/help-hint.js
   ──────────────────────────────────────────────────────────────────────────
   Generic, event-delegated "?" popover. Adding a new hint anywhere in the
   app never needs new JS — just drop this markup in (see help-hint.css for
   the full convention):

     <button type="button" class="hh-btn" aria-label="More info">?</button>
     <span class="hh-content" hidden>Explanation text — links allowed.</span>

   One shared popover element is reused for all of them, positioned near
   whichever button was clicked and flipped to stay on-screen.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  var popover  = null;
  var activeBtn = null;

  function ensurePopover() {
    if (!popover) {
      popover = document.createElement('div');
      popover.className = 'hh-popover';
      document.body.appendChild(popover);
    }
    return popover;
  }

  function closePopover() {
    if (popover) popover.classList.remove('active');
    activeBtn = null;
  }

  function openPopover(btn) {
    var content = btn.nextElementSibling;
    if (!content || !content.classList.contains('hh-content')) return;
    var pop = ensurePopover();
    pop.innerHTML = content.innerHTML;
    pop.classList.add('active');
    activeBtn = btn;

    var r    = btn.getBoundingClientRect();
    var popW = pop.offsetWidth;
    var popH = pop.offsetHeight;
    var left = r.left;
    var top  = r.bottom + 6;
    if (left + popW > window.innerWidth - 12) left = window.innerWidth - popW - 12;
    if (top + popH > window.innerHeight - 12) top = r.top - popH - 6;
    if (left < 12) left = 12;
    if (top < 12) top = 12;
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.hh-btn');
    if (btn) {
      e.stopPropagation();
      if (activeBtn === btn) { closePopover(); return; }
      openPopover(btn);
      return;
    }
    if (popover && popover.classList.contains('active') && !popover.contains(e.target)) closePopover();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePopover();
  });
})();
