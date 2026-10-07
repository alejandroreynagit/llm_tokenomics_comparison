const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { models: [], providers: {}, selected: ['gpt-4.1-mini', 'claude-sonnet-4-20250514', 'gemini-2.5-flash'], mode: 'demo', resultView: 'responses', result: null, sample: true, history: [], historyFilter: 'all', rates: {}, creditValue: 0.01, page: 'playground', busy: false };
const defaultPrompt = 'Write a Python function that caches LLM responses using Redis. Include a stable cache key, TTL, and a short explanation.';
let toastTimer;
let historyController;

function icons() { if (globalThis.lucide) lucide.createIcons(); }
function escapeHTML(value) { const element = document.createElement('span'); element.textContent = String(value ?? ''); return element.innerHTML; }
function modelById(modelId) { return state.models.find(model => model.id === modelId); }
function ratesFor(model) { return state.rates[model.id] || { input: model.input, output: model.output }; }
function renderWorkspaceVisual() {
  const canvas = $('#workspace-visual');
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const maxRate = Math.max(...state.models.map(model => ratesFor(model).output), 1);
  state.models.forEach((model, index) => {
    const height = 40 + ratesFor(model).output / maxRate * 180;
    context.fillStyle = { green: '#81bb95', orange: '#dab58e', blue: '#90afc6' }[model.color];
    context.fillRect(35 + index * 53, canvas.height - height, 27, height);
  });
}
function dollars(value, digits = 5) { return '$' + Number(value || 0).toFixed(digits); }
function number(value) { return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
function tokens(text) { return Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 3)); }
function providerIcon(provider) { return provider === 'OpenAI' ? 'flower' : provider === 'Anthropic' ? 'sun' : 'sparkles'; }
function modelMark(model) { return `<span class="model-mark ${escapeHTML(model.color)}"><i data-lucide="${providerIcon(model.provider)}"></i></span>`; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000); }

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) {
    const detail = Array.isArray(data.detail) ? data.detail.map(item => `${item.loc.at(-1)}: ${item.msg}`).join('; ') : data.detail;
    throw new Error(detail || 'The request failed. Please try again.');
  }
  return data;
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('tokenwise-settings') || '{}');
    state.rates = Object.fromEntries(Object.entries(saved.rates || {}).filter(([modelId, rate]) => modelById(modelId) && Number.isFinite(rate.input) && Number.isFinite(rate.output) && rate.input >= 0 && rate.output >= 0 && rate.input <= 1000 && rate.output <= 1000));
    if (Number.isFinite(saved.creditValue) && saved.creditValue > 0 && saved.creditValue <= 1000) state.creditValue = saved.creditValue;
  } catch { state.rates = {}; }
}

function requestFromForm() {
  return { prompt: $('#prompt').value.trim(), system: $('#system-prompt').value, models: [...state.selected], mode: state.mode, objective: $('#objective').value, temperature: Number($('#temperature').value), max_tokens: Number($('#max-tokens').value), budget: Number($('#budget').value), credit_value: state.creditValue, format: $('#format').value, keywords: $('#keywords').value.split(',').map(term => term.trim()).filter(Boolean), rates: state.rates };
}

function updateEstimate() {
  const inputTokens = tokens($('#prompt').value + $('#system-prompt').value);
  const outputTokens = Number($('#max-tokens').value) || 0;
  const estimated = state.selected.reduce((total, modelId) => {
    const model = modelById(modelId);
    if (!model) return total;
    const rate = ratesFor(model);
    return total + (inputTokens * rate.input + outputTokens * rate.output) / 1000000;
  }, 0);
  $('#prompt-token-count').textContent = `~${number(tokens($('#prompt').value))} input tokens`;
  $('#prompt-char-count').textContent = `${number($('#prompt').value.length)} / 20,000`;
  $('#batch-estimate').innerHTML = `Est. max <strong>${dollars(estimated)}</strong>`;
  $('#batch-estimate').title = 'Approximate batch cost at the output limit, not a provider billing cap.';
  $('#batch-estimate').style.color = estimated > Number($('#budget').value) ? '#b66c4b' : '';
  $('#temperature-value').value = $('#temperature').value;
  $('#temperature').style.background = `linear-gradient(to right,#698f7a ${Number($('#temperature').value) * 50}%,#e4eae5 ${Number($('#temperature').value) * 50}%)`;
}

function renderModels() {
  renderWorkspaceVisual();
  $('#model-selectors').style.gridTemplateColumns = state.selected.length === 4 && innerWidth > 1000 ? 'repeat(2,minmax(0,1fr))' : '';
  $('#selection-count').textContent = `${state.selected.length} / 4`;
  $('#edit-models').disabled = state.selected.length >= 4 || state.busy;
  $('#model-selectors').innerHTML = state.selected.map((modelId, index) => {
    const model = modelById(modelId);
    const rate = ratesFor(model);
    return `<div class="model-selector">${modelMark(model)}<div class="model-selector-info"><select aria-label="Comparison model ${index + 1}" data-model-index="${index}" ${state.busy ? 'disabled' : ''}>${state.models.map(option => `<option value="${escapeHTML(option.id)}" ${option.id === modelId ? 'selected' : ''} ${state.selected.includes(option.id) && option.id !== modelId ? 'disabled' : ''}>${escapeHTML(option.name)}</option>`).join('')}</select><div class="model-rate">${dollars(rate.input, 2)} in <span>/</span> ${dollars(rate.output, 2)} out <span>/ 1M tokens</span></div></div><button type="button" class="remove-model" data-remove-model="${index}" aria-label="Remove ${escapeHTML(model.name)}" title="Remove model" ${state.selected.length <= 2 || state.busy ? 'hidden' : ''}><i data-lucide="x"></i></button></div>`;
  }).join('');
  $$('[data-model-index]').forEach(select => select.addEventListener('change', () => { state.selected[Number(select.dataset.modelIndex)] = select.value; renderModels(); updateEstimate(); }));
  $$('[data-remove-model]').forEach(button => button.addEventListener('click', () => { if (state.selected.length > 2 && !state.busy) { state.selected.splice(Number(button.dataset.removeModel), 1); renderModels(); updateEstimate(); } }));
  icons();
  updateEstimate();
}

function renderedOutput(text, format = state.result?.request.format) {
  if (format === 'json') return `<pre><code>${escapeHTML(text)}</code></pre>`;
  if (globalThis.marked && globalThis.DOMPurify) return DOMPurify.sanitize(marked.parse(text, { breaks: true }), { FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input', 'button'] });
  return `<div style="white-space:pre-wrap">${escapeHTML(text)}</div>`;
}

function renderSummary() {
  const result = state.result;
  const successful = result?.results.filter(item => !item.error) || [];
  const providers = [...new Set((result?.results || []).map(item => item.provider))];
  $('#metric-models').innerHTML = `${String(result?.results.length || state.selected.length).padStart(2, '0')}<span>across ${providers.length || 3} providers</span>`;
  $('#metric-provider-names').textContent = providers.length ? providers.join(', ') : 'OpenAI, Anthropic, Google';
  $('#metric-cost').textContent = dollars(result?.total_cost);
  $('#metric-credits').innerHTML = `${number((result?.total_cost || 0) / (result?.request.credit_value || state.creditValue))} credits <span class="muted">/ ${result?.request.mode === 'demo' ? 'simulated' : 'estimated'}</span>`;
  const fastest = successful.length ? successful.reduce((best, item) => item.latency < best.latency ? item : best) : null;
  $('#metric-latency').innerHTML = `${fastest ? fastest.latency.toFixed(2) : '0.00'}<span>s</span>`;
  $('#metric-fastest').textContent = fastest ? fastest.name + (result.request.mode === 'demo' ? ' / simulated' : '') : 'Awaiting comparison';
  $('#metric-savings').innerHTML = `${result?.recommendation.savings || 0}<span>%</span><span class="savings-arrow"><i data-lucide="trending-down"></i></span>`;
}

function renderResults() {
  renderSummary();
  const result = state.result;
  $('#export-button').disabled = !result || state.busy;
  $('#experiment-description').textContent = !result ? 'Untitled experiment' : state.sample ? 'Response caching / sample experiment' : `Experiment ${result.id.slice(0, 8)} / ${result.request.mode === 'demo' ? 'Demo' : 'Live API'}`;
  $('#results-badge').textContent = state.sample ? 'SAMPLE RUN' : result?.request.mode === 'demo' ? 'DEMO RUN' : 'LIVE RUN';
  $('#results-badge').hidden = !result;
  if (!result) {
    $('#results-container').innerHTML = '<div class="empty-state"><i data-lucide="flask-conical"></i><h3>No results yet</h3><p>Ready for a new experiment.</p></div>';
    $('#recommendation').hidden = true;
    icons(); return;
  }
  const winner = result.recommendation.winner;
  if (state.resultView === 'responses') {
    $('#results-container').innerHTML = `<div class="response-grid" style="${result.results.length === 4 && innerWidth > 760 ? 'grid-template-columns:repeat(2,minmax(0,1fr))' : ''}">${result.results.map(item => {
      const won = winner === item.id;
      const passed = !item.error && item.checks.every(check => check.passed);
      return `<article class="response-card ${won ? 'winner' : ''}"><div class="response-card-top">${modelMark(item)}<div><div class="response-model-name">${escapeHTML(item.name)}</div><div class="response-provider">${escapeHTML(item.provider)}</div></div>${won ? '<span class="winner-badge"><i data-lucide="badge-check"></i>BEST VALUE</span>' : ''}<button class="icon-button copy-button" data-copy="${escapeHTML(item.id)}" aria-label="Copy ${escapeHTML(item.name)} response" title="Copy response" ${item.error ? 'disabled' : ''}><i data-lucide="copy"></i></button></div><div class="response-metrics"><div><span>Run cost</span><strong>${item.error ? '--' : dollars(item.cost)}</strong></div><div><span>Latency</span><strong>${item.error ? '--' : item.latency.toFixed(2) + ' <em>s</em>'}</strong></div><div><span>Tokens <span title="Input + output">in + out</span></span><strong>${item.error ? '--' : number(item.input_tokens) + ' <em>+ ' + number(item.output_tokens) + '</em>'}</strong></div></div><div class="response-body">${item.error ? `<p class="error-output">${escapeHTML(item.error)}</p>` : renderedOutput(item.text)}</div><div class="response-status ${passed ? '' : 'failed'}" title="${escapeHTML(item.error || item.checks.map(check => `${check.name}: ${check.passed ? 'passed' : 'failed'}`).join('; '))}"><i data-lucide="${passed ? 'circle-check' : 'circle-alert'}"></i>${item.error ? 'Provider error' : passed ? `${item.checks.length} / ${item.checks.length} checks passed` : `${item.checks.filter(check => check.passed).length} / ${item.checks.length} checks passed`}<span class="token-source">${item.error ? 'No cost recorded' : item.token_source === 'simulated' ? 'Simulated output' : item.token_source === 'provider' ? 'Provider token counts' : 'Estimated token counts'}</span></div></article>`;
    }).join('')}</div>`;
    $$('[data-copy]').forEach(button => button.addEventListener('click', async () => {
      const item = result.results.find(item => item.id === button.dataset.copy);
      try { await navigator.clipboard.writeText(item.text); toast('Response copied'); } catch { toast('Clipboard access is unavailable in this browser.'); }
    }));
  } else {
    $('#results-container').innerHTML = `<div class="metrics-table-wrapper"><table class="data-table"><thead><tr><th>Model</th><th>Input tokens</th><th>Output tokens</th><th>Latency</th><th>Estimated cost</th><th>Value score</th><th>Checks</th></tr></thead><tbody>${result.results.map(item => `<tr><td><span class="table-model">${modelMark(item)}${escapeHTML(item.name)}${item.id === winner ? '<i data-lucide="badge-check"></i>' : ''}</span></td><td>${item.error ? '--' : number(item.input_tokens)}</td><td>${item.error ? '--' : number(item.output_tokens)}</td><td>${item.error ? '--' : item.latency.toFixed(2) + 's'}</td><td>${item.error ? '--' : dollars(item.cost)}</td><td>${item.score === undefined ? '--' : item.score + ' / 100'}</td><td><span class="pass-badge ${item.error || !item.checks.every(check => check.passed) ? 'fail' : ''}">${item.error ? 'Error' : item.checks.filter(check => check.passed).length + ' / ' + item.checks.length}</span></td></tr>`).join('')}</tbody></table></div>`;
  }
  const winnerModel = result.results.find(item => item.id === winner);
  const objective = { balanced: '70% COST / 30% SPEED', cost: 'LOWEST COST', speed: 'LOWEST LATENCY' }[result.request.objective];
  $('#recommendation').hidden = false;
  $('#recommendation').innerHTML = `<span class="recommendation-icon"><i data-lucide="${winner ? 'lightbulb' : 'circle-alert'}"></i></span><div class="recommendation-content"><div class="recommendation-heading"><h3>${winnerModel ? `${result.request.mode === 'demo' ? 'Demo pick' : 'Recommended'}: ${escapeHTML(winnerModel.name)}` : 'No qualifying model'}</h3><span>${objective}</span></div><p>${result.request.mode === 'demo' ? 'Illustrative only: these are fixed caching examples with simulated latency, not answers to your prompt. ' : ''}${escapeHTML(result.recommendation.reason)}</p></div>${winner ? `<div class="recommendation-stat"><strong>${result.recommendation.runs === null ? 'Unlimited*' : number(result.recommendation.runs)}</strong><small>estimated runs / ${dollars(result.request.budget, 2)} budget</small></div>` : ''}`;
  icons();
}

async function refreshHistory() {
  try { state.history = await api('/api/history'); $('#history-count').textContent = state.history.length; if (state.page === 'experiments') renderHistory(); }
  catch (error) { toast('History could not be loaded: ' + error.message); }
}

function renderHistory() {
  historyController?.abort();
  historyController = new AbortController();
  const query = $('#history-search').value.toLowerCase().trim();
  const history = state.history.filter(item => (state.historyFilter === 'all' || item.request.mode === state.historyFilter) && (item.request.prompt + ' ' + item.results.map(result => result.name).join(' ')).toLowerCase().includes(query));
  $('#clear-history').disabled = !state.history.length;
  if (!history.length) {
    $('#history-list').innerHTML = `<div class="empty-state"><i data-lucide="history"></i><h3>${state.history.length ? 'No matching experiments' : 'A clean slate'}</h3><p>${state.history.length ? 'No runs match this filter.' : 'Your saved comparisons will appear here.'}</p><button class="button secondary" id="history-start"><i data-lucide="plus"></i>New experiment</button></div>`;
    $('#history-start').addEventListener('click', () => { navigate('playground'); $('#prompt').focus(); }, { signal: historyController.signal });
  } else {
    $('#history-list').innerHTML = history.map(item => `<article class="history-entry"><span class="model-mark"><i data-lucide="flask-conical"></i></span><div class="history-entry-main"><h3>${escapeHTML(item.request.prompt)}</h3><div class="history-entry-meta"><span>${new Date(item.created).toLocaleString()}</span><span>${item.results.length} models</span><span class="pass-badge">${item.request.mode.toUpperCase()}</span><span>${escapeHTML(item.results.find(result => result.id === item.recommendation.winner)?.name || 'No qualifying model')}</span></div></div><div class="history-entry-cost">${dollars(item.total_cost)}<small>estimated run cost</small></div><button class="button secondary" data-open-run="${escapeHTML(item.id)}">Open<i data-lucide="arrow-up-right"></i></button></article>`).join('');
    $$('[data-open-run]').forEach(button => button.addEventListener('click', () => {
      const result = state.history.find(item => item.id === button.dataset.openRun);
      state.result = result; state.sample = false; state.selected = [...result.request.models];
      $('#prompt').value = result.request.prompt; $('#system-prompt').value = result.request.system;
      $('#objective').value = result.request.objective; $('#temperature').value = result.request.temperature;
      $('#max-tokens').value = result.request.max_tokens; $('#budget').value = result.request.budget;
      $('#format').value = result.request.format; $('#keywords').value = result.request.keywords.join(', ');
      setMode(result.request.mode); renderModels(); renderResults(); navigate('playground');
      toast('Saved result opened. A new run uses your current rate cards.');
    }, { signal: historyController.signal }));
  }
  icons();
}

function navigate(pageName) {
  state.page = pageName;
  $$('.page').forEach(page => { page.hidden = page.id !== `page-${pageName}`; page.classList.toggle('active', !page.hidden); });
  $$('[data-page]').forEach(button => { button.classList.toggle('active', button.dataset.page === pageName); button.setAttribute('aria-current', button.dataset.page === pageName ? 'page' : 'false'); });
  const name = { playground: 'Playground', experiments: 'Experiments', planner: 'Cost planner' }[pageName];
  $('#breadcrumb-page').textContent = name;
  document.title = `Tokenwise | ${name}`;
  if (pageName === 'experiments') { renderHistory(); refreshHistory(); }
  if (pageName === 'planner') renderPlanner();
  scrollTo({ top: 0, behavior: 'instant' });
}

function renderPlanner() {
  const fields = ['#plan-input', '#plan-output', '#plan-requests', '#plan-budget'].map(selector => $(selector));
  if (fields.some(field => !field.validity.valid || !field.value || !Number.isFinite(Number(field.value)))) return;
  const [inputTokens, outputTokens, requests, budget] = fields.map(field => Number(field.value));
  const rows = state.models.map(model => { const rate = ratesFor(model); const cost = (inputTokens * rate.input + outputTokens * rate.output) / 1000000; return { ...model, cost, monthly: cost * requests, runs: cost ? Math.floor(budget / cost) : null }; }).sort((first, second) => first.monthly - second.monthly);
  const maximum = Math.max(...rows.map(row => row.monthly), 0.01);
  $('#planner-bars').innerHTML = rows.map(row => `<div class="chart-row"><span class="chart-name"><span class="provider-dot ${escapeHTML(row.color)}"></span>${escapeHTML(row.name)}</span><div class="chart-track" role="meter" aria-label="${escapeHTML(row.name)} estimated monthly cost" aria-valuenow="${row.monthly}" aria-valuemin="0" aria-valuemax="${maximum}"><div class="chart-fill ${escapeHTML(row.color)}" style="width:${row.monthly / maximum * 100}%"></div></div><span class="chart-price">${dollars(row.monthly, 2)}</span></div>`).join('');
  $('#planner-table').innerHTML = rows.map(row => `<tr><td><span class="table-model">${modelMark(row)}${escapeHTML(row.name)}</span></td><td>${dollars(row.cost)}</td><td>${dollars(row.monthly, 2)}</td><td>${row.runs === null ? 'Unlimited at zero rate' : number(row.runs)}</td><td><span class="pass-badge ${row.monthly > budget ? 'fail' : ''}">${row.monthly > budget ? 'Over budget' : 'Within budget'}</span></td></tr>`).join('');
  icons();
}

function setMode(mode) {
  state.mode = mode;
  $$('[data-mode]').forEach(button => { button.classList.toggle('selected', button.dataset.mode === mode); button.setAttribute('aria-pressed', String(button.dataset.mode === mode)); });
  $('#mode-notice').innerHTML = mode === 'demo' ? '<span class="status-dot amber"></span>Demo mode <span class="muted">/ fixed samples, no credits spent</span>' : '<span class="status-dot"></span>Live API <span class="muted">/ provider usage is billable</span>';
}

function showConfig(type) {
  const dialog = $('#config-dialog');
  $('#dialog-title').textContent = type === 'providers' ? 'Providers' : type === 'rates' ? 'Rate cards' : 'About this workspace';
  if (type === 'providers') {
    $('#dialog-content').innerHTML = Object.entries({ OpenAI: 'OPENAI_API_KEY', Anthropic: 'ANTHROPIC_API_KEY', Google: 'GOOGLE_API_KEY' }).map(([provider, key]) => `<div class="provider-setting">${modelMark({ provider, color: provider === 'OpenAI' ? 'green' : provider === 'Anthropic' ? 'orange' : 'blue' })}<div><h3>${provider}</h3><code>${key}</code></div><span class="provider-setting-status ${state.providers[provider] ? 'connected' : ''}">${state.providers[provider] ? 'Key configured' : 'Not configured'}</span></div>`).join('') + '<div class="dialog-notice">Credentials are read from server environment variables and never sent to the browser. Configuration status does not validate a key or model availability.<br><br>Live requests go directly from this Python server to the selected providers. Demo runs use fixed samples and do not contact a provider.</div><div class="dialog-foot"><button class="button secondary" id="refresh-providers"><i data-lucide="refresh-cw"></i>Refresh status</button></div>';
    $('#refresh-providers').addEventListener('click', async () => { try { const data = await api('/api/models'); state.providers = data.providers; showConfig('providers'); toast('Provider status updated'); } catch (error) { toast(error.message); } });
  } else if (type === 'rates') {
    $('#dialog-content').innerHTML = `<form id="rates-form"><div class="rate-heading"><span>MODEL</span><span>INPUT $ / 1M</span><span>OUTPUT $ / 1M</span></div>${state.models.map(model => { const rate = ratesFor(model); return `<div class="rate-row"><span>${escapeHTML(model.name)}</span><input aria-label="${escapeHTML(model.name)} input rate" data-rate-model="${escapeHTML(model.id)}" data-rate-type="input" type="number" min="0" max="1000" step="any" required value="${rate.input}"><input aria-label="${escapeHTML(model.name)} output rate" data-rate-model="${escapeHTML(model.id)}" data-rate-type="output" type="number" min="0" max="1000" step="any" required value="${rate.output}"></div>`; }).join('')}<div class="credit-setting"><label for="credit-value">Value of one workspace credit <span class="muted">/ USD</span></label><input id="credit-value" type="number" min="0.000001" max="1000" step="any" value="${state.creditValue}" required></div><div class="dialog-notice">${escapeHTML(state.pricingNote)}<br><br>Workspace credits are a custom USD conversion, not provider-specific credit balances. Saved runs retain the rates used at the time.</div><div class="dialog-foot"><button class="button secondary" type="button" id="reset-rates"><i data-lucide="rotate-ccw"></i>Reset defaults</button><button class="button primary" type="submit"><i data-lucide="check"></i>Save rates</button></div></form>`;
    $('#rates-form').addEventListener('submit', event => {
      event.preventDefault();
      const rates = {};
      $$('[data-rate-model]').forEach(input => { rates[input.dataset.rateModel] ||= {}; rates[input.dataset.rateModel][input.dataset.rateType] = Number(input.value); });
      state.rates = rates; state.creditValue = Number($('#credit-value').value);
      try { localStorage.setItem('tokenwise-settings', JSON.stringify({ rates: state.rates, creditValue: state.creditValue })); } catch { toast('Rates applied for this session; browser storage unavailable.'); }
      renderModels(); renderPlanner(); dialog.close(); toast('Rate cards updated');
    });
    $('#reset-rates').addEventListener('click', () => { $$('[data-rate-model]').forEach(input => { input.value = modelById(input.dataset.rateModel)[input.dataset.rateType]; }); $('#credit-value').value = 0.01; });
  } else {
    $('#dialog-content').innerHTML = '<div class="dialog-notice" style="margin-top:0"><strong>Tokenwise / Developer workspace</strong><br>Python backend. HTML + JavaScript frontend.<br><br><strong>Recommendation policy</strong><br>Only complete responses passing your checks are ranked. Balanced value weighs relative cost at 70% and relative response speed at 30%. Cost and speed modes use their respective metric alone. These checks do not establish factual correctness or code quality.<br><br><strong>Data & billing</strong><br>Prompts and responses are saved locally in SQLite, including live runs. Server keys are never included in exports. Costs are estimates using editable rates, not billing statements. The budget guard uses approximate input tokens and a maximum output allowance; it cannot guarantee a provider billing cap.<br><br>Demo responses and latency are simulated. This workspace has no authentication and is intended for localhost only.</div><div class="dialog-foot"><a class="button secondary" href="/api/docs" target="_blank" rel="noopener"><i data-lucide="braces"></i>API reference<i data-lucide="arrow-up-right"></i></a></div>';
  }
  icons();
  if (!dialog.open) dialog.showModal();
}

const presets = [
  { name: 'Response caching', detail: 'Python / Redis / infrastructure', icon: 'database', prompt: defaultPrompt, format: 'text', keywords: '' },
  { name: 'Structured extraction', detail: 'JSON / schema / data extraction', icon: 'braces', prompt: 'Extract the name, role, and skills from this profile as valid JSON with keys name, role, and skills. Profile: Alex Morgan is a backend engineer experienced in Python, PostgreSQL, and Redis. Return JSON only.', format: 'json', keywords: 'name, skills' },
  { name: 'Code review', detail: 'Python / security / reliability', icon: 'scan-code', prompt: 'Review this Python code for correctness and security. Give a concise explanation and a corrected version.\n\ndef find_user(db, name):\n    return db.execute("SELECT * FROM users WHERE name = \'" + name + "\'").fetchone()', format: 'text', keywords: '' },
  { name: 'Technical summary', detail: 'Architecture / tradeoffs / clarity', icon: 'file-text', prompt: 'Summarize the tradeoffs of a monolith versus microservices for a five-person engineering team. Cover operational cost, deployment complexity, and when to split services. Keep your answer under 200 words.', format: 'text', keywords: '' }
];

function showPresets() {
  $('#preset-list').innerHTML = presets.map((preset, index) => `<button class="preset-item" data-preset="${index}"><i data-lucide="${preset.icon}"></i><div><strong>${escapeHTML(preset.name)}</strong><small>${escapeHTML(preset.detail)}</small></div><i data-lucide="arrow-up-right"></i></button>`).join('');
  $$('[data-preset]').forEach(button => button.addEventListener('click', () => { const preset = presets[Number(button.dataset.preset)]; $('#prompt').value = preset.prompt; $('#format').value = preset.format; $('#keywords').value = preset.keywords; updateEstimate(); $('#preset-dialog').close(); $('#prompt').focus(); toast(`${preset.name} preset loaded`); }));
  icons(); $('#preset-dialog').showModal();
}

function setBusy(busy) {
  state.busy = busy;
  $$('#comparison-form input, #comparison-form textarea, #comparison-form select, #comparison-form button').forEach(element => { element.disabled = busy; });
  ['#load-preset', '#new-experiment', '#export-button', '#rates-nav', '#planner-rates', '#pricing-info'].forEach(selector => { $(selector).disabled = busy; });
  $('#run-button').innerHTML = busy ? '<span class="spinner"></span><span>Comparing...</span>' : '<i data-lucide="play"></i><span>Run comparison</span><span class="button-key">&#8629;</span>';
  $('.results-section').setAttribute('aria-busy', String(busy));
  renderModels();
}

function bindEvents() {
  $$('[data-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)));
  $$('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
  $$('[data-result-view]').forEach(button => button.addEventListener('click', () => { state.resultView = button.dataset.resultView; $$('[data-result-view]').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', String(item === button)); }); renderResults(); }));
  $$('[data-history-filter]').forEach(button => button.addEventListener('click', () => { state.historyFilter = button.dataset.historyFilter; $$('[data-history-filter]').forEach(item => item.classList.toggle('selected', item === button)); renderHistory(); }));
  $('#history-search').addEventListener('input', renderHistory);
  $('#providers-nav').addEventListener('click', () => showConfig('providers'));
  ['#rates-nav', '#pricing-info', '#planner-rates'].forEach(selector => $(selector).addEventListener('click', () => showConfig('rates')));
  ['#help-button', '#workspace-button', '#profile-button'].forEach(selector => $(selector).addEventListener('click', () => showConfig('about')));
  $('#close-dialog').addEventListener('click', () => $('#config-dialog').close());
  $('#close-presets').addEventListener('click', () => $('#preset-dialog').close());
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
  $('#load-preset').addEventListener('click', showPresets);
  $('#system-toggle').addEventListener('click', () => { const field = $('#system-field'); field.hidden = !field.hidden; $('#system-toggle').setAttribute('aria-expanded', String(!field.hidden)); if (!field.hidden) $('#system-prompt').focus(); });
  $('#edit-models').addEventListener('click', () => { const available = state.models.find(model => !state.selected.includes(model.id)); if (available && state.selected.length < 4) { state.selected.push(available.id); renderModels(); toast(`${available.name} added`); } });
  ['#prompt', '#system-prompt', '#max-tokens', '#temperature', '#budget'].forEach(selector => $(selector).addEventListener('input', updateEstimate));
  ['#plan-input', '#plan-output', '#plan-requests', '#plan-budget'].forEach(selector => $(selector).addEventListener('input', renderPlanner));
  $('#new-experiment').addEventListener('click', () => { state.result = null; state.sample = false; $('#prompt').value = ''; $('#system-prompt').value = 'You are a helpful, precise assistant.'; $('#format').value = 'text'; $('#keywords').value = ''; $('#run-error').hidden = true; renderResults(); updateEstimate(); $('#prompt').focus(); });
  $('#export-button').addEventListener('click', () => { if (!state.result) return; const blob = new Blob([JSON.stringify(state.result, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `tokenwise-${state.result.id.slice(0, 8)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Experiment exported'); });
  $('#clear-history').addEventListener('click', () => {
    if (!state.history.length) return;
    $('#dialog-title').textContent = 'Clear experiment history?';
    $('#dialog-content').innerHTML = '<div class="dialog-notice">All saved prompts and responses in this local workspace will be deleted. This cannot be undone.</div><div class="dialog-foot"><button class="button secondary" id="cancel-clear">Cancel</button><button class="button primary" id="confirm-clear"><i data-lucide="trash-2"></i>Delete history</button></div>';
    icons(); $('#config-dialog').showModal();
    $('#cancel-clear').addEventListener('click', () => $('#config-dialog').close());
    $('#confirm-clear').addEventListener('click', async () => { try { await api('/api/history', { method: 'DELETE' }); await refreshHistory(); $('#config-dialog').close(); toast('Experiment history cleared'); } catch (error) { toast(error.message); } });
  });
  $('#comparison-form').addEventListener('submit', async event => {
    event.preventDefault(); if (state.busy) return;
    const request = requestFromForm();
    if (!request.prompt) { $('#prompt').setCustomValidity('Enter a prompt before running a comparison.'); $('#prompt').reportValidity(); $('#prompt').setCustomValidity(''); return; }
    if (request.keywords.length > 10 || request.keywords.some(term => term.length > 80)) { $('#run-error').textContent = 'Use at most 10 required terms, each 80 characters or fewer.'; $('#run-error').hidden = false; return; }
    $('#run-error').hidden = true; setBusy(true);
    try {
      const result = await api('/api/compare', { method: 'POST', body: JSON.stringify(request) });
      state.result = result; state.sample = false; renderResults(); await refreshHistory();
      toast(result.results.some(item => item.error) ? 'Comparison completed with provider errors' : 'Comparison saved');
    } catch (error) { $('#run-error').textContent = error.message; $('#run-error').hidden = false; }
    finally { setBusy(false); $('#export-button').disabled = !state.result; }
  });
  addEventListener('resize', () => { if (state.models.length) { renderModels(); if (state.result) renderResults(); } });
}

async function init() {
  document.body.classList.add('initializing');
  $('#run-button').disabled = true; icons();
  try {
    const catalog = await api('/api/models');
    state.models = catalog.models; state.providers = catalog.providers; state.pricingNote = catalog.pricing_note;
  loadSettings(); renderModels(); bindEvents(); setMode('demo');
    state.result = await api('/api/example'); renderResults();
    await refreshHistory();
  } catch (error) { $('#run-error').textContent = 'Unable to load the workspace: ' + error.message; $('#run-error').hidden = false; $('#results-container').innerHTML = '<div class="empty-state"><h3>Server unavailable</h3><p>Reload when the local server is running.</p></div>'; }
  finally { document.body.classList.remove('initializing'); $('#run-button').disabled = !state.models.length; }
}

init();