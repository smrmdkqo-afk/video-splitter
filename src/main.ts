import './style.css';
import { WorkerBridge } from './bridge.ts';
import { runSequential } from './queue.ts';
import { setupInstall } from './install-ui.ts';
import type { InstallUI } from './install-ui.ts';
import { DEFAULT_OPTIONS, errorMessage, escapeHtml as esc, formatBytes, formatEta, formatTime, KAKAO_REFERENCE_BYTES, MAX_TARGET_BYTES, MIN_TARGET_BYTES, modeLabel, TARGET_BYTES } from './model.ts';
import type { ProcessingMode, ProcessingOptions, ProcessingPlan, Resolution, SegmentResult, SplitProgress, SplitRule, VideoInfo } from './model.ts';

type State = 'analyzing' | 'ready' | 'queued' | 'running' | 'done' | 'needs-reencode' | 'error' | 'stopped';
interface Job {
  id: string; file: File; state: State; options: ProcessingOptions; plan?: ProcessingPlan; info?: VideoInfo; error?: string;
  results: SegmentResult[]; progress?: SplitProgress; expanded: boolean; downloads: Set<number>;
}
const bridge = new WorkerBridge();
const jobs: Job[] = [];
let options: ProcessingOptions = { ...DEFAULT_OPTIONS };
let lastResizeResolution: Resolution = 1080;
let processing = false;
let inspecting = false;
let installUI: InstallUI | undefined;
const workLocked = () => processing || inspecting || !!installUI?.prompting;
let controller: AbortController | undefined;
let activeRequest: string | undefined;
let startedAt = 0;
let batch: Job[] = [];
let decisionJob: Job | undefined;
let wakeLock: WakeLockSentinel | undefined;
let toastTimer: ReturnType<typeof setTimeout>;
const downloadUrls = new Set<string>();

const paths: Record<string, string> = {
  split: '<rect x="3" y="5" width="7" height="14" rx="2"/><rect x="14" y="5" width="7" height="14" rx="2"/><path d="M12 2v20" stroke-dasharray="2 3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  video: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 9 5 3-5 3z"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3"/>',
  alert: '<path d="m12 3 10 18H2zM12 9v4m0 3v.01"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  retry: '<path d="M3 10a9 9 0 1 1 1 8M3 4v6h6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  wand: '<path d="m15 4 5 5L8 21l-5-5zM14 5l5 5M5 3v4M3 5h4M19 15v5M16.5 17.5h5"/>',
};
const icon = (name: string, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ''}</svg>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

$('app').innerHTML = `
  <header class="site-header">
    <a class="brand" href="./" aria-label="Video Splitter 처음으로"><span class="brand-mark">${icon('split')}</span><span>Video Splitter<span class="brand-dot">.</span></span></a>
    <div class="header-actions"><span class="privacy-label">${icon('shield')} 내 기기에서만 처리</span><button id="install-app" class="button secondary install-button" type="button">${icon('download')}<span data-install-label>설치 방법</span></button></div>
  </header>
  <main class="workspace">
    <section class="intro" aria-labelledby="page-title">
      <div><span class="eyebrow">원본은 그대로, 공유는 가볍게</span><h1 id="page-title">영상 나누기</h1><p>해상도 변경부터 시간 분할까지, 여러 영상을 하나씩 순서대로.</p><span class="privacy-label mobile-privacy">${icon('shield')} 내 기기에서만 처리</span></div>
      <span id="mode-badge" class="mode-badge">${icon('shield')} <strong>250 MB</strong><span>상한 · 실제 용량 검증</span></span>
    </section>

    <section class="processing-settings" aria-label="영상 처리 설정">
      <div class="settings-fields">
        <label for="processing-mode"><span>처리 방식</span><select id="processing-mode" aria-describedby="settings-help"><option value="split">분할만</option><option value="resize">해상도 변경만</option><option value="resize-split">해상도 변경 후 분할</option></select></label>
        <label for="resolution"><span>출력 해상도 <small>최대 크기</small></span><select id="resolution" aria-describedby="settings-help" disabled><option value="original">원본 유지</option><option value="1080">1080p · Full HD</option><option value="720">720p · HD</option><option value="480">480p · 가볍게</option></select></label>
        <span class="settings-scope">설정은 새 영상과 대기 항목에 적용돼요.</span>
      </div>
      <div id="split-settings" class="split-settings">
        <fieldset class="rule-picker"><legend>조각 기준</legend><div>
          <label><input type="radio" name="split-rule" value="size" checked><span><strong>${icon('shield')} 용량 상한 <small>추천</small></strong><em>모든 결과가 상한 이하인지 검증</em></span></label>
          <label><input type="radio" name="split-rule" value="duration"><span><strong>${icon('clock')} 시간 균등</strong><em>길이는 비슷하지만 용량은 달라질 수 있음</em></span></label>
        </div></fieldset>
        <div class="size-picker"><span>파일당 최대 용량</span><div class="size-controls" role="group" aria-label="파일당 최대 용량"><button type="button" data-target-mb="100">100</button><button type="button" data-target-mb="200">200</button><button type="button" data-target-mb="250">250</button><label><input id="target-mb" type="number" min="10" max="2000" step="1" inputmode="numeric" aria-label="직접 입력 용량"><span>MB</span></label></div><small>1 MB = 1,000,000 bytes</small></div>
      </div>
      <p id="settings-help" class="settings-help" role="status">재압축 없이 안전한 키프레임에서 나눈 뒤, 모든 결과가 250MB 이하인지 실제 파일로 확인해요.</p>
    </section>

    <section id="drop-zone" class="drop-zone" aria-label="영상 파일 선택 영역">
      <div class="drop-icon">${icon('video')}</div>
      <div class="drop-copy"><h2>처리할 영상을 선택해 주세요</h2><p>여러 파일을 한 번에 선택하거나 이곳에 놓아 주세요.</p><span class="formats">MP4 · MOV · M4V <span>원본 파일은 변경하지 않아요</span></span></div>
      <button id="pick-files" class="button primary">${icon('plus')} 영상 선택</button>
      <input id="file-input" class="sr-only" type="file" accept=".mp4,.mov,.m4v,video/mp4,video/quicktime" multiple aria-label="여러 영상 선택" />
    </section>

    <section id="overview" class="overview" hidden aria-label="전체 작업 요약">
      <div class="summary-stats">
        <div><span>선택한 영상</span><strong id="stat-files">0<small>개</small></strong></div>
        <div><span>전체 재생시간</span><strong id="stat-duration">00:00</strong></div>
        <div><span>예상 결과</span><strong id="stat-parts">0<small>개</small></strong></div>
      </div>
      <div class="overall-progress">
        <div class="progress-heading"><span id="overall-label">처리 준비 완료</span><strong id="overall-percent">0%</strong></div>
        <div id="overall-bar" class="progress-track" role="progressbar" aria-label="전체 작업 진행률" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
        <div class="progress-caption"><span id="overall-caption">시작하면 목록 순서대로 처리합니다.</span><span id="overall-eta"></span></div>
      </div>
    </section>

    <section class="queue-section" aria-labelledby="queue-title">
      <div class="section-heading"><h2 id="queue-title">작업 목록 <span id="queue-count">0</span></h2><button id="clear-completed" class="text-button" hidden>${icon('trash')} 완료 항목 정리</button></div>
      <div id="empty-state" class="empty-state"><span class="empty-icon">${icon('folder')}</span><strong>선택한 영상이 여기에 표시돼요</strong><p>파일별 길이, 출력 해상도와 처리 계획을 확인하세요.</p></div>
      <div id="queue" class="queue"></div>
    </section>

    <aside class="notes" aria-label="사용 안내">
      ${icon('shield')}
      <div><strong>영상은 서버로 전송하지 않아요.</strong><p>용량 상한 모드는 안전한 키프레임에서 재압축 없이 나누고 실제 MP4 크기를 검증합니다. 한 키프레임 구간 자체가 너무 크면 임의로 화질을 바꾸지 않고 재인코딩 여부를 물어요.</p><p>재인코딩을 허용하면 영상 화질과 용량이 원본과 달라질 수 있고, 시간이 더 걸리며 기기가 뜨거워질 수 있습니다.</p><p>처리 중에는 이 화면을 열어두고, 완료 후에는 필요한 결과를 저장해 주세요. 페이지를 다시 열면 임시 결과는 정리됩니다.</p></div>
    </aside>
    <footer class="page-footer"><span>VIDEO SPLITTER</span><span>v1.3.0 · 원본 파일은 변경하지 않습니다 · <a href="./third-party-notices.txt" target="_blank" rel="noopener">오픈소스 안내</a></span></footer>
  </main>

  <div id="action-bar" class="action-bar" hidden>
    <div class="action-bar-inner"><div class="action-description"><strong id="action-title">처리할 준비가 됐어요</strong><span id="action-subtitle">원본 파일은 그대로 보관합니다.</span></div><div class="action-buttons"><button id="stop" class="button secondary" hidden>${icon('stop')} 중지</button><button id="start" class="button primary">순차 처리 시작 ${icon('arrow')}</button></div></div>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  <div id="live-status" class="sr-only" role="status" aria-live="polite"></div>
  <dialog id="reencode-dialog" class="reencode-dialog" aria-labelledby="reencode-title">
    <div class="sheet-handle" aria-hidden="true"></div>
    <div class="reencode-heading"><span class="decision-icon">${icon('wand')}</span><div><span>용량 상한을 지키기 위한 선택</span><h2 id="reencode-title">재인코딩해서 다시 나눌까요?</h2></div><button id="close-reencode" class="icon-button" type="button" aria-label="닫기">${icon('close')}</button></div>
    <p id="reencode-description">영상 데이터를 새로 압축해 2초마다 안전한 분할 지점을 만듭니다. 화질과 용량은 원본과 달라질 수 있어요.</p>
    <fieldset class="resolution-cards"><legend>재인코딩 해상도</legend>
      <label><input type="radio" name="reencode-resolution" value="original" checked><span><strong>원본 해상도</strong><small>크기는 유지하고 다시 압축</small></span></label>
      <label><input type="radio" name="reencode-resolution" value="1080"><span><strong>1080p</strong><small>최대 Full HD</small></span></label>
      <label><input type="radio" name="reencode-resolution" value="720"><span><strong>720p</strong><small>용량과 화질 균형</small></span></label>
      <label><input type="radio" name="reencode-resolution" value="480"><span><strong>480p</strong><small>가장 가볍게</small></span></label>
    </fieldset>
    <div class="reencode-note">${icon('shield')} 결과는 선택한 용량 상한 이하인지 다시 검증하며, 초과 파일은 다운로드 목록에 표시하지 않아요.</div>
    <div class="reencode-actions"><button id="cancel-reencode" class="button secondary" type="button">취소</button><button id="confirm-reencode" class="button primary" type="button">바로 재인코딩 시작</button></div>
  </dialog>
`;

function toast(message: string): void {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}

function stateLabel(job: Job): string {
  return ({ analyzing: '정보 확인 중', ready: job.plan?.reencode || (job.plan?.parts.length ?? 0) > 1 ? '준비 완료' : '변경 불필요', queued: '대기 중', running: '처리 중', done: '완료', 'needs-reencode': '재인코딩 필요', error: '실패', stopped: '중지됨' })[job.state];
}

function renderSettings(): void {
  const mode = $<HTMLSelectElement>('processing-mode');
  const resolution = $<HTMLSelectElement>('resolution');
  const targetMb = Math.round((options.maxBytes ?? 250_000_000) / 1_000_000);
  mode.value = options.mode;
  mode.disabled = workLocked();
  resolution.value = String(options.resolution);
  resolution.disabled = workLocked() || options.mode === 'split';
  resolution.options[0].disabled = options.mode !== 'split';
  $('split-settings').hidden = options.mode === 'resize';
  document.querySelectorAll<HTMLInputElement>('input[name="split-rule"]').forEach(input => {
    input.checked = input.value === (options.splitRule ?? 'size');
    input.disabled = workLocked();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-target-mb]').forEach(button => {
    button.classList.toggle('selected', Number(button.dataset.targetMb) === targetMb);
    button.disabled = workLocked();
  });
  const targetInput = $<HTMLInputElement>('target-mb');
  targetInput.value = String(targetMb);
  targetInput.disabled = workLocked();
  $('settings-help').textContent = options.mode === 'resize'
    ? '화면 비율과 방향을 유지하고 작은 영상은 확대하지 않아요. 나누지 않고 한 파일로 저장해요.'
    : options.splitRule === 'size'
      ? `재압축 없이 안전한 키프레임에서 나눈 뒤, 모든 결과가 ${targetMb}MB 이하인지 실제 파일로 확인해요.`
      : `전체 길이를 비슷하게 나누고 가까운 안전 키프레임에 맞춰요. ${targetMb}MB는 조각 수 계산 기준이며 상한은 아니에요.`;
  $('mode-badge').innerHTML = options.mode === 'resize'
    ? `${icon('video')} <strong>${options.resolution}p</strong><span>해상도 변경 · 분할 없음</span>`
    : options.splitRule === 'size'
      ? `${icon('shield')} <strong>${targetMb} MB</strong><span>상한 · 실제 용량 검증</span>`
      : `${icon('clock')} <strong>${targetMb} MB</strong><span>기준 · 시간 균등 분할</span>`;
}

function fraction(job: Job): number {
  if (job.state === 'done' || job.state === 'error' || job.state === 'needs-reencode') return 1;
  return job.progress?.fraction ?? 0;
}

function setBar(element: HTMLElement, percent: number): void {
  const value = Math.min(100, Math.max(0, percent));
  element.setAttribute('aria-valuenow', String(Math.floor(value)));
  const fill = element.querySelector<HTMLElement>('span');
  if (fill) fill.style.width = `${value}%`;
}

function renderSummary(): void {
  const ready = jobs.filter(j => ['ready', 'stopped', 'error'].includes(j.state) && !!j.plan);
  const totalBytes = jobs.reduce((sum, j) => sum + j.file.size, 0);
  const duration = jobs.reduce((sum, j) => sum + (j.info?.duration ?? 0), 0);
  const parts = jobs.reduce((sum, j) => sum + (j.plan?.parts.length ?? 0), 0);
  const unknownParts = jobs.some(j => j.plan?.awaitingSize && j.options.mode === 'resize-split');
  const done = jobs.filter(j => j.state === 'done').length;
  const errors = jobs.filter(j => j.state === 'error').length;
  const decisions = jobs.filter(j => j.state === 'needs-reencode').length;
  $('overview').hidden = jobs.length === 0;
  $('action-bar').hidden = jobs.length === 0;
  document.body.classList.toggle('has-jobs', jobs.length > 0);
  $('empty-state').hidden = jobs.length > 0;
  $('queue-count').textContent = `${jobs.length}`;
  $('stat-files').innerHTML = `${jobs.length}<small>개</small>`;
  $('stat-duration').textContent = formatTime(duration);
  $('stat-parts').innerHTML = unknownParts ? '변환 후 확정' : `${parts}<small>개</small>`;
  $('stat-parts').classList.toggle('pending-count', unknownParts);
  $('clear-completed').hidden = !done;
  ($('clear-completed') as HTMLButtonElement).disabled = workLocked();
  ($('pick-files') as HTMLButtonElement).disabled = workLocked();
  ($('file-input') as HTMLInputElement).disabled = workLocked();
  $('drop-zone').classList.toggle('disabled', workLocked());
  $('start').hidden = processing;
  ($('start') as HTMLButtonElement).disabled = workLocked() || (ready.length === 0 && decisions === 0);
  $('start').innerHTML = inspecting ? '<span class="spinner"></span> 영상 정보 확인 중' : ready.length ? `순차 처리 시작 ${icon('arrow')}` : decisions ? `결정할 파일 보기 ${icon('arrow')}` : errors ? '파일 확인 필요' : `${icon('check')} 작업 완료`;
  $('stop').hidden = !processing;
  ($('stop') as HTMLButtonElement).disabled = !!controller?.signal.aborted;
  $('action-title').textContent = processing ? (controller?.signal.aborted ? '현재 작업을 중지하고 있어요' : '한 영상씩 순서대로 처리하고 있어요') : inspecting ? '영상 정보를 확인하고 있어요' : ready.length ? `${ready.length}개 영상이 준비됐어요` : decisions ? `${decisions}개 파일의 결정이 필요해요` : errors ? '처리하지 못한 영상을 확인해 주세요' : '필요한 결과를 저장해 주세요';
  $('action-subtitle').textContent = processing ? (decisions ? `${decisions}개는 재인코딩 여부를 기다리고 있어요. 다른 파일은 계속 처리합니다.` : '완료된 결과는 처리 중에도 저장할 수 있어요.') : `${formatBytes(totalBytes)} · ${unknownParts ? '결과 수는 변환 후 확정' : `예상 결과 ${parts}개`} · 원본 보관`;
  if ($<HTMLDialogElement>('reencode-dialog').open) $('confirm-reencode').textContent = processing ? '작업 대기열 맨 뒤에 추가' : '바로 재인코딩 시작';
  renderSettings();
  updateOverall();
  installUI?.refresh();
}

function updateOverall(): void {
  const total = jobs.reduce((sum, j) => sum + j.file.size, 0);
  const handled = jobs.reduce((sum, j) => sum + j.file.size * fraction(j), 0);
  const percent = total ? handled / total * 100 : 0;
  setBar($('overall-bar'), percent);
  $('overall-percent').textContent = `${Math.floor(percent)}%`;
  const active = jobs.find(j => j.state === 'running');
  const done = jobs.filter(j => j.state === 'done').length;
  const failed = jobs.filter(j => j.state === 'error').length;
  const decisions = jobs.filter(j => j.state === 'needs-reencode').length;
  if (active) {
    $('overall-label').textContent = `${batch.lastIndexOf(active) + 1} / ${batch.length}번째 영상 처리 중`;
    $('overall-caption').textContent = `${done}개 완료${decisions ? ` · ${decisions}개 결정 필요` : ''}${failed ? ` · ${failed}개 실패` : ''} · 화면을 열어두세요`;
  } else {
    $('overall-label').textContent = inspecting ? '영상 정보 확인 중' : done === jobs.length && jobs.length ? '모든 영상 처리 완료' : decisions ? `${decisions}개 파일의 결정이 필요해요` : failed ? '실패한 파일을 확인해 주세요' : jobs.some(j => j.state === 'stopped') ? '작업이 중지됐어요' : '처리 준비';
    $('overall-caption').textContent = done || failed || decisions ? `${done}개 완료 · ${decisions}개 결정 필요 · ${failed}개 실패 · 기기 저장은 별개입니다.` : '목록의 영상은 위에서부터 하나씩 처리됩니다.';
  }
  const elapsed = (performance.now() - startedAt) / 1000;
  const batchTotal = batch.reduce((sum, j) => sum + j.file.size, 0);
  const batchHandled = batch.reduce((sum, j) => sum + j.file.size * fraction(j), 0);
  const remaining = batchHandled > 0 ? elapsed * Math.max(0, batchTotal - batchHandled) / batchHandled : Infinity;
  $('overall-eta').textContent = processing ? (['finalizing', 'resize-finalizing', 'planning'].includes(active?.progress?.phase ?? '') ? '파일 마무리·검증 중' : `예상 남은 시간 ${elapsed > 2 && batchHandled > 0 ? formatEta(remaining) : '계산 중'}`) : '';
}

function progressText(job: Job): string {
  const progress = job.progress;
  if (!progress) return '처리 준비·지원 여부 확인 중';
  if (progress.phase === 'resizing') return `해상도 변경 중 · 변환 ${Math.floor((progress.stageFraction ?? 0) * 100)}%`;
  if (progress.phase === 'resize-finalizing') return '변환 파일 마무리·검증 중';
  if (progress.phase === 'analyzing-keyframes') return '키프레임과 구간별 용량 분석 중';
  if (progress.phase === 'planning') return job.options.mode === 'resize-split' ? '실제 용량 확인·분할 구간 계산 중' : '변환 결과 확인 중';
  const label = { preparing: '파일 준비 중', copying: '압축 데이터 복사 중', finalizing: '파일 마무리 중', verifying: '실제 용량·재생 검증 중' }[progress.phase];
  return `${progress.part} / ${progress.partCount}번째 조각 · ${label}`;
}

function stageFlow(job: Job): string {
  if (job.options.splitRule !== 'size' || job.options.mode === 'resize') return '';
  const phase = job.progress?.phase;
  const current = phase === 'analyzing-keyframes' ? 0 : phase === 'planning' ? 1 : ['preparing', 'copying', 'finalizing'].includes(phase ?? '') ? 2 : phase === 'verifying' ? 3 : -1;
  return `<ol class="stage-flow" aria-label="용량 상한 처리 단계">${['키프레임 분석', '분할 계획', '파일 생성', '용량 검증'].map((label, index) => `<li class="${index < current ? 'complete' : index === current ? 'active' : ''}"><i>${index < current ? icon('check') : index + 1}</i><span>${label}</span></li>`).join('')}</ol>`;
}

function renderJob(job: Job): string {
  const info = job.info;
  const plan = job.plan;
  const waitingForCount = !!plan?.awaitingSize && job.options.mode === 'resize-split';
  const strict = job.options.splitRule === 'size' && job.options.mode !== 'resize';
  const capMb = Math.round((job.options.maxBytes ?? 250_000_000) / 1_000_000);
  const percent = job.state === 'done' ? 100 : Math.floor((job.progress?.fraction ?? 0) * 100);
  const resultRows = plan?.parts.map(part => {
    const result = job.results.find(r => r.index === part.index);
    const current = job.state === 'running' && job.progress?.part === part.index && !result;
    const requested = job.downloads.has(part.index);
    const large = result && !strict && result.size > KAKAO_REFERENCE_BYTES;
    const size = result ? (result.verifiedCap ? `${formatBytes(result.size)} / ${capMb} MB` : formatBytes(result.size)) : plan.awaitingSize ? '용량은 변환 후 확정' : `예상 ${formatBytes(part.estimatedBytes)}`;
    return `<div class="result-row ${result ? 'result-ready' : ''} ${current ? 'result-active' : ''}" data-part="${part.index}">
      <span class="part-number">${result ? icon('check') : String(part.index).padStart(2, '0')}</span>
      <div class="result-info"><strong title="${esc(result?.name ?? part.name)}">${esc(result?.name ?? part.name)}</strong><div><span>${formatTime(result?.start ?? part.start, !!result)}–${formatTime(result?.end ?? part.end, !!result)}</span><span>${result ? '' : '약 '}${formatTime(result?.duration ?? part.end - part.start, !!result)}</span><span class="${result?.verifiedCap ? 'cap-verified' : ''}">${result?.verifiedCap ? icon('shield') : ''}${size}</span>${large ? '<span class="size-warning">300MB 초과</span>' : ''}</div></div>
      ${result ? `<button class="button save-button ${requested ? 'requested' : ''}" data-action="download" data-job="${job.id}" data-part="${part.index}" aria-label="${esc(result.name)} 저장">${icon(requested ? 'check' : 'download')}<span>${requested ? '저장 요청됨' : '저장'}</span></button>` : `<span class="result-wait">${current ? '생성 중' : '예상'}</span>`}
    </div>`;
  }).join('') ?? '';
  const count = plan?.parts.length ?? 0;
  const planTitle = waitingForCount ? '변환 후 조각 수 확정' : count > 1 ? `${count}개로 분할` : plan?.reencode ? '한 파일로 저장' : '원본 그대로 유지';
  const planDetail = waitingForCount ? `변환 후 ${capMb}MB 상한으로 계획` : count > 1 ? strict ? `각 ${capMb}MB 이하 · 길이는 구간마다 다름` : `각 약 ${formatTime((plan!.parts.at(-1)?.end ?? info!.duration) / count)}` : job.options.mode === 'resize' ? '분할 없음' : strict ? `${capMb}MB 이하 · 검증 대상` : `${capMb}MB 이하 · 분할 불필요`;
  const help = job.results.length ? '실제 길이·용량 표시 · 저장 버튼을 눌러 기기에 다운로드하세요.'
    : waitingForCount ? '해상도 변경이 끝나면 실제 용량을 기준으로 파일명, 개수와 시간 구간을 표시해요.'
    : plan?.awaitingSize ? '재생시간은 유지하고 영상 해상도만 낮춰요. 실제 용량은 변환 후 표시됩니다.'
    : count > 1 ? strict ? '처리할 때 키프레임을 분석해 정확한 개수와 구간을 정하고, 생성 후 실제 용량을 검증해요.' : '예상 구간입니다. 재압축 없는 분할 지점에 따라 조금 달라질 수 있어요.'
    : plan?.reencode ? '해상도 변경이 끝났어요. 변환 파일을 하나로 저장합니다.' : '변경할 필요가 없어 원본 파일을 그대로 제공합니다.';
  return `<article class="file-card state-${job.state}" data-job-card="${job.id}">
    <div class="file-top"><span class="file-icon">${icon(job.state === 'done' ? 'check' : job.state === 'needs-reencode' ? 'wand' : 'video')}</span><div class="file-title"><h3 title="${esc(job.file.name)}">${esc(job.file.name)}</h3><p>${formatBytes(job.file.size)}${info ? `<span>·</span>${formatTime(info.duration)}<span>·</span>${info.width} × ${info.height}${info.audioTracks === 0 ? '<span>·</span>소리 없음' : ''}` : '<span>·</span>재생시간 확인 중'}</p></div><span class="status-badge">${job.state === 'analyzing' || job.state === 'running' ? '<span class="spinner"></span>' : ''}${stateLabel(job)}</span><button class="icon-button remove-file" data-action="remove" data-job="${job.id}" aria-label="${esc(job.file.name)} 목록에서 제거" ${workLocked() && job.state !== 'needs-reencode' ? 'disabled' : ''}>${icon('close')}</button></div>
    ${plan ? `<div class="conversion-info"><span class="process-tag">${job.options.forceReencode ? '재인코딩 허용' : modeLabel(job.options.mode)}</span><span>${plan.reencode ? `${info!.width} × ${info!.height} ${icon('arrow')} <strong>${plan.outputWidth} × ${plan.outputHeight}</strong>` : '해상도·화질 유지'}${plan.convertedBytes !== undefined ? ` <span class="converted-size">· 변환 후 ${formatBytes(plan.convertedBytes)}</span>` : ''}</span>${!plan.reencode && job.options.mode !== 'split' ? '<small>선택한 최대 크기 이하여서 재인코딩하지 않아요.</small>' : ''}</div><div class="file-plan">${icon(job.options.mode === 'resize' ? 'video' : strict ? 'shield' : 'split')}<strong>${planTitle}</strong><span>${planDetail}</span>${count > 1 ? `<div class="segment-strip" aria-hidden="true">${plan.parts.slice(0, 32).map(() => '<i></i>').join('')}</div>` : ''}</div>` : ''}
    ${job.state === 'running' || job.state === 'stopped' ? `<div class="file-progress">${stageFlow(job)}<div class="progress-line"><span data-progress-label>${progressText(job)}</span><strong data-progress-percent>${percent}%</strong></div><div class="progress-track" role="progressbar" aria-label="${esc(job.file.name)} 진행률" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" data-progress-bar><span style="width:${percent}%"></span></div></div>` : ''}
    ${job.state === 'needs-reencode' ? `<div class="file-decision">${icon('alert')}<div><strong>재인코딩이 필요해요</strong><p>${esc(job.error ?? '안전한 키프레임 한 구간이 선택한 용량보다 커서 원본 화질 그대로는 상한을 지킬 수 없어요.')}</p><small>다른 영상은 계속 처리돼요. 허용하기 전에는 화질을 바꾸지 않습니다.</small><div><button class="button decision-primary" data-action="reencode" data-job="${job.id}">${icon('wand')} 재인코딩 허용</button><button class="button decision-secondary" data-action="exclude" data-job="${job.id}">${icon('trash')} 목록에서 제외</button></div></div></div>` : ''}
    ${job.error && job.state !== 'needs-reencode' ? `<div class="file-error">${icon('alert')}<span>${esc(job.error)}</span>${!workLocked() ? `<button class="text-button" data-action="retry" data-job="${job.id}">${icon('retry')} 재시도</button>` : ''}</div>` : ''}
    ${plan && job.state !== 'needs-reencode' ? `<details class="result-details" data-details-job="${job.id}" ${job.expanded || job.state === 'running' ? 'open' : ''}><summary><span>${job.state === 'done' ? '처리 결과' : '예상 결과 및 생성된 파일'}<small>${waitingForCount ? '변환 후 확정' : `${job.results.length} / ${count}`}</small></span>${icon('chevron')}</summary><div class="results"><div class="result-help">${help}</div>${resultRows}${waitingForCount ? `<div class="pending-result">${icon('clock')} 영상 길이 ${formatTime(info!.duration)} · 변환 완료 후 ${strict ? '용량 상한 분할' : '시간 균등 분할'}</div>` : ''}</div></details>` : ''}
  </article>`;
}

function renderQueue(): void {
  $('queue').innerHTML = jobs.map(renderJob).join('');
  document.querySelectorAll<HTMLDetailsElement>('[data-details-job]').forEach(details => {
    details.addEventListener('toggle', () => {
      const job = jobs.find(j => j.id === details.dataset.detailsJob);
      if (job) job.expanded = details.open;
    });
  });
  renderSummary();
}

function updateProgress(job: Job): void {
  const card = document.querySelector<HTMLElement>(`[data-job-card="${job.id}"]`);
  const percent = Math.floor((job.progress?.fraction ?? 0) * 100);
  const label = card?.querySelector('[data-progress-label]');
  const value = card?.querySelector('[data-progress-percent]');
  const bar = card?.querySelector<HTMLElement>('[data-progress-bar]');
  if (label) label.textContent = progressText(job);
  if (value) value.textContent = `${percent}%`;
  if (bar) setBar(bar, percent);
  card?.querySelectorAll<HTMLElement>('.result-row').forEach(row => {
    const current = Number(row.dataset.part) === job.progress?.part && !row.classList.contains('result-ready');
    row.classList.toggle('result-active', current);
    const wait = row.querySelector('.result-wait');
    if (wait) wait.textContent = current ? '생성 중' : '예상';
  });
  updateOverall();
}

async function addFiles(files: File[]): Promise<void> {
  if (workLocked()) { toast('현재 작업이나 설치 확인이 끝나면 영상을 추가할 수 있어요.'); return; }
  const added: Job[] = [];
  let duplicates = 0;
  for (const file of files) {
    if (jobs.some(j => j.file.name === file.name && j.file.size === file.size && j.file.lastModified === file.lastModified)) { duplicates++; continue; }
    const job: Job = { id: crypto.randomUUID(), file, options: { ...options }, state: 'analyzing', results: [], expanded: false, downloads: new Set() };
    jobs.push(job); added.push(job);
  }
  if (!added.length) { if (duplicates) toast('이미 목록에 있는 영상이에요.'); return; }
  await inspectItems(added);
  $('live-status').textContent = `${added.length}개 영상의 정보 확인이 끝났습니다.`;
  if (duplicates) toast(`이미 선택한 ${duplicates}개 파일은 중복 추가하지 않았어요.`);
}

async function inspectItems(items: Job[]): Promise<void> {
  inspecting = true;
  for (const job of items) {
    job.state = 'analyzing'; job.error = undefined; job.plan = undefined; job.info = undefined; job.progress = undefined;
  }
  renderQueue();
  try {
    for (const job of items) {
      try {
        job.plan = await bridge.request<ProcessingPlan>({ id: crypto.randomUUID(), action: 'inspect', file: job.file, options: job.options });
        job.info = job.plan.source;
        job.state = 'ready';
        if (jobs.length === 1) job.expanded = true;
      } catch (error) { job.state = 'error'; job.error = errorMessage(error); }
      renderQueue();
    }
  } finally { inspecting = false; renderQueue(); }
}

async function changeOptions(next: ProcessingOptions): Promise<void> {
  if (workLocked()) { renderSettings(); return; }
  const waiting = jobs.filter(job => job.state !== 'done');
  const partial = waiting.filter(job => job.results.length > 0);
  if (partial.length && !window.confirm('대기 항목의 설정을 바꾸면 이전 임시 결과를 정리합니다. 필요한 결과를 먼저 저장했나요? 완료 항목과 원본 파일은 유지됩니다.')) { renderSettings(); return; }
  inspecting = true;
  renderQueue();
  try {
    for (const job of partial) {
      await bridge.request({ id: crypto.randomUUID(), action: 'remove', jobId: job.id });
      job.results = []; job.downloads.clear();
    }
    options = next;
    if (next.resolution !== 'original') lastResizeResolution = next.resolution;
    for (const job of waiting) job.options = { ...options };
    await inspectItems(waiting);
  } catch (error) { toast(errorMessage(error)); }
  finally { inspecting = false; renderQueue(); }
}

async function acquireWakeLock(): Promise<void> {
  if (!processing || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock?.request('screen'); }
  catch { /* Background execution is never promised; the screen-open notice remains visible. */ }
}

async function startBatch(selected?: Job[]): Promise<void> {
  if (workLocked()) return;
  const items = selected ?? jobs.filter(j => j.plan && ['ready', 'error', 'stopped'].includes(j.state));
  if (!items.length) return;
  if (items.some(j => j.results.length > 0) && !window.confirm('다시 시작하면 선택한 항목의 이전 임시 결과를 새로 만듭니다. 필요한 결과를 먼저 저장했나요? 원본과 다운로드한 파일은 유지됩니다.')) return;
  processing = true;
  controller = new AbortController();
  batch = items;
  startedAt = performance.now();
  for (const job of items) { job.state = 'queued'; job.error = undefined; job.progress = undefined; }
  renderQueue();
  await acquireWakeLock();
  try {
    await runSequential(items, async job => {
      job.state = 'running'; job.expanded = true; job.results = []; job.downloads.clear();
      activeRequest = crypto.randomUUID();
      renderQueue();
      $('live-status').textContent = `${job.file.name} 처리를 시작합니다.`;
      try {
        await bridge.request({ id: activeRequest, action: 'split', jobId: job.id, file: job.file, options: job.options }, {
          plan: plan => { job.plan = plan; job.info = plan.source; renderQueue(); },
          progress: progress => { job.progress = progress; updateProgress(job); },
          segment: result => { job.results.push(result); renderQueue(); },
        });
        job.state = 'done';
        job.error = undefined;
        $('live-status').textContent = `${job.file.name} 완료. ${job.results.length}개 결과를 저장할 수 있습니다.`;
      } catch (error) {
        job.state = controller?.signal.aborted ? 'stopped' : error instanceof Error && error.name === 'ReencodeRequiredError' ? 'needs-reencode' : 'error';
        job.error = errorMessage(error);
        if (job.state === 'needs-reencode') job.results = [];
        throw error;
      } finally { activeRequest = undefined; renderQueue(); }
    }, {
      signal: controller.signal,
      onError: (_job, error) => {
        if (error instanceof Error && ['QuotaExceededError', 'WorkerCrashedError'].includes(error.name)) { toast(errorMessage(error)); return false; }
        return true;
      },
    });
  } finally {
    processing = false;
    for (const job of items) if (job.state === 'queued') job.state = 'ready';
    await wakeLock?.release().catch(() => undefined);
    wakeLock = undefined;
    renderQueue();
    const uniqueItems = [...new Set(items)];
    const count = uniqueItems.filter(j => j.state === 'done').length;
    const failures = uniqueItems.filter(j => j.state === 'error').length;
    const decisions = uniqueItems.filter(j => j.state === 'needs-reencode').length;
    toast(controller.signal.aborted ? '작업을 중지했어요. 이미 완료된 조각은 저장할 수 있어요.' : `${count}개 영상 완료${decisions ? ` · ${decisions}개 결정 필요` : ''}${failures ? ` · ${failures}개 실패` : ''}. ${count ? '결과의 저장 버튼을 눌러 주세요.' : '파일별 안내를 확인해 주세요.'}`);
    controller = undefined;
  }
}

async function removeJobs(selected: Job[]): Promise<void> {
  if (workLocked()) return;
  if (selected.some(j => j.results.some(r => !r.original)) && !window.confirm('목록과 임시 결과를 정리할까요? 필요한 결과를 먼저 저장해 주세요. 원본 영상과 이미 다운로드한 파일은 삭제되지 않습니다.')) return;
  inspecting = true;
  renderQueue();
  for (const job of selected) {
    try { await bridge.request({ id: crypto.randomUUID(), action: 'remove', jobId: job.id }); }
    catch { toast('임시 파일 정리에 실패했어요. 이 페이지를 다시 열면 정리됩니다.'); }
    const index = jobs.indexOf(job);
    if (index >= 0) jobs.splice(index, 1);
  }
  inspecting = false;
  renderQueue();
}

function openReencodeDialog(job: Job): void {
  if (job.state !== 'needs-reencode') return;
  decisionJob = job;
  const original = document.querySelector<HTMLInputElement>('input[name="reencode-resolution"][value="original"]');
  if (original) original.checked = true;
  $('reencode-description').textContent = `${job.file.name}의 영상 데이터를 새로 압축해 촘촘한 안전 분할 지점을 만듭니다. 화질과 용량은 원본과 달라질 수 있어요.`;
  $('confirm-reencode').textContent = processing ? '작업 대기열 맨 뒤에 추가' : '바로 재인코딩 시작';
  $<HTMLDialogElement>('reencode-dialog').showModal();
}

function closeReencodeDialog(): void {
  $<HTMLDialogElement>('reencode-dialog').close();
  decisionJob = undefined;
}

async function excludeDecision(job: Job): Promise<void> {
  if (job.state !== 'needs-reencode') return;
  const index = jobs.indexOf(job);
  if (index >= 0) jobs.splice(index, 1);
  renderQueue();
  try { await bridge.request({ id: crypto.randomUUID(), action: 'remove', jobId: job.id }); }
  catch { toast('임시 파일 정리는 다음에 앱을 열 때 다시 진행돼요. 원본 파일에는 영향이 없습니다.'); }
}

function confirmReencode(): void {
  const job = decisionJob;
  if (!job || job.state !== 'needs-reencode') { closeReencodeDialog(); return; }
  const value = document.querySelector<HTMLInputElement>('input[name="reencode-resolution"]:checked')?.value ?? 'original';
  const resolution = value === 'original' ? 'original' : Number(value) as Resolution;
  job.options = {
    mode: 'resize-split', resolution, splitRule: 'size', maxBytes: job.options.maxBytes ?? TARGET_BYTES,
    forceReencode: true,
  };
  job.state = 'queued';
  job.error = undefined;
  job.progress = undefined;
  job.results = [];
  job.downloads.clear();
  closeReencodeDialog();
  if (processing) {
    batch.push(job);
    renderQueue();
    toast('재인코딩 작업을 대기열 맨 뒤에 추가했어요.');
  } else {
    void startBatch([job]);
  }
}

function download(job: Job, index: number): void {
  const result = job.results.find(r => r.index === index);
  if (!result) return;
  const url = URL.createObjectURL(result.file);
  downloadUrls.add(url);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  job.downloads.add(index);
  renderQueue();
  toast('다운로드를 요청했어요. 브라우저의 다운로드 목록에서 완료 여부를 확인해 주세요.');
  setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 60_000);
}

$('pick-files').addEventListener('click', () => ($('file-input') as HTMLInputElement).click());
$('processing-mode').addEventListener('change', event => {
  const mode = (event.target as HTMLSelectElement).value as ProcessingMode;
  void changeOptions({ ...options, mode, resolution: mode === 'split' ? 'original' : lastResizeResolution, forceReencode: false });
});
$('resolution').addEventListener('change', event => {
  const value = (event.target as HTMLSelectElement).value;
  void changeOptions({ ...options, resolution: value === 'original' ? 'original' : Number(value) as Resolution, forceReencode: false });
});
document.querySelectorAll<HTMLInputElement>('input[name="split-rule"]').forEach(input => input.addEventListener('change', () => {
  if (input.checked) void changeOptions({ ...options, splitRule: input.value as SplitRule, forceReencode: false });
}));
document.querySelectorAll<HTMLButtonElement>('[data-target-mb]').forEach(button => button.addEventListener('click', () => {
  const mb = Number(button.dataset.targetMb);
  void changeOptions({ ...options, maxBytes: mb * 1_000_000, forceReencode: false });
}));
$<HTMLInputElement>('target-mb').addEventListener('change', event => {
  const mb = Number((event.target as HTMLInputElement).value);
  if (!Number.isInteger(mb) || mb * 1_000_000 < MIN_TARGET_BYTES || mb * 1_000_000 > MAX_TARGET_BYTES) {
    toast('최대 용량은 10MB부터 2,000MB까지 정수로 입력해 주세요.');
    renderSettings();
    return;
  }
  void changeOptions({ ...options, maxBytes: mb * 1_000_000, forceReencode: false });
});
$('file-input').addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  void addFiles(files);
});
$('drop-zone').addEventListener('dragover', event => { event.preventDefault(); if (!workLocked()) $('drop-zone').classList.add('dragging'); });
$('drop-zone').addEventListener('dragleave', event => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) $('drop-zone').classList.remove('dragging'); });
$('drop-zone').addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragging'); void addFiles(Array.from(event.dataTransfer?.files ?? [])); });
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('start').addEventListener('click', () => {
  const ready = jobs.some(job => job.plan && ['ready', 'error', 'stopped'].includes(job.state));
  if (ready) void startBatch();
  else document.querySelector<HTMLElement>('.state-needs-reencode')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('stop').addEventListener('click', () => {
  controller?.abort();
  if (activeRequest) bridge.cancel(activeRequest);
  renderSummary();
});
$('clear-completed').addEventListener('click', () => { void removeJobs(jobs.filter(j => j.state === 'done')); });
$('queue').addEventListener('click', async event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!button || button.disabled) return;
  const job = jobs.find(j => j.id === button.dataset.job);
  if (!job) return;
  if (button.dataset.action === 'download') download(job, Number(button.dataset.part));
  if (button.dataset.action === 'remove') job.state === 'needs-reencode' ? await excludeDecision(job) : await removeJobs([job]);
  if (button.dataset.action === 'exclude') await excludeDecision(job);
  if (button.dataset.action === 'reencode') openReencodeDialog(job);
  if (button.dataset.action === 'retry' && !workLocked()) {
    if (!job.plan) await inspectItems([job]);
    if (job.plan) await startBatch([job]);
  }
});
$('close-reencode').addEventListener('click', closeReencodeDialog);
$('cancel-reencode').addEventListener('click', closeReencodeDialog);
$('confirm-reencode').addEventListener('click', confirmReencode);
$<HTMLDialogElement>('reencode-dialog').addEventListener('cancel', event => { event.preventDefault(); closeReencodeDialog(); });
document.addEventListener('visibilitychange', () => {
  if (processing && document.visibilityState === 'visible') void acquireWakeLock();
});
window.addEventListener('beforeunload', event => {
  if (processing || jobs.some(j => j.results.some(r => !r.original))) { event.preventDefault(); event.returnValue = ''; }
});
setInterval(() => { if (processing) updateOverall(); }, 1000);
installUI = setupInstall({
  getWork: () => ({ busy: processing || inspecting, filesSelected: jobs.length > 0, temporaryResults: jobs.some(job => job.results.some(result => !result.original)) }),
  onStateChange: renderQueue,
  toast,
});
renderSummary();
