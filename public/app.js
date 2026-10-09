// Gate UI. Plain JavaScript, no build step. Talks to the JSON API in src/server/index.ts.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const shortPath = (p) => String(p ?? '').replace(/^.*?(data\/runtime\/)/, '$1');
const chars = (s) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s ?? '')].length;

const state = { meta: null, jobs: [], job: null, master: null, audit: [], role: localStorage.getItem('role') || 'content_project_lead' };

// ---------- API ----------

let busy = false;

/** GET when body is undefined, POST otherwise. Only one POST at a time, so a double click cannot send a decision twice. */
async function api(path, body) {
  const post = body !== undefined;
  if (post && busy) throw new Error('busy');
  if (post) { busy = true; document.body.classList.add('busy'); }
  try {
    const res = await fetch(path, post ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await res.json();
    if (!res.ok) {
      toast(data.error, data.details ?? []);
      throw new Error(data.error);
    }
    return data;
  } finally {
    if (post) { busy = false; document.body.classList.remove('busy'); }
  }
}

function toast(message, details = []) {
  const el = $('#toast');
  el.innerHTML = `<b>${esc(message.split(':')[0])}</b>${details.length ? `<ul>${details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}`;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 7000);
}

const actor = () => ({ name: state.meta.config.roles[state.role], role: state.role });
const gateRole = (gate) => state.meta.config.gates[gate].role;
const canAct = (gate) => state.role === gateRole(gate);
const channelSpec = (id) => state.meta.channels.find((c) => c.id === id);

// ---------- Loading ----------

async function boot() {
  state.meta = await api('/api/meta');
  const roles = state.meta.config.roles;
  $('#role').innerHTML = Object.entries(roles).map(([id, label]) => `<option value="${id}" ${id === state.role ? 'selected' : ''}>${esc(label)}</option>`).join('');
  $('#role').onchange = (e) => { state.role = e.target.value; localStorage.setItem('role', state.role); render(); };
  $('#outage').checked = state.meta.drill.contentStoreDown;
  $('#outage').onchange = async (e) => {
    const r = await api('/api/drill/content-store', { down: e.target.checked });
    toast(r.contentStoreDown ? 'Drill: the content store is now down' : 'The content store is back');
  };
  $('#mode').textContent = `rollout mode: ${state.meta.config.rollout.mode}`;
  $('#new').onclick = openBriefForm;
  window.onhashchange = () => loadJob(location.hash.slice(1));
  await loadJobs();
  if (location.hash.length > 1) await loadJob(location.hash.slice(1));
  else if (state.jobs[0]) location.hash = state.jobs[0].id;
}

async function loadJobs() {
  state.jobs = await api('/api/jobs');
  renderJobs();
}

async function loadJob(id) {
  if (!id) return;
  state.job = await api(`/api/jobs/${id}`);
  state.audit = await api(`/api/jobs/${id}/audit`);
  state.master = state.job.stages.g3_approve_secondary.status === 'waiting' ? await api(`/api/jobs/${id}/master`) : null;
  render();
}

async function refresh(job) {
  if (job) location.hash === `#${job.id}` ? await loadJob(job.id) : (location.hash = job.id);
  await loadJobs();
}

async function decide(decision) {
  try {
    const job = await api(`/api/jobs/${state.job.id}/decisions`, { ...decision, actor: actor() });
    await refresh(job);
  } catch {
    // The toast already shows why the decision was refused.
  }
}

// ---------- Rendering ----------

function render() {
  renderJobs();
  if (!state.job) return;
  const j = state.job;
  const view = $('#view');
  view.innerHTML = `
    <h1>${esc(j.brief.title)}</h1>
    <div class="muted">${esc(j.id)} <span class="status ${j.status}">${j.status}</span>
      mode ${esc(j.mode)}, launch ${new Date(j.brief.launchAt).toLocaleString()}</div>
    ${renderPipeline(j)}
    ${j.status === 'rejected' || j.status === 'failed' ? renderStopped(j) : ''}
    ${renderG1(j)}${renderG2(j)}${renderG3(j)}${renderG4(j)}
    ${renderOutputs(j)}${renderReport(j)}${renderAudit()}
  `;
  bindG2(j);
  bindG3(j);
  bindG4(j);
  bindOutputs(j);
}

function renderJobs() {
  $('#jobs').innerHTML = state.jobs.length
    ? state.jobs.map((j) => `<li class="${state.job?.id === j.id ? 'active' : ''}" data-id="${j.id}">
        <div class="title">${esc(j.title)}</div>
        <div class="small muted"><span class="status ${j.status}">${j.status}</span> ${esc(j.waiting.join(', ') || '')}</div>
      </li>`).join('')
    : '<li class="muted">No requests yet</li>';
  $$('#jobs li[data-id]').forEach((li) => (li.onclick = () => (location.hash = li.dataset.id)));
}

function renderPipeline(j) {
  const chips = state.meta.stages.map((s) => {
    const st = j.stages[s.id];
    return `<div class="stage kind-${s.kind} s-${st.status}" title="${esc(s.description)}${st.note ? `\n\n${esc(st.note)}` : ''}">
      ${esc(s.label)}<span class="st">${st.status}${st.attempts > 1 ? ` x${st.attempts}` : ''}</span></div>`;
  }).join('');
  return `<div class="pipeline">${chips}</div>
    <div class="legend"><span><i></i>Rule</span><span><i class="l-ai"></i>AI-assisted</span><span><i class="l-human"></i>Person (gate)</span><span>Hover a step for detail</span></div>`;
}

function renderStopped(j) {
  const failed = Object.entries(j.stages).find(([, s]) => s.status === 'failed');
  return `<div class="card"><h3>Request ${j.status}</h3><p>${esc(failed?.[1].note ?? '')}</p></div>`;
}

function gateHeader(gate, title, subtitle = '') {
  const role = gateRole(gate);
  const ok = canAct(gate);
  return `<header><div><h3>${esc(title)}</h3>${subtitle ? `<div class="muted small">${subtitle}</div>` : ''}</div>
    <span class="role-note ${ok ? '' : 'blocked'}">${ok ? 'You can decide here' : `Needs: ${esc(state.meta.config.roles[role])}`}</span></header>`;
}

function fieldInput(name, key, spec, value, dir = 'ltr', lang = 'en') {
  const n = chars(value);
  return `<div class="field">
    <label><span>${esc(name)}</span><span class="count ${n > spec.maxChars ? 'over' : ''}" data-max="${spec.maxChars}">${n}/${spec.maxChars}${spec.limitSource === 'assumed' ? '*' : ''}</span></label>
    <textarea data-key="${esc(key)}" data-field="${esc(name)}" dir="${dir}" lang="${lang}" rows="${spec.maxChars > 60 ? 2 : 1}">${esc(value)}</textarea></div>`;
}

function bindCounters(root) {
  $$('textarea[data-field]', root).forEach((ta) => {
    ta.addEventListener('input', () => {
      const c = ta.parentElement.querySelector('.count');
      const max = Number(c.dataset.max);
      const n = chars(ta.value);
      c.textContent = `${n}/${max}${c.textContent.endsWith('*') ? '*' : ''}`;
      c.classList.toggle('over', n > max);
    });
  });
}

// ----- G1 -----

function renderG1(j) {
  if (j.stages.g1_accept_brief.status !== 'waiting') return '';
  const b = j.brief;
  const c = j.context;
  return `<div class="card gate" id="g1">${gateHeader('g1_accept_brief', 'G1 Accept brief', 'Approve the message and the audience. This locks the master brief for every later step.')}
    <div class="grid2"><dl class="facts">
      <dt>Objective</dt><dd>${esc(b.objective)}</dd><dt>Audience</dt><dd>${esc(b.audience)}</dd>
      <dt>Key message</dt><dd>${esc(b.keyMessage)}</dd><dt>Offer</dt><dd>${esc(b.offer || 'none')}</dd>
      <dt>CTA</dt><dd>${esc(b.cta || 'none')}</dd><dt>Channels</dt><dd>${esc(b.channels.join(', '))}</dd><dt>Locales</dt><dd>${esc(b.locales.join(', '))}</dd>
    </dl><dl class="facts">
      <dt>Brand</dt><dd>${esc(c.brand.name)}</dd><dt>Approved claims</dt><dd>${esc(c.brand.approvedClaims.join('; '))}</dd>
      <dt>Products</dt><dd>${c.products.map((p) => `${esc(p.name)} (${esc(p.composition)})`).join('<br>')}</dd>
      <dt>Keywords</dt><dd>${esc(c.keywords.join(', '))}</dd>
    </dl></div>
    <div class="actions"><button class="primary" data-g1="approve" ${canAct('g1_accept_brief') ? '' : 'disabled'}>Accept and lock</button>
      <input class="grow" id="g1-notes" placeholder="Reason, if you reject"><button class="danger" data-g1="reject" ${canAct('g1_accept_brief') ? '' : 'disabled'}>Reject</button></div>
  </div>`;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-g1]');
  if (!b) return;
  if (b.dataset.g1 === 'approve') decide({ gate: 'g1_accept_brief', action: 'approve' });
  else decide({ gate: 'g1_accept_brief', action: 'reject', notes: $('#g1-notes').value });
});

// ----- G2 -----

function renderG2(j) {
  if (j.stages.g2_approve_primary.status !== 'waiting') return '';
  const primary = state.meta.config.locales.primary;
  const manual = j.mode === 'shadow' || !state.meta.config.rollout.aiDrafting;
  const rows = j.context.channels.map((spec) => {
    const key = `${spec.id}:${primary}`;
    const p = j.drafts.find((d) => d.channel === spec.id && d.locale === primary);
    const pick = manual ? null : p?.variants.find((v) => !v.violations.some((x) => x.severity === 'block'));
    const variants = manual || !p ? '' : `<div class="variants">${p.variants.map((v) => {
      const blocked = v.violations.some((x) => x.severity === 'block');
      return `<label class="variant ${blocked ? 'blocked' : ''}">
        <input type="radio" name="v-${esc(key)}" value="${esc(v.id)}" ${blocked ? 'disabled' : ''} ${pick?.id === v.id ? 'checked' : ''}> ${esc(v.id)}
        ${Object.entries(v.fields).map(([k, val]) => `<span class="f"><b>${esc(k)}</b>${esc(val)}</span>`).join('')}
        ${v.violations.map((x) => `<span class="violation ${x.severity}">${x.severity === 'block' ? 'Blocked' : 'Warning'}: ${esc(x.field ?? '')} ${esc(x.message)}</span>`).join('')}
        ${v.trace ? `<span class="trace">${esc(v.trace.promptVersion)} / ${esc(v.trace.modelId)}@${esc(v.trace.modelVersion)} / ${esc(v.trace.inputHash)}</span>` : ''}
      </label>`;
    }).join('')}</div>`;
    const edit = spec.fields.map((f) => fieldInput(f.name, key, f, pick?.fields[f.name] ?? '')).join('');
    return `<div class="placement" data-key="${esc(key)}"><h4>${esc(spec.label)} <span class="muted small">${esc(spec.register)}</span></h4>${variants}
      <div class="muted small">${manual ? 'Write the copy' : 'Final copy (edit if needed)'}</div>${edit}</div>`;
  }).join('');
  const ok = canAct('g2_approve_primary');
  return `<div class="card gate" id="g2">${gateHeader('g2_approve_primary', 'G2 Approve primary copy', manual
      ? (j.mode === 'shadow' ? 'Shadow mode: the AI drafts are hidden and kept for comparison. Write the copy as usual.' : 'Manual path: AI drafting is off.')
      : 'Select a variant for each placement and edit if needed. Blocked variants cannot be selected. * = assumed limit.')}
    ${j.reviewNotes.length ? `<div class="notice">Earlier notes: ${j.reviewNotes.map(esc).join(' / ')}</div>` : ''}
    ${rows}
    <div class="actions"><button class="primary" id="g2-approve" ${ok ? '' : 'disabled'}>Approve copy</button>
      <input class="grow" id="g2-notes" placeholder="Notes for the AI and the writers"><button id="g2-changes" ${ok ? '' : 'disabled'}>Changes required</button></div>
  </div>`;
}

function bindG2(j) {
  const card = $('#g2');
  if (!card) return;
  bindCounters(card);
  $$('input[type="radio"]', card).forEach((r) => r.addEventListener('change', () => {
    const key = r.name.slice(2);
    const placement = j.drafts.find((d) => `${d.channel}:${d.locale}` === key);
    const v = placement.variants.find((x) => x.id === r.value);
    $$(`textarea[data-key="${CSS.escape(key)}"]`, card).forEach((ta) => { ta.value = v.fields[ta.dataset.field] ?? ''; ta.dispatchEvent(new Event('input')); });
  }));
  $('#g2-approve').onclick = () => {
    const selections = {};
    $$('.placement', card).forEach((p) => {
      const key = p.dataset.key;
      const checked = $(`input[type="radio"]:checked`, p);
      const fields = Object.fromEntries($$('textarea[data-field]', p).map((ta) => [ta.dataset.field, ta.value]));
      selections[key] = { variantId: checked?.value, fields };
    });
    decide({ gate: 'g2_approve_primary', action: 'approve', selections });
  };
  $('#g2-changes').onclick = () => decide({ gate: 'g2_approve_primary', action: 'changes_required', notes: $('#g2-notes').value });
}

// ----- G3 -----

function renderG3(j) {
  if (j.stages.g3_approve_secondary.status !== 'waiting' || !state.master) return '';
  const m = state.master;
  const ok = canAct('g3_approve_secondary');
  const facts = Object.entries(m.facts).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const work = j.secondary.map((w) => {
    if (w.status === 'approved') return `<div class="placement"><h4>${esc(w.locale)}: approved by ${esc(w.editor)}</h4></div>`;
    const lastVeto = [...w.history].reverse().find((h) => h.action === 'veto');
    const fields = m.channels.map((spec) => `<div class="placement"><h4>${esc(spec.label)}</h4>${spec.fields.map((f) => fieldInput(f.name, `${w.locale}|${spec.id}`, f, w.fields?.[spec.id]?.[f.name] ?? '', w.direction, w.locale)).join('')}</div>`).join('');
    const checklist = state.meta.config.secondaryChecklist.map((item) => `<label><input type="checkbox" data-check="${esc(item)}"> ${esc(item)}</label>`).join('<br>');
    const assist = w.assist ? `<div class="notice">An optional AI draft exists for this locale, written from the master brief. <button data-assist>Start from the AI draft</button></div>` : '';
    return `<div data-locale="${esc(w.locale)}">
      <h4>${esc(w.locale)} (${esc(w.direction)}) ${w.status === 'returned' ? '<span class="status rejected">returned</span>' : ''}</h4>
      ${lastVeto ? `<div class="notice">Veto: ${esc(lastVeto.notes)}</div>` : ''}
      ${assist}
      ${fields}
      <div class="card"><b>Checklist</b><br>${checklist}</div>
      <div class="actions"><button class="primary" data-g3="approve" ${ok ? '' : 'disabled'}>Approve ${esc(w.locale)}</button>
        <input class="grow" data-g3-notes placeholder="What must change"><button class="danger" data-g3="veto" ${ok ? '' : 'disabled'}>Veto</button></div>
    </div>`;
  }).join('');
  return `<div class="card gate" id="g3">${gateHeader('g3_approve_secondary', 'G3 Approve secondary-locale copy', 'Transcreate from the locked master brief. The primary-locale drafts are not shown here, by design: this runs in parallel with G2.')}
    <div class="grid2"><dl class="facts"><dt>Key message</dt><dd>${esc(m.brief.keyMessage)}</dd><dt>Objective</dt><dd>${esc(m.brief.objective)}</dd><dt>Audience</dt><dd>${esc(m.brief.audience)}</dd><dt>Locked</dt><dd>${esc(m.master?.lockedAt ?? '')} by ${esc(m.master?.lockedBy ?? '')}</dd></dl>
      <dl class="facts">${facts}<dt>Approved claims</dt><dd>${esc(m.approvedClaims.join('; '))}</dd></dl></div>
    ${work}</div>`;
}

function bindG3(j) {
  const card = $('#g3');
  if (!card) return;
  bindCounters(card);
  $$('[data-locale]', card).forEach((block) => {
    const locale = block.dataset.locale;
    const work = j.secondary.find((w) => w.locale === locale);
    const assistButton = $('[data-assist]', block);
    if (assistButton && work?.assist) assistButton.onclick = () => {
      $$('textarea[data-field]', block).forEach((ta) => {
        const channel = ta.dataset.key.split('|')[1];
        ta.value = work.assist[channel]?.[ta.dataset.field] ?? ta.value;
        ta.dispatchEvent(new Event('input'));
      });
    };
    $('[data-g3="approve"]', block).onclick = () => {
      const fields = {};
      $$('textarea[data-field]', block).forEach((ta) => {
        const channel = ta.dataset.key.split('|')[1];
        (fields[channel] ??= {})[ta.dataset.field] = ta.value;
      });
      const checklist = Object.fromEntries($$('[data-check]', block).map((c) => [c.dataset.check, c.checked]));
      decide({ gate: 'g3_approve_secondary', action: 'approve', locale, fields, checklist });
    };
    $('[data-g3="veto"]', block).onclick = () => decide({ gate: 'g3_approve_secondary', action: 'veto', locale, notes: $('[data-g3-notes]', block).value });
  });
}

// ----- G4 -----

function renderG4(j) {
  if (j.stages.g4_publish.status !== 'waiting' || !j.qa) return '';
  const ok = canAct('g4_publish');
  const sorted = [...j.qa.checks].sort((a, b) => Number(a.passed) - Number(b.passed));
  const rows = sorted.map((c) => `<tr><td class="${c.passed ? 'pass' : c.severity === 'block' ? 'fail' : 'warnc'}">${c.passed ? 'pass' : c.severity}</td>
    <td>${esc(c.check)}</td><td>${esc(c.channel ?? '')}</td><td>${esc(c.locale ?? '')}</td><td>${esc(c.message)}</td></tr>`).join('');
  const sample = j.qa.humanSample.map((s) => {
    const out = j.outputs.find((o) => o.channel === s.channel && o.locale === s.locale);
    return `<li>${esc(s.channel)} (${esc(s.locale)}) ${out?.previewUrl ? `<code>${esc(out.previewUrl)}</code>` : ''}</li>`;
  }).join('');
  return `<div class="card gate" id="g4">${gateHeader('g4_publish', 'G4 Publish', 'Pre-publish QA has already checked the staged preview. Check the sample, then publish or schedule.')}
    <p><b>${j.qa.blocking}</b> blocking, <b>${j.qa.warnings}</b> warnings.</p>
    <table><tr><th>Result</th><th>Check</th><th>Channel</th><th>Locale</th><th>Detail</th></tr>${rows}</table>
    <h4 style="margin-top:14px">Sample for a person</h4><ul>${sample}</ul>
    <label><input type="checkbox" id="g4-sample"> I checked these items in the preview</label>
    <div class="actions"><button class="primary" id="g4-publish" ${ok ? '' : 'disabled'}>Publish now</button>
      <input type="datetime-local" id="g4-when" style="width:auto"><button id="g4-schedule" ${ok ? '' : 'disabled'}>Schedule</button></div>
    <div class="actions"><select id="g4-to"><option value="g2_approve_primary">Send back to G2</option><option value="g3_approve_secondary">Send back to G3</option></select>
      <input class="grow" id="g4-notes" placeholder="What must change"><button class="danger" id="g4-back" ${ok ? '' : 'disabled'}>Send back</button></div>
  </div>`;
}

function bindG4() {
  if (!$('#g4')) return;
  const sampleChecked = () => $('#g4-sample').checked;
  $('#g4-publish').onclick = () => decide({ gate: 'g4_publish', action: 'publish', sampleChecked: sampleChecked() });
  $('#g4-schedule').onclick = () => {
    const v = $('#g4-when').value;
    decide({ gate: 'g4_publish', action: 'schedule', sampleChecked: sampleChecked(), scheduledFor: v ? new Date(v).toISOString() : undefined });
  };
  $('#g4-back').onclick = () => decide({ gate: 'g4_publish', action: 'send_back', to: $('#g4-to').value, notes: $('#g4-notes').value });
}

// ----- Outputs, report, audit -----

function renderOutputs(j) {
  if (!j.outputs.length) return '';
  const deferred = j.outputs.some((o) => o.status === 'deferred');
  const rows = j.outputs.map((o) => {
    const live = o.target === 'content-store' && ['published', 'scheduled'].includes(o.status);
    return `<tr><td>${esc(o.channel)}</td><td>${esc(o.locale)}</td><td>${esc(o.target)}</td><td>${esc(o.status)}</td>
      <td class="small muted">${esc(shortPath(o.ref ?? o.error ?? ''))}</td>
      <td>${live ? `<button class="danger" data-revert="${esc(o.channel)}|${esc(o.locale)}">Revert</button>` : ''}</td></tr>`;
  }).join('');
  const incidents = j.incidents.map((i) => `<div class="notice">Incident: ${esc(i.channel)} (${esc(i.locale)}) ${esc(i.action)} by ${esc(i.by)}. ${esc(i.reason)}. Check: ${i.relatedOutputs.map((r) => `${esc(r.channel)}/${esc(r.locale)}`).join(', ')}</div>`).join('');
  return `<div class="card" id="outputs"><header><h3>Outputs</h3>
      ${deferred ? '<button class="primary" id="retry">Retry deferred outputs</button>' : ''}</header>
    ${j.fallbackPack ? `<div class="muted small">Fallback pack: <code>${esc(shortPath(j.fallbackPack))}</code></div>` : ''}
    <table><tr><th>Channel</th><th>Locale</th><th>Target</th><th>Status</th><th>Reference</th><th></th></tr>${rows}</table>${incidents}</div>`;
}

function bindOutputs(j) {
  const retry = $('#retry');
  if (retry) retry.onclick = async () => refresh(await api(`/api/jobs/${j.id}/retry-deferred`, { actor: actor() }));
  $$('[data-revert]').forEach((b) => (b.onclick = async () => {
    const [channel, locale] = b.dataset.revert.split('|');
    const reason = prompt(`Why revert ${channel} (${locale})?`);
    if (!reason) return;
    refresh(await api(`/api/jobs/${j.id}/revert`, { actor: actor(), channel, locale, reason }));
  }));
}

function renderReport(j) {
  const r = j.report;
  if (!r) return '';
  const pct = (v) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
  const m = [
    ['Errors at publish', r.errorsAtPublish],
    ['Rule blocks before review', r.ruleBlocksCaught],
    ['Review rounds at G2', r.reviewRounds],
    ['Sent back from G4', r.sendBacks],
    ['First-pass acceptance', pct(r.firstPassAcceptance)],
    ['Turnaround', r.turnaroundHours === null ? 'n/a' : `${r.turnaroundHours} h`],
    ['AI-assisted / written', `${r.aiAssistedPlacements} / ${r.humanWrittenPlacements}`],
    ...(r.shadowSimilarity === null || r.shadowSimilarity === undefined ? [] : [['Shadow: similarity to AI draft', pct(r.shadowSimilarity)]]),
  ];
  return `<div class="card"><h3>Report</h3><div class="metrics">${m.map(([k, v]) => `<div class="metric"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div></div>`;
}

function renderAudit() {
  const rows = state.audit.map((e) => `<div>${esc(e.at.slice(5, 19).replace('T', ' '))} <span class="badge ${esc(e.actorKind)}">${esc(e.actorKind)}</span>${esc(e.stage)}: ${esc(e.event)} <span class="muted">${esc(e.actor)}${e.details?.note ? `, ${esc(e.details.note)}` : ''}</span></div>`).join('');
  return `<details class="card"><summary><b>Audit trail</b> <span class="muted">(${state.audit.length} events)</span></summary><div class="audit">${rows}</div></details>`;
}

// ---------- New request ----------

async function openBriefForm() {
  const b = await api('/api/sample-brief');
  const launch = new Date(b.launchAt);
  const local = new Date(launch.getTime() - launch.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const locales = [state.meta.config.locales.primary, ...state.meta.config.locales.secondary.map((s) => s.code)];
  const input = (name, label, value, type = 'text') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}"></label>`;
  $('#brief-form').innerHTML = `<h3>New request</h3><p class="muted small">Required fields stop gaps at intake. The sample values are placeholders.</p>
    ${input('title', 'Title', b.title)}
    <div class="row">${input('brandId', 'Brand ID', b.brandId)}${input('productIds', 'Product IDs (comma separated)', b.productIds.join(', '))}</div>
    <label>Objective<textarea name="objective">${esc(b.objective)}</textarea></label>
    <div class="row"><label>Audience<textarea name="audience">${esc(b.audience)}</textarea></label><label>Key message<textarea name="keyMessage">${esc(b.keyMessage)}</textarea></label></div>
    <div class="row">${input('offer', 'Offer (empty = none)', b.offer)}${input('cta', 'Call to action', b.cta)}</div>
    <div class="row">${input('tone', 'Tone profile', b.tone)}${input('launchAt', 'Launch', local, 'datetime-local')}</div>
    ${input('landingUrl', 'Landing URL', b.landingUrl, 'url')}
    <label>Channels<div class="checks">${state.meta.channels.map((c) => `<label><input type="checkbox" name="channels" value="${c.id}" ${b.channels.includes(c.id) ? 'checked' : ''}>${esc(c.label)}</label>`).join('')}</div></label>
    <label>Locales<div class="checks">${locales.map((l) => `<label><input type="checkbox" name="locales" value="${l}" ${b.locales.includes(l) ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div></label>
    <div class="actions"><button class="primary" value="submit">Submit as requester</button><button value="cancel" formnovalidate>Cancel</button></div>`;
  const dialog = $('#brief-dialog');
  dialog.showModal();
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'submit') return;
    const f = new FormData($('#brief-form'));
    const brief = {
      title: f.get('title'), requester: 'requester@example.com', brandId: f.get('brandId'),
      productIds: String(f.get('productIds')).split(',').map((s) => s.trim()).filter(Boolean),
      objective: f.get('objective'), audience: f.get('audience'), keyMessage: f.get('keyMessage'),
      offer: f.get('offer'), cta: f.get('cta'), tone: f.get('tone'),
      launchAt: f.get('launchAt') ? new Date(f.get('launchAt')).toISOString() : '',
      landingUrl: f.get('landingUrl'), channels: f.getAll('channels'), locales: f.getAll('locales'),
    };
    const job = await api('/api/jobs', { brief, actor: { name: 'Requester', role: 'requester' } });
    if (job.status === 'rejected') toast('Intake rejected the brief', [job.stages.intake.note]);
    await refresh(job);
  };
}

boot();
