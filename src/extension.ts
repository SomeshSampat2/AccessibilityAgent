import * as vscode from 'vscode';
import { diffLines, Change, applyPatch } from 'diff';
import { getPresetRules, RulesPreset } from './rules';

let lastAppliedBackup: { uri: string; content: string } | null = null;

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('accessibleAgent.helloWorld', () => {
    vscode.window.showInformationMessage('Galaxy Accessibility Agent is ready.');
  });
  context.subscriptions.push(disposable);

  const makeAccessibleCmd = vscode.commands.registerCommand(
    'accessibleAgent.makeAccessible',
    async () => {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        vscode.window.showInformationMessage('Open a file to analyze accessibility.');
        return;
      }

      const document = activeEditor.document;
      const fileText = document.getText();
      const uiContext = detectUiContext(document, fileText);

      // Proceed even if not detected as a UI file; treat as 'unknown' to still apply improvements

      const endpoint = getEndpointFromEnvOrSettings();
      const token = resolveConfigValue('SRC_ACCESS_TOKEN', 'accessibleAgent.srcAccessToken');
      let modelId = resolveConfigValue('CODY_MODEL_ID', 'accessibleAgent.modelId');
      if (!modelId) {
        modelId = 'anthropic::2023-06-01::claude-3.5-sonnet';
      }

      if (!endpoint || !token) {
        vscode.window.showErrorMessage('Missing Cody API configuration. Ensure SRC_ENDPOINT and SRC_ACCESS_TOKEN environment variables are set.');
        return;
      }

      const userPrompt = buildUserPrompt({
        fileName: document.fileName,
        languageId: document.languageId,
        uiKind: uiContext.uiKind,
        content: fileText,
      });

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Galaxy Accessibility Agent: Analyzing and proposing accessibility improvements…',
          cancellable: false,
        },
        async () => {
          try {
            // Let user pick a model for this run
            try {
              const models = await listModels({ endpoint, token });
              const picked = await vscode.window.showQuickPick(
                models.map(m => ({ label: (m.id || '').split('::').pop() || m.id, description: m.owned_by || '', id: m.id }) as any),
                { placeHolder: 'Select a model for accessibility edits' }
              );
              if ((picked as any)?.id) {
                modelId = (picked as any).id;
                await vscode.workspace.getConfiguration().update('accessibleAgent.modelId', modelId, vscode.ConfigurationTarget.Global);
              }
            } catch {}

            const result = await callCodyApi({ endpoint, token, modelId, userPrompt });
            const { updatedContent, summary, raw } = extractUpdatedFileAndSummary(result, fileText);
            if (!updatedContent) {
              vscode.window.showInformationMessage('No structured update found. Check the sidebar output.');
              return;
            }
            // Backup then apply edit to current document
            lastAppliedBackup = { uri: document.uri.toString(), content: fileText };
            await applyFullDocumentEdit(activeEditor, updatedContent);
            vscode.window.setStatusBarMessage('Galaxy Accessibility Agent: Edits applied', 3000);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Galaxy Accessibility Agent error: ${message}`);
          }
        }
      );
    }
  );
  context.subscriptions.push(makeAccessibleCmd);

  const provider = new AccessibleAgentSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('accessibleAgent.sidebar', provider)
  );
}

export function deactivate() {}
class AccessibleAgentSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
    };
    webview.html = this.getHtml(webview);

    webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'saveCredentials': {
          const { token, modelId, endpoint, rulesPreset, rulesText } = message.payload ?? {};
          await this.saveCredentials(token, modelId, endpoint, rulesPreset, rulesText);
          this.post({ type: 'status', payload: 'Saved credentials.' });
          // Refresh state to enable the Run button if token is present
          await this.hydrateState();
          break;
        }
        case 'getPresetRules': {
          const preset = (message.payload?.preset || '').trim();
          const rules = getPresetRules(preset as RulesPreset);
          this.post({ type: 'presetRules', payload: rules });
          break;
        }
        case 'makeAccessible': {
          await this.runMakeAccessible(message?.payload);
          break;
        }
        case 'getModels': {
          const endpoint = getEndpointFromEnvOrSettings();
          const tokenFromSecrets = await this.context.secrets.get('accessibleAgent.srcAccessToken');
          const tokenFromEnvOrSettings = resolveConfigValue('SRC_ACCESS_TOKEN', 'accessibleAgent.srcAccessToken');
          const token = tokenFromSecrets || tokenFromEnvOrSettings;
          if (!endpoint || !token) {
            this.post({ type: 'status', payload: 'Missing endpoint or token.' });
            break;
          }
          try {
            this.post({ type: 'status', payload: 'Fetching models…' });
            const models = await listModels({ endpoint, token });
            this.post({ type: 'models', payload: models });
            this.post({ type: 'status', payload: `Loaded ${models.length} models.` });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.post({ type: 'error', payload: message });
          }
          break;
        }
        case 'revertChanges': {
          try {
            await this.handleRevert();
            this.post({ type: 'status', payload: 'Reverted last applied edits.' });
          } catch (e: any) {
            this.post({ type: 'error', payload: e?.message || String(e) });
          }
          break;
        }
        default:
          break;
      }
    });

    // Initial state from settings/secret store
    this.hydrateState();
  }

  private post(msg: any) {
    this.view?.webview.postMessage(msg);
  }

  private async handleRevert(): Promise<void> {
    if (!lastAppliedBackup) {
      throw new Error('Nothing to revert. Make some edits first.');
    }
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      throw new Error('No active editor to revert.');
    }
    const doc = activeEditor.document;
    const targetUri = doc.uri.toString();
    if (lastAppliedBackup.uri !== targetUri) {
      throw new Error('Last edit was for a different file. Open that file to revert.');
    }
    const backup = lastAppliedBackup.content;
    await applyFullDocumentEdit(activeEditor, backup);
    lastAppliedBackup = null;
  }

  private async hydrateState() {
    const config = vscode.workspace.getConfiguration();
    const endpoint = getEndpointFromEnvOrSettings();
    const modelId = resolveConfigValue('CODY_MODEL_ID', 'accessibleAgent.modelId') || 'anthropic::2023-06-01::claude-3.5-sonnet';
    const tokenFromSecrets = await this.context.secrets.get('accessibleAgent.srcAccessToken');
    const tokenFromConfig = config.get<string>('accessibleAgent.srcAccessToken') || '';
    const token = tokenFromSecrets || tokenFromConfig;
    const rulesPreset = this.context.globalState.get<string>('accessibleAgent.rulesPreset') || '';
    const rulesText = this.context.globalState.get<string>('accessibleAgent.rulesText') || '';
    const hasEndpoint = Boolean(endpoint);
    const hasToken = Boolean(token);
    const canRun = hasEndpoint && hasToken;
    this.post({ type: 'hydrate', payload: { endpoint, tokenMasked: maskToken(token), modelId, hasEndpoint, hasToken, canRun, rulesPreset, rulesText } });
    // Try to populate models list if we have configuration
    if (canRun) {
      try {
        const models = await listModels({ endpoint, token });
        this.post({ type: 'models', payload: models });
      } catch {}
    }
  }

  private async saveCredentials(token: string, modelId: string, endpoint?: string, rulesPreset?: string, rulesText?: string) {
    const config = vscode.workspace.getConfiguration();
    // Endpoint is fixed by environment var; do not store
    if (modelId && modelId.trim()) {
      await config.update('accessibleAgent.modelId', modelId.trim(), vscode.ConfigurationTarget.Global);
    }
    if (token && token.trim()) {
      await this.context.secrets.store('accessibleAgent.srcAccessToken', token.trim());
    }
    if (endpoint && endpoint.trim()) {
      await config.update('accessibleAgent.srcEndpoint', endpoint.trim(), vscode.ConfigurationTarget.Global);
    }
    if (typeof rulesPreset === 'string') {
      await this.context.globalState.update('accessibleAgent.rulesPreset', rulesPreset);
    }
    if (typeof rulesText === 'string') {
      await this.context.globalState.update('accessibleAgent.rulesText', rulesText);
    }
  }

  private async runMakeAccessible(payload?: { modelId?: string }) {
    this.post({ type: 'loading', payload: true });
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      this.post({ type: 'status', payload: 'Open a file to analyze.' });
      this.post({ type: 'loading', payload: false });
      return;
    }
    const document = activeEditor.document;
    const fileText = document.getText();
    const uiContext = detectUiContext(document, fileText);
    // Proceed even if not detected as a UI file; treat as generic

    const endpoint = getEndpointFromEnvOrSettings();
    const tokenFromSecrets = await this.context.secrets.get('accessibleAgent.srcAccessToken');
    const tokenFromEnvOrSettings = resolveConfigValue('SRC_ACCESS_TOKEN', 'accessibleAgent.srcAccessToken');
    const token = tokenFromSecrets || tokenFromEnvOrSettings;
    let modelId = payload?.modelId || resolveConfigValue('CODY_MODEL_ID', 'accessibleAgent.modelId') || 'anthropic::2023-06-01::claude-3.5-sonnet';

    if (!endpoint || !token) {
      const missing: string[] = [];
      if (!endpoint) missing.push('SRC_ENDPOINT');
      if (!token) missing.push('SRC_ACCESS_TOKEN or saved token');
      this.post({ type: 'error', payload: 'Missing configuration: ' + missing.join(' and ') + '.' });
      this.post({ type: 'loading', payload: false });
      return;
    }

    // If the file is small enough, process in one shot; otherwise process in chunks
    const totalLines = document.lineCount;
    const configRulesText = (this.context.globalState.get<string>('accessibleAgent.rulesText') || '').trim();
    const CHUNK_MAX_LINES = 300;

    // Step 1: optionally refresh model list (for UI)
    this.post({ type: 'status', payload: 'Fetching models…' });
    try {
      const models = await listModels({ endpoint, token });
      this.post({ type: 'models', payload: models });
    } catch {}

    // Maybe let the user pick a model if not provided
    if (!payload?.modelId) {
      try {
        const models = await listModels({ endpoint, token });
        this.post({ type: 'models', payload: models });
        const picked = await vscode.window.showQuickPick(
          models.map(m => ({ label: (m.id || '').split('::').pop() || m.id, description: m.owned_by || '', id: m.id }) as any),
          { placeHolder: 'Select a model for accessibility edits' }
        );
        if ((picked as any)?.id) {
          modelId = (picked as any).id;
          await vscode.workspace.getConfiguration().update('accessibleAgent.modelId', modelId, vscode.ConfigurationTarget.Global);
        }
      } catch {}
    }

    try {
      if (totalLines <= CHUNK_MAX_LINES) {
        // Single-shot
        const userPrompt = buildUserPrompt({
          fileName: document.fileName,
          languageId: document.languageId,
          uiKind: uiContext.uiKind,
          content: fileText,
          extraRules: configRulesText,
        });
        this.post({ type: 'status', payload: 'Contacting Cody API…' });
        const result = await callCodyApi({ endpoint, token, modelId, userPrompt });
        const { updatedContent, summary, raw } = extractUpdatedFileAndSummary(result, fileText);
        if (!updatedContent) {
          this.post({ type: 'result', payload: raw || result });
        } else {
          // Backup full file before applying (single-shot path)
          lastAppliedBackup = { uri: document.uri.toString(), content: fileText };
          await applyFullDocumentEdit(activeEditor, updatedContent);
          const colored = buildColoredUnifiedDiff(fileText, updatedContent);
          this.post({ type: 'diff', payload: { summary: summary || 'Applied changes', diff: colored } });
        }
      } else {
        // Chunked processing
        const originalFullText = fileText;
        let workingText = originalFullText;
        const chunks: Array<{ start: number; end: number }> = [];
        for (let start = 0; start < totalLines; start += CHUNK_MAX_LINES) {
          const end = Math.min(start + CHUNK_MAX_LINES, totalLines);
          chunks.push({ start, end });
        }

        for (let i = 0; i < chunks.length; i++) {
          const { start, end } = chunks[i];
          this.post({ type: 'status', payload: `Processing chunk ${i + 1}/${chunks.length} (lines ${start + 1}-${end})…` });

          // Re-read current document to ensure we operate on latest content after prior chunk edits
          const currentDoc = activeEditor.document;
          const currentText = currentDoc.getText();
          const currentLines = currentText.split(/\r?\n/);
          const chunkText = currentLines.slice(start, end).join('\n');

          const chunkPrompt = buildChunkPrompt({
            fileName: document.fileName,
            languageId: document.languageId,
            uiKind: uiContext.uiKind,
            chunkIndex: i + 1,
            totalChunks: chunks.length,
            startLineOneBased: start + 1,
            endLineOneBased: end,
            chunkContent: chunkText,
            extraRules: configRulesText,
          });

          const apiResult = await callCodyApi({ endpoint, token, modelId, userPrompt: chunkPrompt });
          const { updatedContent: updatedChunk, raw: rawChunk } = extractUpdatedFileAndSummary(apiResult, chunkText);
          if (!updatedChunk) {
            // If no structured chunk returned, skip applying and continue
            continue;
          }

          // Apply replacement of this chunk's range with updated chunk content
          const rangeToReplace = new vscode.Range(
            currentDoc.lineAt(start).range.start,
            currentDoc.lineAt(end - 1).range.end
          );
          // Backup before applying first chunk across the entire file (original full text)
          if (!lastAppliedBackup) {
            lastAppliedBackup = { uri: document.uri.toString(), content: originalFullText };
          }
          await activeEditor.edit(editBuilder => {
            editBuilder.replace(rangeToReplace, updatedChunk);
          });
          await currentDoc.save();
        }

        // After all chunks, compute diff vs original and show summary
        const finalText = activeEditor.document.getText();
        const colored = buildColoredUnifiedDiff(originalFullText, finalText);
        this.post({ type: 'diff', payload: { summary: `Applied chunked edits in ${chunks.length} chunks.`, diff: colored } });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AccessibleAgent] Cody API error', message);
      this.post({ type: 'error', payload: `Endpoint: ${endpoint}\nModel: ${modelId}\nError: ${message}` });
    } finally {
      this.post({ type: 'loading', payload: false });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';`;
    const styles = `
      <style>
        :root { --bg:#0f172a; --fg:#e2e8f0; --muted:#94a3b8; --accent:#FA4616; --accent2:#FA4616; }
        body { background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, -apple-system; margin: 0; }
        .container { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
        h2 { margin: 0 0 4px; font-size: 15px; }
        .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 10px; }
        label { display:block; color: var(--muted); font-size: 11px; margin-bottom: 4px; }
        input, select, textarea { width: 100%; padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.05); color: var(--fg); }
        button { background: var(--accent); color: #fff; font-weight: 600; border: none; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
        button:hover { filter: brightness(1.05); }
        .row { display:flex; gap: 8px; }
        .status { color: var(--muted); font-size: 11px; }
        .output { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-height: 18vh; overflow: auto; transition: max-height 0.2s ease; }
        .output.expanded { max-height: 65vh; }
        .ghost-btn { background: transparent; color: var(--fg); border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; padding: 6px 8px; cursor: pointer; }
        .badge { display:inline-flex; align-items:center; gap:6px; font-size:11px; color: var(--muted); }
        .rules-box { width: 100%; min-height: 80px; max-height: 200px; resize: vertical; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
    `;
    const script = `
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let maskedTokenFromSaved = '';
        function persistState() {
          const endpoint = (document.getElementById('endpointInput')?.value || '').trim();
          const tokenField = (document.getElementById('token')?.value || '').trim();
          const modelId = (document.getElementById('modelId')?.value || '').trim();
          const rulesPreset = (document.getElementById('rulesPreset')?.value || '').trim();
          const rulesText = (document.getElementById('rulesText')?.value || '').trim();
          vscode.setState({ endpoint, tokenField, modelId, rulesPreset, rulesText });
        }
        function save() {
          const tokenInput = document.getElementById('token');
          const tokenVal = tokenInput.value.trim();
          // If user didn't change the masked token, don't overwrite stored secret
          const token = (!tokenVal || tokenVal === maskedTokenFromSaved || tokenVal.includes('…')) ? '' : tokenVal;
          const modelId = document.getElementById('modelId').value.trim();
          const endpoint = (document.getElementById('endpointInput')?.value || '').trim();
          const rulesPreset = document.getElementById('rulesPreset')?.value || '';
          const rulesText = document.getElementById('rulesText')?.value || '';
          vscode.postMessage({ type: 'saveCredentials', payload: { token, modelId, endpoint, rulesPreset, rulesText } });
          persistState();
        }
        function onRulesPresetChange() {
          const preset = document.getElementById('rulesPreset')?.value || '';
          vscode.postMessage({ type: 'getPresetRules', payload: { preset } });
        }
        function run() {
          const selectedModel = document.getElementById('modelId')?.value || '';
          vscode.postMessage({ type: 'makeAccessible', payload: { modelId: selectedModel } });
        }
        function getModels() {
          vscode.postMessage({ type: 'getModels' });
        }
        function toggleOutput() {
          const out = document.getElementById('output');
          const btn = document.getElementById('toggleOutputBtn');
          if (!out || !btn) return;
          const expanded = out.classList.toggle('expanded');
          btn.textContent = expanded ? 'Collapse' : 'Expand';
        }
        function revertChanges() {
          vscode.postMessage({ type: 'revertChanges' });
        }
        function onModelList(models) {
          const select = document.getElementById('modelId');
          if (!select) return;
          const previous = (vscode.getState()?.modelId) || select.value;
          select.innerHTML = '';
          for (const m of models) {
            const opt = document.createElement('option');
            opt.value = m.id;
            const parts = String(m.id).split('::');
            const display = parts.length ? parts[parts.length - 1] : String(m.id);
            opt.textContent = display;
            opt.title = String(m.id);
            select.appendChild(opt);
          }
          if (previous) {
            select.value = previous;
          }
        }
        document.addEventListener('DOMContentLoaded', () => {
          const saveBtn = document.getElementById('saveBtn');
          const runBtn = document.getElementById('runBtn');
          const getModelsBtn = document.getElementById('getModelsBtn');
          const toggleOutputBtn = document.getElementById('toggleOutputBtn');
          const revertBtn = document.getElementById('revertBtn');
          const rulesPresetEl = document.getElementById('rulesPreset');
          const rulesTextEl = document.getElementById('rulesText');
          if (saveBtn) saveBtn.addEventListener('click', save);
          if (runBtn) runBtn.addEventListener('click', run);
          if (getModelsBtn) getModelsBtn.addEventListener('click', getModels);
          if (toggleOutputBtn) toggleOutputBtn.addEventListener('click', toggleOutput);
          if (revertBtn) revertBtn.addEventListener('click', revertChanges);
          if (rulesPresetEl) rulesPresetEl.addEventListener('change', onRulesPresetChange);
          if (rulesTextEl) rulesTextEl.addEventListener('input', persistState);
          // Restore unsaved UI state (persists across view reloads)
          const s = vscode.getState() || {};
          if (s.endpoint) {
            const el = document.getElementById('endpointInput');
            if (el) el.value = s.endpoint;
          }
          if (s.modelId) {
            const m = document.getElementById('modelId');
            if (m) m.value = s.modelId;
          }
          if (s.tokenField) {
            const t = document.getElementById('token');
            if (t) t.value = s.tokenField;
          }
          if (s.rulesPreset) {
            const rp = document.getElementById('rulesPreset');
            if (rp) rp.value = s.rulesPreset;
          }
          if (typeof s.rulesText === 'string') {
            const rt = document.getElementById('rulesText');
            if (rt) rt.value = s.rulesText;
          }
          // Persist on changes
          const endpointEl = document.getElementById('endpointInput');
          const tokenEl = document.getElementById('token');
          const modelEl = document.getElementById('modelId');
          if (endpointEl) endpointEl.addEventListener('input', persistState);
          if (tokenEl) tokenEl.addEventListener('input', persistState);
          if (modelEl) modelEl.addEventListener('change', persistState);
        });
        window.addEventListener('message', (event) => {
          const msg = event.data;
          if (msg.type === 'hydrate') {
            if (msg.payload.endpoint) {
              const el = document.getElementById('endpointInput');
              if (el) el.value = msg.payload.endpoint;
              const s = vscode.getState() || {};
              vscode.setState({ ...s, endpoint: msg.payload.endpoint });
            }
            if (msg.payload.modelId) {
              const m = document.getElementById('modelId');
              if (m) m.value = msg.payload.modelId;
              const s = vscode.getState() || {};
              vscode.setState({ ...s, modelId: msg.payload.modelId });
            }
            if (msg.payload.tokenMasked) {
              const t = document.getElementById('token');
              maskedTokenFromSaved = msg.payload.tokenMasked;
              if (t) {
                // Show masked token as value (not just placeholder) so it doesn't look empty
                t.value = maskedTokenFromSaved;
              }
              const s = vscode.getState() || {};
              vscode.setState({ ...s, tokenField: maskedTokenFromSaved });
            }
            if (typeof msg.payload.rulesPreset === 'string') {
              const rp = document.getElementById('rulesPreset');
              if (rp) rp.value = msg.payload.rulesPreset;
              const s = vscode.getState() || {};
              vscode.setState({ ...s, rulesPreset: msg.payload.rulesPreset });
            }
            if (typeof msg.payload.rulesText === 'string') {
              const rt = document.getElementById('rulesText');
              if (rt) rt.value = msg.payload.rulesText;
              const s = vscode.getState() || {};
              vscode.setState({ ...s, rulesText: msg.payload.rulesText });
            }
            const runBtn = document.getElementById('runBtn');
            if (runBtn) runBtn.disabled = !msg.payload.canRun;
          }
          if (msg.type === 'models') {
            onModelList(msg.payload || []);
          }
          if (msg.type === 'presetRules') {
            const rulesBox = document.getElementById('rulesText');
            if (rulesBox) rulesBox.value = msg.payload || '';
            const s = vscode.getState() || {};
            vscode.setState({ ...s, rulesText: msg.payload || '' });
          }
          if (msg.type === 'status') {
            document.getElementById('status').textContent = msg.payload;
          }
          if (msg.type === 'error') {
            document.getElementById('status').textContent = 'Error: ' + msg.payload;
            document.getElementById('output').textContent = msg.payload;
          }
          if (msg.type === 'result') {
            document.getElementById('status').textContent = 'Done.';
            document.getElementById('output').textContent = msg.payload;
          }
          if (msg.type === 'diff') {
            document.getElementById('status').textContent = 'Applied edits.';
            const out = document.getElementById('output');
            const { summary, diff } = msg.payload || {};
            out.innerHTML = '';
            const sum = document.createElement('div');
            sum.textContent = summary || '';
            sum.style.marginBottom = '8px';
            out.appendChild(sum);
            const pre = document.createElement('pre');
            pre.style.whiteSpace = 'pre-wrap';
            pre.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
            pre.innerHTML = diff;
            out.appendChild(pre);
          }
          if (msg.type === 'loading') {
            const spinner = document.getElementById('spinner');
            const runBtn = document.getElementById('runBtn');
            const getModelsBtn = document.getElementById('getModelsBtn');
            const saveBtn = document.getElementById('saveBtn');
            if (spinner) spinner.style.display = msg.payload ? 'inline-block' : 'none';
            if (runBtn) runBtn.disabled = !!msg.payload;
            if (getModelsBtn) getModelsBtn.disabled = !!msg.payload;
            if (saveBtn) saveBtn.disabled = !!msg.payload;
          }
        });
      </script>
    `;

    const html = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta http-equiv="Content-Security-Policy" content="${csp}" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          ${styles}
        </head>
        <body>
          <div class="container">
            <div class="card">
              <h2>Galaxy Accessibility Agent</h2>
              <div class="badge">Uses Cody API chat completions</div>
            </div>
            <div class="card">
              <label>Sourcegraph Endpoint</label>
              <input id="endpointInput" type="text" placeholder="https://your-host.sourcegraph.com" />
              <label style="margin-top:6px;">Access Token</label>
              <input id="token" type="password" placeholder="token-********" />
               <label style="margin-top:6px;">Model</label>
               <select id="modelId"></select>
               <div class="row" style="margin-top:6px; gap:8px; align-items:center;">
                 <div style="flex:1;">
                   <label>Rules preset (optional)</label>
                   <select id="rulesPreset">
                     <option value="">None</option>
                     <option value="android">Android</option>
                     <option value="ios">iOS</option>
                     <option value="web">Web</option>
                   </select>
                 </div>
               </div>
               <label style="margin-top:6px;">Rules for accessibility (optional)</label>
               <textarea id="rulesText" class="rules-box" placeholder="Add or edit rules here…"></textarea>
              <div class="row" style="margin-top:8px; align-items:center; flex-wrap: wrap;">
                <button id="saveBtn">Save</button>
                <button id="getModelsBtn" title="Fetch available models from Cody API">Get Models</button>
                <button id="runBtn">Make This File Accessible</button>
                <span id="spinner" style="display:none;width:16px;height:16px;border:2px solid rgba(255,255,255,0.2);border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite"></span>
              </div>
              <div id="status" class="status" style="margin-top:6px;"></div>
            </div>
            <div class="card">
              <div class="row" style="justify-content: space-between; align-items: center;">
                <label style="margin:0">Output</label>
                <div class="row" style="gap:6px;">
                  <button id="revertBtn" class="ghost-btn" title="Revert last applied edits">Revert</button>
                  <button id="toggleOutputBtn" class="ghost-btn">Expand</button>
                </div>
              </div>
              <div id="output" class="output"></div>
            </div>
          </div>
          ${script}
        </body>
      </html>
    `;

    return html;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function maskToken(token: string | undefined | null): string {
  if (!token || token.length < 8) return '';
  return token.slice(0, 4) + '…' + token.slice(-4);
}



function resolveConfigValue(envVarName: string, settingKey: string): string {
  const fromEnv = process.env[envVarName];
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  const config = vscode.workspace.getConfiguration();
  const fromSettings = config.get<string>(settingKey);
  return fromSettings ? String(fromSettings).trim() : '';
}

function getEndpointFromEnvOrSettings(): string {
  const fromEnv = process.env['SRC_ENDPOINT'];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const config = vscode.workspace.getConfiguration();
  const fromSettings = config.get<string>('accessibleAgent.srcEndpoint');
  return fromSettings ? fromSettings.trim() : '';
}

type UiKind =
  | 'android-compose'
  | 'android-xml'
  | 'web-html'
  | 'react-jsx'
  | 'react-tsx'
  | 'swiftui'
  | 'flutter-dart'
  | 'unknown';

function detectUiContext(document: vscode.TextDocument, text: string): { isUiFile: boolean; uiKind: UiKind } {
  const fileName = document.fileName.toLowerCase();
  const languageId = document.languageId.toLowerCase();

  // Quick extension heuristics
  if (fileName.endsWith('.xml')) {
    // Android layout XML usually contains <LinearLayout, <ConstraintLayout, <androidx.
    const looksLikeLayout = /<\s*(LinearLayout|ConstraintLayout|RelativeLayout|androidx\.|com\.)/i.test(text) || /<\s*layout[\s>]/i.test(text);
    return { isUiFile: looksLikeLayout, uiKind: looksLikeLayout ? 'android-xml' : 'unknown' };
  }

  if (fileName.endsWith('.kt') || languageId === 'kotlin') {
    const composeHints = /@Composable|setContent\s*\(|Modifier\.|remember\(|Column\(|Row\(|Box\(/.test(text);
    return { isUiFile: composeHints, uiKind: composeHints ? 'android-compose' : 'unknown' };
  }

  if (fileName.endsWith('.swift') || languageId === 'swift') {
    const swiftUIHints = /import\s+SwiftUI|struct\s+\w+\s*:\s*View|UIViewRepresentable/.test(text);
    return { isUiFile: swiftUIHints, uiKind: swiftUIHints ? 'swiftui' : 'unknown' };
  }

  if (fileName.endsWith('.dart') || languageId === 'dart') {
    const flutterHints = /(import\s+'package:flutter\/|Scaffold\(|MaterialApp\(|Widget\b)/.test(text);
    return { isUiFile: flutterHints, uiKind: flutterHints ? 'flutter-dart' : 'unknown' };
  }

  if (fileName.endsWith('.html') || languageId === 'html') {
    return { isUiFile: true, uiKind: 'web-html' };
  }

  if (fileName.endsWith('.tsx')) {
    return { isUiFile: true, uiKind: 'react-tsx' };
  }
  if (fileName.endsWith('.jsx')) {
    return { isUiFile: true, uiKind: 'react-jsx' };
  }

  return { isUiFile: false, uiKind: 'unknown' };
}

function buildUserPrompt(input: { fileName: string; languageId: string; uiKind: UiKind; content: string; extraRules?: string }): string {
  const header = `You are an expert accessibility engineer. Improve accessibility in the following single file. Keep functional intent identical. Provide a short summary and the fully updated file. If no changes are needed, explain why.`;
  const context = `
File: ${input.fileName}
VS Code languageId: ${input.languageId}
UI context: ${input.uiKind}
`;

  const guidelines = `
Follow platform-specific best practices:
- Android Jetpack Compose: add Semantics, roles, contentDescription, touch target size, focus order, clicks, TalkBack labels.
- Android XML: add contentDescription, importantForAccessibility, focusable, labelFor, hints; prefer descriptive text; mark decorative images as not important.
- Web (HTML/React): use semantic elements, ARIA roles/states only when semantics missing, alt text for images, label controls, keyboard navigation, focus management.
- iOS SwiftUI: use accessibilityLabel, accessibilityHint, traits, accessibilitySortPriority; group elements appropriately.
- Flutter: use Semantics widgets, exclude semantics for decorative elements, provide labels and hints.
  Output format:
  1) Summary of changes
  2) Updated file content in a single code block
`;

  const extra = input.extraRules && input.extraRules.trim().length > 0
    ? `\nAdditional rules to follow strictly (override where applicable):\n${input.extraRules}\n`
    : '';
  const fileBlock = '```\n' + input.content + '\n```';
  return [header, context, guidelines + extra, fileBlock].join('\n\n');
}

function buildChunkPrompt(input: {
  fileName: string;
  languageId: string;
  uiKind: UiKind;
  chunkIndex: number;
  totalChunks: number;
  startLineOneBased: number;
  endLineOneBased: number;
  chunkContent: string;
  extraRules?: string;
}): string {
  const header = `You are an expert accessibility engineer. Improve only the provided line range of this file to be accessible without changing behavior.`;
  const context = `
File: ${input.fileName}
VS Code languageId: ${input.languageId}
UI context: ${input.uiKind}
Chunk: ${input.chunkIndex}/${input.totalChunks}
Lines: ${input.startLineOneBased}-${input.endLineOneBased}
`;
  const guidelines = `
Rules:
- Only return the updated content for these lines, no extra commentary around it.
- Keep code style and indentation consistent.
- Do not include surrounding lines outside this range.
`;
  const extra = input.extraRules && input.extraRules.trim().length > 0
    ? `\nAdditional rules to follow strictly (override where applicable):\n${input.extraRules}\n`
    : '';
  const fileBlock = '```\n' + input.chunkContent + '\n```';
  return [header, context, guidelines + extra, fileBlock].join('\n\n');
}

async function callCodyApi(params: { endpoint: string; token: string; modelId: string; userPrompt: string }): Promise<string> {
  const url = `${params.endpoint.replace(/\/$/, '')}/.api/llm/chat/completions`;
  const body = {
    // Respect API cap but do not artificially reduce; omit to let server choose, or set to 4000 per docs
    max_tokens: 4000,
    messages: [
      {
        content: params.userPrompt,
        role: 'user' as const,
      },
    ],
    model: params.modelId,
  };

  // Prefer global fetch if available; otherwise dynamically import undici
  const fetchImpl: any = (globalThis as any).fetch
    ? (globalThis as any).fetch
    : (await import('undici')).fetch;

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `token ${params.token}`,
      'X-Requested-With': 'accessible-agent 0.0.1',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cody API request failed (${response.status}): ${text.substring(0, 500)}`);
  }

  const json = (await response.json()) as any;
  const content = json?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('Unexpected Cody API response: missing message content.');
  }
  return content;
}

async function listModels(params: { endpoint: string; token: string }): Promise<Array<{ id: string; owned_by?: string }>> {
  const url = `${params.endpoint.replace(/\/$/, '')}/.api/llm/models`;
  const fetchImpl: any = (globalThis as any).fetch
    ? (globalThis as any).fetch
    : (await import('undici')).fetch;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `token ${params.token}`,
      'X-Requested-With': 'accessible-agent 0.0.1',
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Models request failed (${response.status}): ${text.substring(0, 300)}`);
  }
  const json = (await response.json()) as any;
  const data = Array.isArray(json?.data) ? json.data : [];
  return data.map((m: any) => ({ id: String(m?.id || ''), owned_by: m?.owned_by ? String(m.owned_by) : undefined })).filter((m: any) => m.id);
}

function extractUpdatedFileAndSummary(modelText: string, original: string): { updatedContent?: string; summary?: string; raw?: string } {
  // Expect the model to produce a summary and a single code block. We parse the first fenced block.
  const codeBlockMatch = modelText.match(/```[a-zA-Z0-9]*\n([\s\S]*?)\n```/);
  if (!codeBlockMatch) {
    return { raw: modelText };
  }
  const updated = codeBlockMatch[1];
  // Try to capture a short summary: take content before the code block up to ~1k chars
  const pre = modelText.slice(0, codeBlockMatch.index || 0).trim();
  const summary = pre.split(/\n+/).slice(0, 20).join('\n');
  if (!updated || updated.trim().length === 0 || updated.trim() === original.trim()) {
    return { raw: modelText };
  }
  return { updatedContent: updated, summary };
}

async function applyFullDocumentEdit(editor: vscode.TextEditor, newContent: string): Promise<void> {
  const document = editor.document;
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
  await editor.edit(editBuilder => {
    editBuilder.replace(fullRange, newContent);
  });
  await document.save();
}

function buildColoredUnifiedDiff(oldText: string, newText: string): string {
  const parts: Change[] = diffLines(oldText, newText);
  // Build HTML with color spans
  const lines: string[] = [];
  for (const part of parts) {
    const color = part.added ? '#22c55e' : part.removed ? '#ef4444' : '#94a3b8';
    const prefix = part.added ? '+' : part.removed ? '-' : ' ';
    const segment = part.value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const segmentLines = segment.split('\n');
    for (let i = 0; i < segmentLines.length; i++) {
      const line = segmentLines[i];
      if (line.length === 0 && i === segmentLines.length - 1) continue;
      lines.push(`<span style=\"color:${color}\">${prefix}${line}</span>`);
    }
  }
  return lines.join('\n');
}

async function openVsCodeDiff(
  originalDoc: vscode.TextDocument,
  originalText: string,
  newText: string,
  summary?: string
): Promise<void> {
  const left = await vscode.workspace.openTextDocument({ content: originalText, language: originalDoc.languageId });
  const right = await vscode.workspace.openTextDocument({ content: newText, language: originalDoc.languageId });
  // Use untitled URIs so VS Code can diff ephemeral content without a custom scheme provider
  const leftUri = vscode.Uri.parse(`untitled:${originalDoc.fileName}.before`);
  const rightUri = vscode.Uri.parse(`untitled:${originalDoc.fileName}.after`);
  await vscode.commands.executeCommand(
    'vscode.diff',
    leftUri,
    rightUri,
    `Accessible changes: ${originalDoc.fileName}`
  );
  if (summary) {
    vscode.window.showInformationMessage(summary);
  }
}


