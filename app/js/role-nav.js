(function () {
  fetch('/auth/me')
    .then(function (r) { return r.json(); })
    .then(function (user) {
      if (!user || !user.id) return;
      var role = user.role;
      if (role === 'learner') return;

      var banner = document.querySelector('.topbar-banner');
      if (!banner) return;

      var p = window.location.pathname;
      var onTeacher = p.indexOf('teacher') !== -1;
      var onParent  = p.indexOf('parent')  !== -1;
      var onAdmin   = p.indexOf('admin')   !== -1;
      var onMap     = !onTeacher && !onParent && !onAdmin;

      var isAdmin = role === 'admin' || role === 'super_admin';
      var tabs = [{ label: 'Kaart', href: 'index.html', active: onMap }];
      if (role === 'teacher' || isAdmin) {
        tabs.push({ label: 'Minu õpilased', href: 'teacher.html', active: onTeacher });
      }
      if (role === 'parent' || isAdmin) {
        tabs.push({ label: 'Minu lapsed', href: 'parent.html', active: onParent });
      }
      banner.innerHTML = '<div class="role-switcher">' +
        tabs.map(function (t) {
          return '<a href="' + t.href + '" class="role-btn' +
            (t.active ? ' role-active' : '') + '">' + t.label + '</a>';
        }).join('') +
        '</div>';

      if (role === 'super_admin') {
        var dropdown = document.getElementById('nav-dropdown');
        if (dropdown) {
          var dividers = dropdown.querySelectorAll('.nav-dropdown-divider');
          var lastDivider = dividers[dividers.length - 1];
          var sep = document.createElement('div');
          sep.className = 'nav-dropdown-divider';
          var btn = document.createElement('button');
          btn.className = 'nav-dropdown-item';
          btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 15 15" fill="none">'
            + '<rect x="1.5" y="3" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/>'
            + '<path d="M5 3V2M10 3V2M1.5 6.5h12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
            + '</svg><span>Admin</span>';
          btn.onclick = function () { window.location = 'admin.html'; };
          dropdown.insertBefore(sep, lastDivider);
          dropdown.insertBefore(btn, lastDivider);
        }
      }
    })
    .catch(function () {});
}());
