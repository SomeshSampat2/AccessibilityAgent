import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('accessibleAgent.helloWorld', () => {
    vscode.window.showInformationMessage('AccessibleAgent is ready.');
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

      if (!uiContext.isUiFile) {
        vscode.window.showInformationMessage('This file does not appear to be a UI file; no accessibility actions to perform.');
        return;
      }

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
          title: 'AccessibleAgent: Analyzing and proposing accessibility improvements…',
          cancellable: false,
        },
        async () => {
          try {
            const result = await callCodyApi({ endpoint, token, modelId, userPrompt });
            const doc = await vscode.workspace.openTextDocument({ content: result, language: 'markdown' });
            await vscode.window.showTextDocument(doc, { preview: false });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`AccessibleAgent error: ${message}`);
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
          const { token, modelId, endpoint } = message.payload ?? {};
          await this.saveCredentials(token, modelId, endpoint);
          this.post({ type: 'status', payload: 'Saved credentials.' });
          // Refresh state to enable the Run button if token is present
          await this.hydrateState();
          break;
        }
        case 'makeAccessible': {
          await this.runMakeAccessible();
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

  private async hydrateState() {
    const config = vscode.workspace.getConfiguration();
    const endpoint = getEndpointFromEnvOrSettings();
    const modelId = resolveConfigValue('CODY_MODEL_ID', 'accessibleAgent.modelId') || 'anthropic::2023-06-01::claude-3.5-sonnet';
    const tokenFromSecrets = await this.context.secrets.get('accessibleAgent.srcAccessToken');
    const tokenFromConfig = config.get<string>('accessibleAgent.srcAccessToken') || '';
    const token = tokenFromSecrets || tokenFromConfig;
    const hasEndpoint = Boolean(endpoint);
    const hasToken = Boolean(token);
    const canRun = hasEndpoint && hasToken;
    this.post({ type: 'hydrate', payload: { endpoint, tokenMasked: maskToken(token), modelId, hasEndpoint, hasToken, canRun } });
  }

  private async saveCredentials(token: string, modelId: string, endpoint?: string) {
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
  }

  private async runMakeAccessible() {
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
    if (!uiContext.isUiFile) {
      this.post({ type: 'status', payload: 'This file is not a UI file.' });
      this.post({ type: 'loading', payload: false });
      return;
    }

    const endpoint = getEndpointFromEnvOrSettings();
    const tokenFromSecrets = await this.context.secrets.get('accessibleAgent.srcAccessToken');
    const tokenFromEnvOrSettings = resolveConfigValue('SRC_ACCESS_TOKEN', 'accessibleAgent.srcAccessToken');
    const token = tokenFromSecrets || tokenFromEnvOrSettings;
    let modelId = resolveConfigValue('CODY_MODEL_ID', 'accessibleAgent.modelId') || 'anthropic::2023-06-01::claude-3.5-sonnet';

    if (!endpoint || !token) {
      const missing: string[] = [];
      if (!endpoint) missing.push('SRC_ENDPOINT');
      if (!token) missing.push('SRC_ACCESS_TOKEN or saved token');
      this.post({ type: 'error', payload: 'Missing configuration: ' + missing.join(' and ') + '.' });
      this.post({ type: 'loading', payload: false });
      return;
    }

    const userPrompt = buildUserPrompt({
      fileName: document.fileName,
      languageId: document.languageId,
      uiKind: uiContext.uiKind,
      content: fileText,
    });

    this.post({ type: 'status', payload: 'Contacting Cody API…' });
    try {
      console.log('[AccessibleAgent] Calling Cody API', { endpoint, modelId });
      const result = await callCodyApi({ endpoint, token, modelId, userPrompt });
      this.post({ type: 'result', payload: result });
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
        :root { --bg:#0f172a; --fg:#e2e8f0; --muted:#94a3b8; --accent:#22c55e; --accent2:#3b82f6; }
        body { background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, -apple-system; margin: 0; }
        .container { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
        h2 { margin: 0 0 4px; font-size: 15px; }
        .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 10px; }
        label { display:block; color: var(--muted); font-size: 11px; margin-bottom: 4px; }
        input, select, textarea { width: 100%; padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.05); color: var(--fg); }
        button { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #000; font-weight: 600; border: none; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
        button:hover { filter: brightness(1.05); }
        .row { display:flex; gap: 8px; }
        .status { color: var(--muted); font-size: 11px; }
        .output { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-height: 40vh; overflow: auto; }
        .badge { display:inline-flex; align-items:center; gap:6px; font-size:11px; color: var(--muted); }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
    `;
    const script = `
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        function save() {
          const token = document.getElementById('token').value.trim();
          const modelId = document.getElementById('modelId').value.trim();
          const endpoint = (document.getElementById('endpointInput')?.value || '').trim();
          vscode.postMessage({ type: 'saveCredentials', payload: { token, modelId, endpoint } });
        }
        function run() {
          vscode.postMessage({ type: 'makeAccessible' });
        }
        document.addEventListener('DOMContentLoaded', () => {
          const saveBtn = document.getElementById('saveBtn');
          const runBtn = document.getElementById('runBtn');
          if (saveBtn) saveBtn.addEventListener('click', save);
          if (runBtn) runBtn.addEventListener('click', run);
        });
        window.addEventListener('message', (event) => {
          const msg = event.data;
          if (msg.type === 'hydrate') {
            if (msg.payload.endpoint) {
              const el = document.getElementById('endpointInput');
              if (el) el.value = msg.payload.endpoint;
            }
            if (msg.payload.modelId) document.getElementById('modelId').value = msg.payload.modelId;
            if (msg.payload.tokenMasked) document.getElementById('token').placeholder = msg.payload.tokenMasked;
            const runBtn = document.getElementById('runBtn');
            if (runBtn) runBtn.disabled = !msg.payload.canRun;
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
          if (msg.type === 'loading') {
            const spinner = document.getElementById('spinner');
            const runBtn = document.getElementById('runBtn');
            const saveBtn = document.getElementById('saveBtn');
            if (spinner) spinner.style.display = msg.payload ? 'inline-block' : 'none';
            if (runBtn) runBtn.disabled = !!msg.payload;
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
              <h2>AccessibleAgent</h2>
              <div class="badge">Uses Cody API chat completions</div>
            </div>
            <div class="card">
              <label>Sourcegraph Endpoint</label>
              <input id="endpointInput" type="text" placeholder="https://your-host.sourcegraph.com" />
              <label style="margin-top:6px;">Access Token</label>
              <input id="token" type="password" placeholder="token-********" />
              <label style="margin-top:6px;">Model</label>
              <select id="modelId">
                <option value="anthropic::2023-06-01::claude-3.5-sonnet">Anthropic Claude 3.5 Sonnet</option>
                <option value="anthropic::2023-06-01::claude-3.5-haiku">Anthropic Claude 3.5 Haiku</option>
              </select>
              <div class="row" style="margin-top:8px; align-items:center;">
                <button id="saveBtn">Save</button>
                <button id="runBtn">Make This File Accessible</button>
                <span id="spinner" style="display:none;width:16px;height:16px;border:2px solid rgba(255,255,255,0.2);border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite"></span>
              </div>
              <div id="status" class="status" style="margin-top:6px;"></div>
            </div>
            <div class="card">
              <label>Output</label>
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

function buildUserPrompt(input: { fileName: string; languageId: string; uiKind: UiKind; content: string }): string {
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

  const fileBlock = '```\n' + input.content + '\n```';
  return [header, context, guidelines, fileBlock].join('\n\n');
}

async function callCodyApi(params: { endpoint: string; token: string; modelId: string; userPrompt: string }): Promise<string> {
  const url = `${params.endpoint.replace(/\/$/, '')}/.api/llm/chat/completions`;
  const body = {
    max_tokens: 2000,
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


