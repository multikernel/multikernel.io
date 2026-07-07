// Language preference + first-visit suggestion banner. Progressive enhancement only:
// the EN/中文 switch works without this file.
(function () {
    var KEY = 'mk-lang';

    document.addEventListener('DOMContentLoaded', function () {
        var links = document.querySelectorAll('[data-lang-choice]');
        for (var i = 0; i < links.length; i++) {
            links[i].addEventListener('click', function () {
                try { localStorage.setItem(KEY, this.getAttribute('data-lang-choice')); } catch (e) {}
            });
        }

        var pref = null;
        try { pref = localStorage.getItem(KEY); } catch (e) { return; }

        var isZhPage = document.documentElement.lang.toLowerCase().indexOf('zh') === 0;
        var twin = document.querySelector('link[rel="alternate"][hreflang="zh-CN"]');
        var wantsZh = ((navigator.language || '') + '').toLowerCase().indexOf('zh') === 0;
        if (isZhPage || pref || !twin || !wantsZh) return;

        var zhPath;
        try { zhPath = new URL(twin.href).pathname; } catch (e) { return; }

        var banner = document.createElement('div');
        banner.setAttribute('style',
            'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:1000000;' +
            'display:flex;align-items:center;gap:14px;padding:12px 20px;border-radius:8px;' +
            'background:#1e293b;border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.85);' +
            'font-size:14px;box-shadow:0 16px 48px rgba(0,0,0,0.5);max-width:calc(100vw - 32px);');
        banner.innerHTML =
            '<span>此页面提供中文版。</span>' +
            '<a href="' + zhPath + '" style="color:#e2a23b;font-weight:600;text-decoration:none;white-space:nowrap;">查看中文版</a>' +
            '<button aria-label="关闭" style="background:none;border:none;color:rgba(255,255,255,0.5);font-size:18px;cursor:pointer;padding:0 2px;line-height:1;">&times;</button>';
        document.body.appendChild(banner);

        banner.querySelector('a').addEventListener('click', function () {
            try { localStorage.setItem(KEY, 'zh'); } catch (e) {}
        });
        banner.querySelector('button').addEventListener('click', function () {
            try { localStorage.setItem(KEY, 'en'); } catch (e) {}
            banner.parentNode.removeChild(banner);
        });
    });
})();
