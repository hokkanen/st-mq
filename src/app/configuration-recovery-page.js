// Kept independent of the dashboard bundle so invalid startup settings cannot
// prevent access to configuration repair. All configuration text comes from the
// authenticated, redacted recovery API and is inserted as text, never HTML.
const attribute = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

export function recoveryPage({ csrfToken = '', environment = 'linux', nonce = '' } = {}) {
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="recovery-csrf" content="${attribute(csrfToken)}">
<title>Configuration recovery · Home Energy</title>
<style nonce="${attribute(nonce)}">
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color-scheme:dark;--bg:#101e19;--surface:#182a22;--soft:#1d3128;--text:#e1ece2;--muted:#a5baa9;--border:#354b3d;--accent:#b9d8b4;--accent-text:#152d20;--focus:#cce6a9;--error:#ffbcab;--error-bg:#442821;color:var(--text);background:var(--bg)}
:root[data-theme="light"]{color-scheme:light;--bg:#f3f5f1;--surface:#fff;--soft:#eef3e9;--text:#16352c;--muted:#5f7365;--border:#d3ded0;--accent:#214d3c;--accent-text:#fff;--focus:#7c9b5b;--error:#842a21;--error-bg:#ffebe5}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;font-size:15px;line-height:1.6}main{max-width:860px;margin:auto;padding:28px 24px 64px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}.brand{font-size:14px;font-weight:650;letter-spacing:.03em}h1{font-size:clamp(26px,5vw,34px);line-height:1.2;margin:8px 0 12px;font-weight:650}h2{font-size:19px;line-height:1.35;margin:0 0 12px}p{margin:0 0 14px}.muted,.help{color:var(--muted)}.eyebrow{font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0}.intro{margin-bottom:24px}.panel{padding:24px;background:var(--surface);border:1px solid var(--border);border-radius:14px;margin-top:18px}.problem{border-left:3px solid var(--error)}.problem p{margin-bottom:0;overflow-wrap:anywhere}.problem h2{color:var(--error)}.steps{padding-left:23px;margin:0}.steps li{padding-left:3px;margin:0 0 14px}.steps li:last-child{margin-bottom:0}code{font-size:.92em;overflow-wrap:anywhere;background:var(--soft);border-radius:4px;padding:2px 5px}.path{display:block;margin-top:7px;padding:9px 11px}button,input{font:inherit}button{min-height:44px;border:1px solid var(--border);border-radius:8px;padding:9px 15px;background:var(--soft);color:var(--text);font-weight:600;cursor:pointer}button:hover{border-color:var(--accent)}button.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent)}button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible,[tabindex="-1"]:focus-visible{outline:3px solid var(--focus);outline-offset:3px}#theme-toggle{font-size:13px;min-height:38px;padding:6px 12px}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}.actions button{max-width:100%}fieldset{min-width:0;border:0;margin:22px 0 0;padding:0}legend{font-weight:650;margin-bottom:8px}.choice{display:flex;align-items:flex-start;gap:10px;padding:10px 0;cursor:pointer}.choice input{flex-shrink:0;margin:6px 0 0;width:17px;height:17px;accent-color:var(--accent)}.choice span{min-width:0}.choice strong{display:block;font-size:14px}.choice small{display:block;color:var(--muted);font-size:13px;line-height:1.5}.notice{padding:12px 14px;border-radius:8px;background:var(--soft);margin-top:16px;font-size:14px}.error{color:var(--error);background:var(--error-bg)}#receipt{margin:18px 0 0;overflow-wrap:anywhere}#receipt:empty{display:none}label.key{display:block;font-weight:600;margin-top:16px}#access-key{display:block;width:100%;min-height:46px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);padding:9px 12px;margin-top:6px}table{border-collapse:collapse;table-layout:fixed;width:100%;font-size:13px;margin-top:16px}th,td{text-align:left;vertical-align:top;padding:11px 10px;border-bottom:1px solid var(--border);overflow-wrap:anywhere}thead th{color:var(--muted);font-weight:500}th:first-child{width:44%}tbody th{font-weight:550}.help{font-size:13px;margin-top:12px}.panel>:last-child{margin-bottom:0}#restart-note{font-weight:600;margin-top:16px}
@media(max-width:520px){main{padding:18px 16px 40px}.panel{padding:18px 16px}.actions{flex-direction:column}.actions button{width:100%}table,tbody,tr,th,td{display:block;width:100%}thead{display:none}th:first-child{width:100%}tbody tr{padding:10px 0;border-bottom:1px solid var(--border)}tbody th{padding:4px 0;border:0}tbody td{display:grid;grid-template-columns:68px minmax(0,1fr);gap:8px;padding:4px 0;border:0}tbody td:before{content:attr(data-label);color:var(--muted)}}
</style></head>
<body data-environment="${environment === 'home-assistant' ? 'home-assistant' : 'linux'}">
<main><header><span class="brand">Home Energy</span><button id="theme-toggle" type="button">Light theme</button></header>
<div class="intro"><p class="eyebrow">Setup needs attention</p><h1>Configuration recovery</h1>
<p id="startup-state">The controller has not started because its configuration could not be loaded.</p>
<p class="muted">Correct the settings below, then restart the application. Equipment may continue operating under its existing settings and independent protection.</p></div>
<section id="access-panel" class="panel" hidden aria-labelledby="access-title"><h2 id="access-title">Open local recovery</h2>
<p>Read the recovery access-key file shown in the service logs. Enter its contents below.</p>
<p class="muted">Recovery is available on this computer only. To connect from another computer, use an SSH tunnel.</p>
<form id="access-form"><label class="key" for="access-key">Recovery access key</label>
<input id="access-key" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required>
<div class="actions"><button id="access-submit" class="primary" type="submit">Open configuration</button></div></form></section>
<div id="configuration" hidden>
<section id="problem" class="panel problem" aria-labelledby="problem-title"><h2 id="problem-title" tabindex="-1">Configuration could not be loaded</h2><p id="startup-error"></p></section>
<section class="panel" aria-labelledby="repair-title"><h2 id="repair-title">Correct your configuration</h2>
<div id="ha-instructions" hidden><ol class="steps"><li>In Home Assistant, open <strong>Settings → Apps → Home Energy → Configuration</strong> to correct saved settings. The YAML editor shows the field names.</li>
<li>To import a configuration file, copy <code>secrets.json</code> using Terminal &amp; SSH to:<code class="path" id="external-import-path"></code><span class="help">Inside this app: <code id="import-path"></code></span></li>
<li>Choose how to use the file, then check and review the configuration before saving.</li></ol>
<fieldset id="import-mode"><legend>Import method</legend><label class="choice"><input type="radio" name="import-mode" value="merge" checked><span><strong>Keep saved settings and merge the uploaded file</strong><small>Fields omitted from the file keep their saved values. If there is no file, check saved settings.</small></span></label>
<label class="choice"><input type="radio" name="import-mode" value="replace"><span><strong>Replace saved settings from the uploaded file</strong><small>Use this when saved settings contain incompatible fields. Only the uploaded settings are retained; omitted settings return to current defaults.</small></span></label></fieldset>
<p id="replace-note" class="notice" hidden>Replacement removes saved settings that are absent from the uploaded file, including connection settings and credentials. Include every installation setting you need to keep. The file must use the current configuration format.</p></div>
<div id="linux-instructions" hidden><ol class="steps"><li>Edit the configuration file on this computer:<code class="path" id="private-path"></code></li><li>Remove unsupported fields and correct the reported problem. Keep the directory private (mode <code>0700</code>) and the file private (mode <code>0600</code>).</li><li>Save the file, then check and review the configuration below. Environment overrides still take precedence.</li></ol></div>
<p id="access-note" class="help" hidden></p>
<div class="actions"><button id="check" class="primary" type="button">Check &amp; review configuration</button></div></section>
<section id="review" class="panel" hidden aria-labelledby="review-title"><h2 id="review-title" tabindex="-1">Review configuration</h2><p id="review-summary"></p><p id="review-scope" class="notice"></p>
<table id="changes-table"><thead><tr><th scope="col">Field</th><th id="before-heading" scope="col">Saved</th><th scope="col">Proposed</th></tr></thead><tbody id="changes"></tbody></table>
<p class="help">Private values remain hidden. Validation checks the configuration format; it does not confirm device connections.</p>
<div class="actions"><button id="cancel" type="button">Cancel</button><button id="apply" class="primary" type="button">Save reviewed configuration</button></div></section>
<section id="complete" class="panel" hidden aria-labelledby="complete-title"><h2 id="complete-title" tabindex="-1">Configuration is ready</h2><p id="complete-message"></p><p id="backup-note" hidden>The previous saved settings are preserved in a private backup:<code class="path" id="backup-path"></code></p><p id="restart-note"></p></section>
</div><p id="receipt" class="notice" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></p>
<noscript><p class="notice error">Enable JavaScript to check and review configuration here. You can also correct the configuration file or saved Home Assistant settings and restart the application.</p></noscript>
</main><script nonce="${attribute(nonce)}">(${recoveryClient.toString()})();</script></body></html>`;
}

function recoveryClient() {
  const $ = id => document.getElementById(id);
  const ha = document.body.dataset.environment === 'home-assistant';
  const csrf = document.querySelector('meta[name="recovery-csrf"]').content;
  let accessKey = '', review = null, busy = false;
  function theme(value) {
    document.documentElement.dataset.theme = value;
    const next = value === 'dark' ? 'light' : 'dark';
    $('theme-toggle').textContent = `${next === 'dark' ? 'Dark' : 'Light'} theme`;
    $('theme-toggle').setAttribute('aria-label', `Switch to ${next} theme`);
    try { localStorage.setItem('home-energy-theme', value); } catch {}
  }
  let savedTheme;
  try { savedTheme = localStorage.getItem('home-energy-theme'); } catch {}
  theme(savedTheme === 'light' ? 'light' : 'dark');
  $('theme-toggle').addEventListener('click', () => theme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  function announce(message, error = false) {
    $('receipt').textContent = message;
    $('receipt').classList.toggle('error', error);
    if (error) $('receipt').focus();
  }
  function setBusy(value) {
    busy = value;
    for (const id of ['check', 'cancel', 'apply', 'access-submit']) $(id).disabled = value;
    $('check').setAttribute('aria-busy', String(value));
    for (const input of document.querySelectorAll('input[name="import-mode"]')) input.disabled = value;
    $('access-key').disabled = value;
  }
  function clearReview() {
    review = null;
    $('review').hidden = true;
    $('changes').replaceChildren();
  }
  function showComplete(result, focus = true) {
    $('startup-state').textContent = 'The controller is waiting for a restart to load the reviewed configuration.';
    $('problem').hidden = true;
    $('complete-message').textContent = result.message || 'The reviewed configuration is ready to use.';
    $('backup-path').textContent = result.backupPath || '';
    $('backup-note').hidden = !result.backupPath;
    $('restart-note').textContent = ha
      ? 'In Home Assistant, open Settings → Apps → Home Energy → Info and choose Restart. Then reopen the web UI.'
      : 'Restart the application using the service or command you normally use, then open its normal web address.';
    $('complete').hidden = false;
    if (focus) $('complete-title').focus();
    announce(ha ? 'Configuration saved. Restart the app to continue.' : 'Configuration confirmed. Restart the application to continue.');
  }
  async function request(path, body) {
    let response;
    try {
      response = await fetch(`api/recovery${path}`, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'X-Recovery-CSRF': csrf,
          ...(accessKey ? { Authorization: `Bearer ${accessKey}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error('The recovery service is unavailable. Check that the application is running, then try again.'); }
    if (response.status === 401 && !ha) {
      accessKey = '';
      clearReview();
      $('configuration').hidden = true;
      $('access-panel').hidden = false;
      throw new Error('The recovery access key was not accepted. Read the current access-key file shown in the service logs and try again.');
    }
    let result;
    try { result = await response.json(); }
    catch { throw new Error('The recovery service returned an unexpected response. Reopen this page and try again.'); }
    if (!response.ok) throw new Error(result.error || 'Configuration could not be checked. Try again.');
    return result;
  }
  async function open() {
    setBusy(true);
    try {
      const status = await request('');
      $('startup-error').textContent = status.error;
      $('problem').hidden = !status.error;
      if (!status.error) $('startup-state').textContent = 'The controller is waiting for a restart to load the reviewed configuration.';
      $('ha-instructions').hidden = !ha;
      $('linux-instructions').hidden = ha;
      $('external-import-path').textContent = status.externalImportPath || '/app_configs/<actual-app-slug>/secrets.json';
      $('import-path').textContent = status.importPath || '/config/secrets.json';
      $('private-path').textContent = status.privatePath || '';
      $('access-note').textContent = status.accessNote || '';
      $('access-note').hidden = !status.accessNote;
      $('configuration').hidden = false;
      $('access-panel').hidden = true;
      $('access-key').value = '';
      if (!status.error && status.receipt && Date.now() - status.receipt.at < 24 * 60 * 60 * 1000) showComplete(status.receipt, !ha);
      else if (!ha) { announce('Recovery access opened. Correct your configuration, then check it below.'); (status.error ? $('problem-title') : $('check')).focus(); }
    } catch (error) { announce(error.message, true); }
    finally { setBusy(false); }
  }
  $('access-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    accessKey = $('access-key').value.trim();
    $('access-key').value = '';
    if (accessKey) void open();
  });
  for (const input of document.querySelectorAll('input[name="import-mode"]')) input.addEventListener('change', () => {
    clearReview();
    $('complete').hidden = true;
    $('replace-note').hidden = document.querySelector('input[name="import-mode"]:checked').value !== 'replace';
  });
  $('check').addEventListener('click', async () => {
    if (busy) return;
    clearReview();
    $('complete').hidden = true;
    setBusy(true);
    announce('Checking configuration…');
    try {
      const replacement = ha && document.querySelector('input[name="import-mode"]:checked').value === 'replace';
      const result = await request('/preview', { replacement });
      review = result;
      const changes = result.changes || [];
      $('review-summary').textContent = changes.length
        ? `Configuration is valid. Review ${changes.length} changed ${changes.length === 1 ? 'field' : 'fields'}.`
        : 'Configuration is valid. No changed fields to review.';
      $('before-heading').textContent = ha ? 'Saved' : 'Default';
      $('review-scope').textContent = result.replacement
        ? 'Saving replaces all saved app settings with the uploaded configuration and current defaults. The controller remains stopped until you restart the app.'
        : ha ? 'Saving uses the reviewed settings. The controller remains stopped until you restart the app.'
          : 'These changes compare the corrected file with current defaults. The file stays in place. Confirm this review, then restart the application to use it.';
      for (const change of changes) {
        const row = document.createElement('tr'), field = document.createElement('th');
        field.scope = 'row'; field.textContent = change.path; row.append(field);
        for (const key of ['before', 'after']) {
          const cell = document.createElement('td'), value = document.createElement('span');
          cell.dataset.label = key === 'before' ? ha ? 'Saved' : 'Default' : 'Proposed';
          value.textContent = change[key] == null ? 'Not set' : change.redacted ? 'Hidden' : JSON.stringify(change[key]);
          cell.append(value); row.append(cell);
        }
        $('changes').append(row);
      }
      $('changes-table').hidden = !changes.length;
      $('apply').textContent = ha ? 'Save reviewed configuration' : 'Confirm reviewed configuration';
      $('review').hidden = false;
      $('review-title').focus();
      announce('Check complete. Review the configuration before continuing.');
    } catch (error) { announce(error.message, true); }
    finally { setBusy(false); }
  });
  $('cancel').addEventListener('click', () => {
    if (busy) return;
    clearReview(); announce('Review cancelled. No configuration was saved.'); $('check').focus();
  });
  $('apply').addEventListener('click', async () => {
    if (busy || !review) return;
    const reviewId = review.reviewId;
    clearReview(); setBusy(true);
    announce(ha ? 'Saving reviewed configuration…' : 'Confirming reviewed configuration…');
    try {
      const result = await request('/apply', { reviewId });
      showComplete(result);
    } catch (error) { announce(error.message, true); }
    finally { setBusy(false); }
  });
  if (ha) void open();
  else $('access-panel').hidden = false;
}
