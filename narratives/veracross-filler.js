/* Veracross Narrative Filler
 * Run on the Veracross comment-entry page (via the bookmarklet, or paste into the DevTools console).
 * It reads the narratives you copied from Narrative Builder ("Copy for Veracross"), finds each
 * student's comment box by name, and fills it in. It does NOT press Save unless AUTO_SAVE is true.
 */
(function () {
  var AUTO_SAVE = false;              // set true to click the page's Save button after filling
  var SAVE_TEXT = /^\s*save(\s+(all|comments?|narratives?|changes))?\s*$/i;
  var FIELD_LABEL = null;             // e.g. /narrative/i to only fill boxes whose nearby label matches

  var old = document.getElementById('nb-vc-panel'); if (old) old.remove();

  function norm(s) {
    return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z' -]/g, ' ').replace(/['-]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function words(s) { return ' ' + norm(s) + ' '; }
  function has(hay, w) { return w && hay.indexOf(' ' + w + ' ') !== -1; }

  function panel(html) {
    var p = document.getElementById('nb-vc-panel');
    if (!p) {
      p = document.createElement('div'); p.id = 'nb-vc-panel';
      p.style.cssText = 'position:fixed;z-index:2147483647;top:16px;right:16px;width:360px;max-height:80vh;overflow:auto;' +
        'background:#fff;color:#1d2a2e;border:1px solid #c9d3d4;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.2);' +
        'font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:14px 16px';
      document.body.appendChild(p);
    }
    p.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<strong style="font-size:15px">Narrative Filler</strong>' +
      '<button id="nb-vc-x" style="border:0;background:none;font-size:20px;cursor:pointer">×</button></div>' + html;
    p.querySelector('#nb-vc-x').onclick = function () { p.remove(); };
    return p;
  }

  function start() {
    var p = panel('<p style="margin:0 0 8px">Paste the narratives you copied from Narrative Builder:</p>' +
      '<textarea id="nb-vc-in" style="width:100%;height:110px;box-sizing:border-box;font:12px monospace"></textarea>' +
      '<button id="nb-vc-go" style="margin-top:8px;background:#1d5c63;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer">Fill comment boxes</button>');
    var ta = p.querySelector('#nb-vc-in'); ta.focus();
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (t) { if (t && t.indexOf('"narrative"') !== -1) ta.value = t; }).catch(function () {});
    }
    p.querySelector('#nb-vc-go').onclick = function () { run(ta.value); };
  }

  function allDocs() {
    var docs = [document];
    (function walk(d) {
      var frames = d.querySelectorAll('iframe,frame');
      for (var i = 0; i < frames.length; i++) {
        try { var cd = frames[i].contentDocument; if (cd && docs.indexOf(cd) === -1) { docs.push(cd); walk(cd); } } catch (e) {}
      }
    })(document);
    return docs;
  }

  function visible(el) {
    var r = el.getBoundingClientRect(); var cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return (r.width > 0 || r.height > 0) && cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function fieldText(el) { return el.isContentEditable ? (el.innerText || '') : ''; }

  function setValue(el, text) {
    var win = el.ownerDocument.defaultView;
    if (el.isContentEditable) {
      el.focus();
      var ok = false;
      try { el.ownerDocument.execCommand('selectAll', false, null); ok = el.ownerDocument.execCommand('insertText', false, text); } catch (e) {}
      if (!ok || norm(el.innerText) !== norm(text)) { el.innerText = text; }
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
    } else {
      var proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      el.focus(); setter.call(el, text);
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
    el.dispatchEvent(new win.Event('blur', { bubbles: true }));
    el.style.outline = '3px solid #2e9e6a'; el.style.outlineOffset = '1px';
  }

  function run(raw) {
    var data;
    try { data = JSON.parse(raw); } catch (e) { panel('<p style="color:#b3261e">That didn\'t look like the copied narratives. Go back to Narrative Builder, click <b>Copy for Veracross</b>, and try again.</p>'); return; }
    var list = Array.isArray(data) ? data : (data.students || []);
    var students = list.map(function (s) {
      var toks = norm(s.name).split(' ').filter(function (t) { return t.length > 1; });
      return { s: s, first: toks[0], last: toks[toks.length - 1], alt: norm(s.goesBy || ''), field: null, ambiguous: false };
    }).filter(function (x) { return x.first && x.s.narrative; });

    function matches(hay) {
      return students.filter(function (x) {
        return has(hay, x.last) && (has(hay, x.first) || (x.alt && has(hay, x.alt)));
      });
    }

    var fields = [];
    allDocs().forEach(function (d) {
      var els = d.querySelectorAll('textarea, [contenteditable=""], [contenteditable="true"]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.readOnly || el.disabled || !visible(el) || el.closest('#nb-vc-panel')) continue;
        if (el.isContentEditable && el.parentElement && el.parentElement.isContentEditable) continue;
        fields.push(el);
      }
    });

    fields.forEach(function (el) {
      var own = norm(fieldText(el));
      var node = el.parentElement;
      for (var depth = 0; node && depth < 10; depth++, node = node.parentElement) {
        var hay = words(norm(node.innerText || '').replace(own, ' '));
        var m = matches(hay);
        if (m.length === 1) {
          if (FIELD_LABEL && !FIELD_LABEL.test(node.innerText || '')) break;
          if (!m[0].field) m[0].field = el; else m[0].ambiguous = true;
          break;
        }
        if (m.length > 1) break;
      }
    });

    var filled = [], missing = [], multi = [];
    students.forEach(function (x) {
      if (!x.field) { missing.push(x.s.name); return; }
      setValue(x.field, x.s.narrative);
      filled.push(x.s.name);
      if (x.ambiguous) multi.push(x.s.name);
    });

    var html = '<p style="margin:0 0 6px"><b style="color:#2e7d55">Filled ' + filled.length + '</b> of ' + students.length + ' narratives (outlined in green).</p>';
    if (missing.length) html += '<p style="margin:6px 0"><b style="color:#b3261e">Couldn\'t find a box for:</b><br>' + missing.join('<br>') + '</p>';
    if (multi.length) html += '<p style="margin:6px 0"><b style="color:#9a6400">More than one box matched (filled the first):</b><br>' + multi.join('<br>') + '</p>';
    if (!fields.length) html += '<p style="color:#b3261e">No comment boxes were found on this page. Open the page where you type the comments for the class, then run this again.</p>';
    if (AUTO_SAVE && filled.length) {
      var btn = null;
      allDocs().some(function (d) {
        var bs = d.querySelectorAll('button, input[type=submit], input[type=button], a');
        for (var i = 0; i < bs.length; i++) { var t = bs[i].innerText || bs[i].value || ''; if (SAVE_TEXT.test(t) && visible(bs[i])) { btn = bs[i]; return true; } }
      });
      if (btn) { btn.click(); html += '<p>Clicked <b>' + (btn.innerText || btn.value) + '</b>.</p>'; }
      else html += '<p style="color:#9a6400">Couldn\'t find a Save button — please click it yourself.</p>';
    } else {
      html += '<p style="margin-top:8px">Review the filled comments, then click Veracross\'s <b>Save</b> button.</p>';
    }
    panel(html);
  }

  start();
})();
