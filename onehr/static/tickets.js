// The Ticketing agent's AI (2026-10-22, canvas [design canvas link removed] boards 9-13): "Draft
// the reply with AI" fills the reply box from what the agent found and what the admin did; "Ask about this ticket"
// answers from the same facts. Both post to /admin/tickets/agent and change nothing; the admin edits and sends.
(function () {
  var me = document.currentScript;
  var url = me && me.getAttribute('data-agent-url');
  if (!url) return;
  var LOST = 'Sorry, I lost the thread there. Try again.';

  function csrf() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute('content') : '';
  }

  function post(data) {
    var fd = new FormData();
    fd.append('csrf_token', csrf());
    Object.keys(data).forEach(function (k) { fd.append(k, data[k]); });
    return fetch(url, {method: 'POST', body: fd, credentials: 'same-origin', headers: {'X-Requested-With': 'fetch'}})
      .then(function (r) { return r.json().catch(function () { return {ok: false, say: LOST}; }); })
      .catch(function () { return {ok: false, say: LOST}; });
  }

  document.querySelectorAll('[data-tk-draft]').forEach(function (b) {
    var label = b.lastChild;
    b.addEventListener('click', function () {
      var key = b.getAttribute('data-tk-draft');
      var box = document.getElementById('tk-reply-' + key);
      var did = document.getElementById('tk-did-' + key);
      var note = document.querySelector('[data-tk-drafted="' + key + '"]');
      if (!box || b.disabled) return;
      b.disabled = true;
      b.classList.add('is-busy');
      var was = label.nodeValue;
      label.nodeValue = 'Drafting…';
      post({do: 'draft', kind: b.getAttribute('data-kind'), ticket_id: b.getAttribute('data-id'),
            did_note: did ? did.value : ''}).then(function (j) {
        if (j.ok && j.text) {
          box.value = j.text;
          box.rows = Math.min(10, j.text.split('\n').length + 3);
          box.dispatchEvent(new Event('input', {bubbles: true}));
          if (note) { note.textContent = 'Drafted with AI from what the agent found and what you did. Edit it before you send.'; note.hidden = false; }
          box.focus();
        } else if (note) {
          note.textContent = j.say || 'The draft didn’t come back. Try again, or write it yourself.';
          note.hidden = false;
        }
      }).then(function () {
        b.disabled = false;
        b.classList.remove('is-busy');
        label.nodeValue = was;
      });
    });
  });

  document.querySelectorAll('[data-tk-ask]').forEach(function (w) {
    var form = w.querySelector('[data-tk-ask-form]');
    var input = form && form.querySelector('input');
    var log = w.querySelector('.tk-ag-log');
    if (!form || !input || !log) return;
    form.setAttribute('data-no-busy', '');
    var skey = 'tk-ask-' + w.getAttribute('data-key');
    var hist = [];
    try { hist = JSON.parse(sessionStorage.getItem(skey) || '[]') || []; } catch (e) { hist = []; }

    function bubble(cls, text) {
      var d = document.createElement('div');
      d.className = 'tk-ag-msg ' + cls;
      d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
      return d;
    }
    hist.forEach(function (h) { bubble('is-q', h.q); bubble('is-a', h.a); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = (input.value || '').trim();
      if (!q || form.classList.contains('is-busy')) return;
      bubble('is-q', q);
      input.value = '';
      form.classList.add('is-busy');
      var wait = bubble('is-a is-wait', 'Looking at the ticket…');
      post({do: 'ask', kind: w.getAttribute('data-kind'), ticket_id: w.getAttribute('data-id'), q: q,
            history: JSON.stringify(hist.slice(-4))}).then(function (j) {
        var a = j.say || LOST;
        wait.textContent = a;
        wait.classList.remove('is-wait');
        if (j.ok) {
          hist.push({q: q, a: a});
          hist = hist.slice(-8);
          try { sessionStorage.setItem(skey, JSON.stringify(hist)); } catch (e2) { /* a private window keeps none */ }
        }
        form.classList.remove('is-busy');
        var col = w.closest('.tk-agent');
        if (col) col.scrollTop = col.scrollHeight;   // the answer and the box stay in view
        input.focus();
      });
    });
  });
})();
