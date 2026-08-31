import { InstallModel, installAddress, installGuides, installPlatform } from './pwa.ts';
import type { InstallWork, NativeInstallPrompt } from './pwa.ts';

interface InstallOptions {
  getWork: () => InstallWork;
  onStateChange: () => void;
  toast: (message: string) => void;
}
export interface InstallUI { refresh(): void; readonly prompting: boolean }

export function setupInstall(options: InstallOptions): InstallUI {
  const button = document.getElementById('install-app') as HTMLButtonElement;
  const buttonLabel = button.querySelector<HTMLElement>('[data-install-label]')!;
  const dialog = document.createElement('dialog');
  dialog.className = 'install-dialog';
  dialog.setAttribute('aria-labelledby', 'install-title');
  dialog.setAttribute('aria-describedby', 'install-description');
  dialog.innerHTML = `
    <div class="install-heading">
      <div><span class="install-eyebrow">VIDEO SPLITTER</span><h2 id="install-title">앱 설치</h2></div>
      <button type="button" class="icon-button install-close" aria-label="설치 안내 닫기" autofocus><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>
    </div>
    <p id="install-description">홈 화면에 추가하고 바로 열어보세요.</p>
    <div id="install-warning" class="install-warning" hidden>
      <strong id="install-warning-title"></strong><p id="install-warning-copy"></p>
      <label class="install-ack"><input id="install-ack" type="checkbox"><span id="install-ack-label"></span></label>
    </div>
    <p id="install-status" class="install-status" role="status" aria-live="polite" hidden></p>
    <div id="install-guide">
      <h3 id="install-platform"></h3><ol id="install-steps"></ol>
      <p class="install-in-app">카카오톡·ChatGPT 등 앱 안에서 보고 있다면 주소를 복사해 브라우저에서 열어 주세요.</p>
      <label class="install-url-label" for="install-url">앱 주소</label>
      <div class="install-url-row"><input id="install-url" readonly spellcheck="false" autocomplete="off"><button type="button" id="install-copy" class="button secondary">주소 복사</button></div>
    </div>
    <p class="install-note">설치해도 영상은 기기 안에서 처리해요. 오프라인 실행은 지원하지 않으며, 영상 처리 중에는 화면을 열어두세요.</p>
    <div class="install-actions"><button type="button" class="button secondary install-close">닫기</button><button type="button" id="install-native" class="button primary" hidden>앱 설치</button></div>
  `;
  document.body.append(dialog);
  const find = <T extends HTMLElement = HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!;
  const acknowledgment = find<HTMLInputElement>('install-ack');
  const nativeButton = find<HTMLButtonElement>('install-native');
  const copyButton = find<HTMLButtonElement>('install-copy');
  const address = find<HTMLInputElement>('install-url');
  address.value = installAddress(window.location.href, import.meta.env.BASE_URL);
  const guide = installGuides[installPlatform(navigator.userAgent, navigator.maxTouchPoints)];
  find('install-platform').textContent = `${guide.title}에서 설치하는 방법`;
  for (const instruction of guide.steps) {
    const step = document.createElement('li');
    step.textContent = instruction;
    find('install-steps').append(step);
  }

  const model = new InstallModel(() => { refresh(); options.onStateChange(); });
  function status(message: string): void {
    find('install-status').textContent = message;
    find('install-status').hidden = !message;
  }
  function close(): void { if (dialog.open) dialog.close(); }
  function refresh(): void {
    const work = options.getWork();
    const state = model.button(work);
    button.hidden = state.hidden;
    button.disabled = state.disabled;
    buttonLabel.textContent = state.label;
    button.title = work.busy ? '영상 작업이 끝나면 설치할 수 있어요.' : 'Video Splitter를 홈 화면에 추가';
    if (state.hidden) { close(); return; }
    if (!dialog.open) return;
    const needsConfirmation = work.filesSelected || work.temporaryResults;
    find('install-warning').hidden = !needsConfirmation;
    find('install-warning-title').textContent = work.temporaryResults ? '필요한 결과를 먼저 저장해 주세요' : '선택한 영상은 새 앱으로 옮겨지지 않아요';
    find('install-warning-copy').textContent = work.temporaryResults
      ? '“저장 요청됨”은 저장 완료가 아니에요. 브라우저 다운로드 목록에서 완료를 확인한 뒤 기존 탭을 닫고 설치한 앱을 열어 주세요. 페이지를 다시 열면 임시 결과가 정리됩니다.'
      : '설치한 앱을 새로 열면 영상을 다시 선택해야 해요. 현재 목록과 임시 결과는 자동으로 이어지지 않으며, 원본 파일은 변경하지 않아요.';
    find('install-ack-label').textContent = work.temporaryResults
      ? '필요한 결과의 저장 완료를 확인했고, 새 앱에서 영상을 다시 선택해야 함을 이해했어요.'
      : '새 앱에서 영상을 다시 선택해야 함을 확인했어요.';
    const confirmed = !needsConfirmation || acknowledgment.checked;
    find('install-guide').hidden = !confirmed;
    nativeButton.hidden = !model.snapshot.nativeAvailable;
    nativeButton.disabled = state.disabled || !confirmed;
    copyButton.disabled = state.disabled || !confirmed;
    acknowledgment.disabled = state.disabled;
  }
  function showGuide(message = ''): void {
    if (options.getWork().busy || model.prompting) { options.toast('영상 작업과 설치 확인이 끝난 뒤 다시 시도해 주세요.'); return; }
    if (model.snapshot.hidden) return;
    acknowledgment.checked = false;
    status(message);
    dialog.showModal();
    refresh();
  }
  async function requestInstall(acknowledged = false): Promise<void> {
    // Call request immediately. Deferring it would lose the browser's user activation.
    const result = await model.request(options.getWork(), acknowledged);
    if (model.snapshot.hidden) { close(); return; }
    if (result === 'busy') { options.toast('현재 작업이 끝나면 설치할 수 있어요.'); return; }
    if (result === 'confirm' || result === 'manual') { showGuide(); return; }
    if (result === 'accepted' || result === 'requested') {
      close();
      options.toast('설치를 요청했어요. 완료 여부는 홈 화면이나 브라우저에서 확인해 주세요.');
      return;
    }
    if (result === 'dismissed' || result === 'failed') {
      showGuide(result === 'dismissed' ? '설치하지 않았어요. 원할 때 아래 방법으로 다시 시도할 수 있어요.' : '브라우저 설치창을 열지 못했어요. 아래 방법으로 설치해 주세요.');
    }
  }

  button.addEventListener('click', () => { void requestInstall(); });
  nativeButton.addEventListener('click', () => { void requestInstall(acknowledgment.checked); });
  acknowledgment.addEventListener('change', refresh);
  dialog.querySelectorAll<HTMLButtonElement>('.install-close').forEach(item => item.addEventListener('click', close));
  dialog.addEventListener('close', () => { if (!button.hidden && !button.disabled) button.focus(); });
  copyButton.addEventListener('click', async () => {
    if (copyButton.disabled) return;
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(address.value);
      status('주소를 복사했어요. 브라우저 주소창에 붙여 넣어 주세요.');
    } catch {
      address.focus(); address.select();
      status('주소를 선택했어요. 길게 누르거나 복사 단축키를 사용해 주세요.');
    }
  });
  window.addEventListener('beforeinstallprompt', event => {
    const prompt = event as unknown as NativeInstallPrompt;
    if (typeof prompt.prompt === 'function') model.capture(prompt);
  });
  window.addEventListener('appinstalled', () => {
    model.markInstalled();
    options.toast('앱 설치가 확인됐어요. 홈 화면이나 앱 목록의 아이콘을 확인해 주세요.');
  });
  const displays = ['standalone', 'minimal-ui', 'window-controls-overlay'].map(mode => window.matchMedia(`(display-mode: ${mode})`));
  const checkDisplay = () => model.setStandalone(displays.some(query => query.matches) || (navigator as Navigator & { standalone?: boolean }).standalone === true);
  displays.forEach(query => query.addEventListener('change', checkDisplay));
  window.addEventListener('pageshow', checkDisplay);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkDisplay(); });
  checkDisplay();
  refresh();
  return { refresh, get prompting() { return model.prompting; } };
}
