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
      if (role === 'super_admin') {
        tabs.push({ label: 'Admin', href: 'admin.html', active: onAdmin });
      }

      banner.innerHTML = '<div class="role-switcher">' +
        tabs.map(function (t) {
          return '<a href="' + t.href + '" class="role-btn' +
            (t.active ? ' role-active' : '') + '">' + t.label + '</a>';
        }).join('') +
        '</div>';
    })
    .catch(function () {});
}());
