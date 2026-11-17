// Fills [data-gh-asset] placeholders with the newest matching package from
// GitHub releases. Placeholders stay as written when the lookup fails.
(function () {
    var slots = document.querySelectorAll('[data-gh-asset]');
    if (!slots.length) return;

    var CACHE_MS = 60 * 60 * 1000;

    function cached(repo) {
        try {
            var hit = JSON.parse(sessionStorage.getItem('gh-releases:' + repo));
            if (hit && Date.now() - hit.at < CACHE_MS) return hit.releases;
        } catch (e) {}
        return null;
    }

    function store(repo, releases) {
        try {
            sessionStorage.setItem('gh-releases:' + repo, JSON.stringify({ at: Date.now(), releases: releases }));
        } catch (e) {}
    }

    function load(repo) {
        var hit = cached(repo);
        if (hit) return Promise.resolve(hit);
        return fetch('https://api.github.com/repos/' + repo + '/releases?per_page=10', {
            headers: { Accept: 'application/vnd.github+json' }
        }).then(function (res) {
            if (!res.ok) throw new Error('GitHub API ' + res.status);
            return res.json();
        }).then(function (data) {
            var releases = data.filter(function (r) {
                return !r.draft && !r.prerelease;
            }).map(function (r) {
                return {
                    tag: r.tag_name,
                    url: r.html_url,
                    assets: r.assets.map(function (a) {
                        return { name: a.name, url: a.browser_download_url };
                    })
                };
            });
            store(repo, releases);
            return releases;
        });
    }

    // A release is published before CI attaches its packages, so the newest
    // release may not carry the asset yet: fall back to the newest that does.
    function find(releases, pattern) {
        var re = new RegExp(pattern);
        for (var i = 0; i < releases.length; i++) {
            var assets = releases[i].assets;
            for (var j = 0; j < assets.length; j++) {
                if (re.test(assets[j].name)) return { release: releases[i], asset: assets[j] };
            }
        }
        return null;
    }

    var byRepo = {};
    slots.forEach(function (el) {
        var repo = el.getAttribute('data-gh-repo');
        (byRepo[repo] = byRepo[repo] || []).push(el);
    });

    Object.keys(byRepo).forEach(function (repo) {
        load(repo).then(function (releases) {
            byRepo[repo].forEach(function (el) {
                var found = find(releases, el.getAttribute('data-gh-asset'));
                if (!found) return;
                var field = el.getAttribute('data-gh-field');
                if (field === 'url') {
                    el.textContent = found.asset.url;
                } else if (field === 'release') {
                    el.textContent = found.release.tag;
                    el.href = found.release.url;
                    var wrapper = el.closest('[hidden]');
                    if (wrapper) wrapper.hidden = false;
                } else {
                    el.textContent = found.asset.name;
                }
            });
        }).catch(function () {});
    });
})();
