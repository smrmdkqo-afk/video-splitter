import './style.css';
import { WorkerBridge } from './bridge.ts';
import { runSequential } from './queue.ts';
import { errorMessage, escapeHtml as esc, formatBytes, formatEta, formatTime, KAKAO_REFERENCE_BYTES } from './model.ts';
import type { SegmentResult, SplitProgress, VideoInfo } from './model.ts';

type State = 'analyzing' | 'ready' | 'queued' | 'running' | 'done' | 'error' | 'stopped';
interface Job {
  id: string; file: File; state: State; info?: VideoInfo; error?: string;
  results: SegmentResult[]; progress?: SplitProgress; expanded: boolean; downloads: Set<number>;
}
const bridge = new WorkerBridge();
const jobs: Job[] = [];
let processing = false;
let inspecting = false;
let controller: AbortController | undefined;
let activeRequest: string | undefined;
let startedAt = 0;
let batch: Job[] = [];
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
};
const icon = (name: string, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ''}</svg>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

$('app').innerHTML = `
  <header class="site-header">
    <a class="brand" href="./" aria-label="Video Splitter 처음으로"><span class="brand-mark">${icon('split')}</span><span>Video Splitter<span class="brand-dot">.</span></span></a>
    <span class="privacy-label">${icon('shield')} 내 기기에서만 처리</span>
  </header>
  <main class="workspace">
    <section class="intro" aria-labelledby="page-title">
      <div><span class="eyebrow">원본은 그대로, 공유는 가볍게</span><h1 id="page-title">영상 나누기</h1><p>여러 영상을 선택하면, 하나씩 순서대로 나눠 드려요.</p></div>
      <span class="mode-badge">${icon('split')} <strong>250 MB</strong><span>기준 · 시간 균등 분할</span></span>
    </section>

    <section id="drop-zone" class="drop-zone" aria-label="영상 파일 선택 영역">
      <div class="drop-icon">${icon('video')}</div>
      <div class="drop-copy"><h2>나눌 영상을 선택해 주세요</h2><p>여러 파일을 한 번에 선택하거나 이곳에 놓아 주세요.</p><span class="formats">MP4 · MOV · M4V <span>재압축 없이 원본 화질 유지</span></span></div>
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
        <div class="progress-heading"><span id="overall-label">분할 준비 완료</span><strong id="overall-percent">0%</strong></div>
        <div id="overall-bar" class="progress-track" role="progressbar" aria-label="전체 작업 진행률" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
        <div class="progress-caption"><span id="overall-caption">시작하면 목록 순서대로 처리합니다.</span><span id="overall-eta"></span></div>
      </div>
    </section>

    <section class="queue-section" aria-labelledby="queue-title">
      <div class="section-heading"><h2 id="queue-title">작업 목록 <span id="queue-count">0</span></h2><button id="clear-completed" class="text-button" hidden>${icon('trash')} 완료 항목 정리</button></div>
      <div id="empty-state" class="empty-state"><span class="empty-icon">${icon('folder')}</span><strong>선택한 영상이 여기에 표시돼요</strong><p>파일별 길이와 예상 분할 결과를 시작 전에 확인하세요.</p></div>
      <div id="queue" class="queue"></div>
    </section>

    <aside class="notes" aria-label="사용 안내">
      ${icon('shield')}
      <div><strong>영상은 서버로 전송하지 않아요.</strong><p>250MB는 조각 수 계산 기준이며, 실제 용량은 달라질 수 있어요. 재압축 없이 자르므로 구간은 기준 프레임에 맞춰 조금 조정됩니다.</p><p>처리 중에는 이 화면을 열어두고, 완료 후에는 필요한 결과를 저장해 주세요. 페이지를 다시 열면 임시 결과는 정리됩니다.</p></div>
    </aside>
    <footer class="page-footer"><span>VIDEO SPLITTER</span><span>v1.0.0 · 원본 파일은 변경하지 않습니다 · <a href="./third-party-notices.txt" target="_blank" rel="noopener">오픈소스 안내</a></span></footer>
  </main>

  <div id="action-bar" class="action-bar" hidden>
    <div class="action-bar-inner"><div class="action-description"><strong id="action-title">분할할 준비가 됐어요</strong><span id="action-subtitle">원본 화질을 그대로 유지합니다.</span></div><div class="action-buttons"><button id="stop" class="button secondary" hidden>${icon('stop')} 중지</button><button id="start" class="button primary">순차 분할 시작 ${icon('arrow')}</button></div></div>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  <div id="live-status" class="sr-only" role="status" aria-live="polite"></div>
`;

function toast(message: string): void {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}

function stateLabel(job: Job): string {
  return ({ analyzing: '정보 확인 중', ready: job.info?.needsSplit ? '준비 완료' : '분할 불필요', queued: '대기 중', running: '처리 중', done: '완료', error: '실패', stopped: '중지됨' })[job.state];
}

function fraction(job: Job): number {
  if (job.state === 'done' || job.state === 'error') return 1;
  return job.progress?.fraction ?? 0;
}

function setBar(element: HTMLElement, percent: number): void {
  const value = Math.min(100, Math.max(0, percent));
  element.setAttribute('aria-valuenow', String(Math.floor(value)));
  const fill = element.querySelector<HTMLElement>('span');
  if (fill) fill.style.width = `${value}%`;
}

function renderSummary(): void {
  const ready = jobs.filter(j => ['ready', 'stopped', 'error'].includes(j.state) && !!j.info);
  const totalBytes = jobs.reduce((sum, j) => sum + j.file.size, 0);
  const duration = jobs.reduce((sum, j) => sum + (j.info?.duration ?? 0), 0);
  const parts = jobs.reduce((sum, j) => sum + (j.info?.parts.length ?? 0), 0);
  const done = jobs.filter(j => j.state === 'done').length;
  const errors = jobs.filter(j => j.state === 'error').length;
  $('overview').hidden = jobs.length === 0;
  $('action-bar').hidden = jobs.length === 0;
  document.body.classList.toggle('has-jobs', jobs.length > 0);
  $('empty-state').hidden = jobs.length > 0;
  $('queue-count').textContent = `${jobs.length}`;
  $('stat-files').innerHTML = `${jobs.length}<small>개</small>`;
  $('stat-duration').textContent = formatTime(duration);
  $('stat-parts').innerHTML = `${parts}<small>개</small>`;
  $('clear-completed').hidden = !done;
  ($('clear-completed') as HTMLButtonElement).disabled = processing || inspecting;
  ($('pick-files') as HTMLButtonElement).disabled = processing || inspecting;
  $('drop-zone').classList.toggle('disabled', processing || inspecting);
  $('start').hidden = processing;
  ($('start') as HTMLButtonElement).disabled = inspecting || ready.length === 0;
  $('start').innerHTML = inspecting ? '<span class="spinner"></span> 영상 정보 확인 중' : ready.length ? `순차 분할 시작 ${icon('arrow')}` : errors ? '파일 확인 필요' : `${icon('check')} 작업 완료`;
  $('stop').hidden = !processing;
  ($('stop') as HTMLButtonElement).disabled = !!controller?.signal.aborted;
  $('action-title').textContent = processing ? (controller?.signal.aborted ? '현재 작업을 중지하고 있어요' : '한 영상씩 순서대로 처리하고 있어요') : inspecting ? '영상 정보를 확인하고 있어요' : ready.length ? `${ready.length}개 영상이 준비됐어요` : errors ? '처리하지 못한 영상을 확인해 주세요' : '필요한 결과를 저장해 주세요';
  $('action-subtitle').textContent = processing ? '완료된 조각은 처리 중에도 저장할 수 있어요.' : `${formatBytes(totalBytes)} · 예상 결과 ${parts}개 · 원본 유지`;
  updateOverall();
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
  if (active) {
    $('overall-label').textContent = `${batch.indexOf(active) + 1} / ${batch.length}번째 영상 처리 중`;
    $('overall-caption').textContent = `${done}개 완료${failed ? ` · ${failed}개 실패` : ''} · 화면을 열어두세요`;
  } else {
    $('overall-label').textContent = inspecting ? '영상 정보 확인 중' : done === jobs.length && jobs.length ? '모든 영상 처리 완료' : failed ? '실패한 파일을 확인해 주세요' : jobs.some(j => j.state === 'stopped') ? '작업이 중지됐어요' : '분할 준비';
    $('overall-caption').textContent = done || failed ? `${done}개 완료 · ${failed}개 실패 · 분할 완료와 기기 저장은 별개입니다.` : '목록의 영상은 위에서부터 하나씩 처리됩니다.';
  }
  const elapsed = (performance.now() - startedAt) / 1000;
  const batchTotal = batch.reduce((sum, j) => sum + j.file.size, 0);
  const batchHandled = batch.reduce((sum, j) => sum + j.file.size * fraction(j), 0);
  const remaining = batchHandled > 0 ? elapsed * Math.max(0, batchTotal - batchHandled) / batchHandled : Infinity;
  $('overall-eta').textContent = processing ? (active?.progress?.phase === 'finalizing' ? '파일 마무리 중' : `남은 시간 ${elapsed > 2 && batchHandled > 0 ? formatEta(remaining) : '계산 중'}`) : '';
}

function progressText(job: Job): string {
  const progress = job.progress;
  if (!progress) return '분할 구간 확인 중';
  const label = { preparing: '파일 준비 중', copying: '원본 데이터 복사 중', finalizing: '파일 마무리·검증 중' }[progress.phase];
  return `${progress.part} / ${progress.partCount}번째 조각 · ${label}`;
}

function renderJob(job: Job): string {
  const info = job.info;
  const percent = job.state === 'done' ? 100 : Math.floor((job.progress?.fraction ?? 0) * 100);
  const resultRows = info?.parts.map(part => {
    const result = job.results.find(r => r.index === part.index);
    const current = job.state === 'running' && job.progress?.part === part.index && !result;
    const requested = job.downloads.has(part.index);
    const large = result && result.size > KAKAO_REFERENCE_BYTES;
    return `<div class="result-row ${result ? 'result-ready' : ''} ${current ? 'result-active' : ''}" data-part="${part.index}">
      <span class="part-number">${result ? icon('check') : String(part.index).padStart(2, '0')}</span>
      <div class="result-info"><strong title="${esc(result?.name ?? part.name)}">${esc(result?.name ?? part.name)}</strong><div><span>${formatTime(result?.start ?? part.start, !!result)}–${formatTime(result?.end ?? part.end, !!result)}</span><span>${result ? '' : '약 '}${formatTime(result?.duration ?? part.end - part.start, !!result)}</span><span>${result ? '' : '예상 '}${formatBytes(result?.size ?? part.estimatedBytes)}</span>${large ? '<span class="size-warning">300MB 초과</span>' : ''}</div></div>
      ${result ? `<button class="button save-button ${requested ? 'requested' : ''}" data-action="download" data-job="${job.id}" data-part="${part.index}" aria-label="${esc(result.name)} 저장">${icon(requested ? 'check' : 'download')}<span>${requested ? '저장 요청됨' : '저장'}</span></button>` : `<span class="result-wait">${current ? '생성 중' : '예상'}</span>`}
    </div>`;
  }).join('') ?? '';
  return `<article class="file-card state-${job.state}" data-job-card="${job.id}">
    <div class="file-top"><span class="file-icon">${icon(job.state === 'done' ? 'check' : 'video')}</span><div class="file-title"><h3 title="${esc(job.file.name)}">${esc(job.file.name)}</h3><p>${formatBytes(job.file.size)}${info ? `<span>·</span>${formatTime(info.duration)}<span>·</span>${info.width} × ${info.height}${info.audioTracks === 0 ? '<span>·</span>소리 없음' : ''}` : '<span>·</span>재생시간 확인 중'}</p></div><span class="status-badge">${job.state === 'analyzing' || job.state === 'running' ? '<span class="spinner"></span>' : ''}${stateLabel(job)}</span><button class="icon-button remove-file" data-action="remove" data-job="${job.id}" aria-label="${esc(job.file.name)} 목록에서 제거" ${processing || inspecting ? 'disabled' : ''}>${icon('close')}</button></div>
    ${info ? `<div class="file-plan">${icon('split')}<strong>${info.needsSplit ? `${info.parts.length}개로 분할` : '원본 그대로 유지'}</strong><span>${info.needsSplit ? `각 약 ${formatTime(info.duration / info.parts.length)}` : '250MB 이하 · 나눌 필요 없어요'}</span>${info.needsSplit ? `<div class="segment-strip" aria-hidden="true">${info.parts.slice(0, 32).map(() => '<i></i>').join('')}</div>` : ''}</div>` : ''}
    ${job.state === 'running' || job.state === 'stopped' ? `<div class="file-progress"><div><span data-progress-label>${progressText(job)}</span><strong data-progress-percent>${percent}%</strong></div><div class="progress-track" role="progressbar" aria-label="${esc(job.file.name)} 진행률" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" data-progress-bar><span style="width:${percent}%"></span></div></div>` : ''}
    ${job.error ? `<div class="file-error">${icon('alert')}<span>${esc(job.error)}</span>${!processing && !inspecting ? `<button class="text-button" data-action="retry" data-job="${job.id}">${icon('retry')} 재시도</button>` : ''}</div>` : ''}
    ${info ? `<details class="result-details" data-details-job="${job.id}" ${job.expanded || job.state === 'running' ? 'open' : ''}><summary><span>${job.state === 'done' ? '분할 결과' : '예상 결과 및 생성된 파일'}<small>${job.results.length} / ${info.parts.length}</small></span>${icon('chevron')}</summary><div class="results"><div class="result-help">${job.results.length ? '실제 길이·용량 표시 · 저장 버튼을 눌러 기기에 다운로드하세요.' : '예상 구간입니다. 재압축 없는 분할 지점에 따라 조금 달라질 수 있어요.'}</div>${resultRows}</div></details>` : ''}
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
  if (processing || inspecting) { toast('현재 작업이 끝나면 영상을 추가할 수 있어요.'); return; }
  const added: Job[] = [];
  let duplicates = 0;
  for (const file of files) {
    if (jobs.some(j => j.file.name === file.name && j.file.size === file.size && j.file.lastModified === file.lastModified)) { duplicates++; continue; }
    const job: Job = { id: crypto.randomUUID(), file, state: 'analyzing', results: [], expanded: false, downloads: new Set() };
    jobs.push(job); added.push(job);
  }
  if (!added.length) { if (duplicates) toast('이미 목록에 있는 영상이에요.'); return; }
  inspecting = true;
  renderQueue();
  for (const job of added) {
    try {
      job.info = await bridge.request<VideoInfo>({ id: crypto.randomUUID(), action: 'inspect', file: job.file });
      job.state = 'ready';
      if (jobs.length === 1) job.expanded = true;
    } catch (error) { job.state = 'error'; job.error = errorMessage(error); }
    renderQueue();
  }
  inspecting = false;
  renderQueue();
  $('live-status').textContent = `${added.length}개 영상의 정보 확인이 끝났습니다.`;
  if (duplicates) toast(`이미 선택한 ${duplicates}개 파일은 중복 추가하지 않았어요.`);
}

async function acquireWakeLock(): Promise<void> {
  if (!processing || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock?.request('screen'); }
  catch { /* Background execution is never promised; the screen-open notice remains visible. */ }
}

async function startBatch(selected?: Job[]): Promise<void> {
  if (processing || inspecting) return;
  const items = selected ?? jobs.filter(j => j.info && ['ready', 'error', 'stopped'].includes(j.state));
  if (!items.length) return;
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
        await bridge.request({ id: activeRequest, action: 'split', jobId: job.id, file: job.file }, {
          progress: progress => { job.progress = progress; updateProgress(job); },
          segment: result => { job.results.push(result); renderQueue(); },
        });
        job.state = 'done';
        job.error = undefined;
        $('live-status').textContent = `${job.file.name} 완료. ${job.results.length}개 결과를 저장할 수 있습니다.`;
      } catch (error) {
        job.state = controller?.signal.aborted ? 'stopped' : 'error';
        job.error = errorMessage(error);
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
    const count = items.filter(j => j.state === 'done').length;
    const failures = items.filter(j => j.state === 'error').length;
    toast(controller.signal.aborted ? '작업을 중지했어요. 이미 완료된 조각은 저장할 수 있어요.' : `${count}개 영상 완료${failures ? ` · ${failures}개 실패` : ''}. ${count ? '결과의 저장 버튼을 눌러 주세요.' : '파일별 안내를 확인해 주세요.'}`);
    controller = undefined;
  }
}

async function removeJobs(selected: Job[]): Promise<void> {
  if (processing || inspecting) return;
  if (selected.some(j => j.results.some(r => !r.original)) && !window.confirm('목록과 임시 결과를 정리할까요? 필요한 결과를 먼저 저장해 주세요. 원본 영상과 이미 다운로드한 파일은 삭제되지 않습니다.')) return;
  for (const job of selected) {
    try { await bridge.request({ id: crypto.randomUUID(), action: 'remove', jobId: job.id }); }
    catch { toast('임시 파일 정리에 실패했어요. 이 페이지를 다시 열면 정리됩니다.'); }
    const index = jobs.indexOf(job);
    if (index >= 0) jobs.splice(index, 1);
  }
  renderQueue();
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
$('file-input').addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  void addFiles(files);
});
$('drop-zone').addEventListener('dragover', event => { event.preventDefault(); if (!processing && !inspecting) $('drop-zone').classList.add('dragging'); });
$('drop-zone').addEventListener('dragleave', event => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) $('drop-zone').classList.remove('dragging'); });
$('drop-zone').addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragging'); void addFiles(Array.from(event.dataTransfer?.files ?? [])); });
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('start').addEventListener('click', () => { void startBatch(); });
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
  if (button.dataset.action === 'remove') await removeJobs([job]);
  if (button.dataset.action === 'retry' && !processing && !inspecting) {
    if (!job.info) {
      inspecting = true; job.state = 'analyzing'; job.error = undefined; renderQueue();
      try { job.info = await bridge.request<VideoInfo>({ id: crypto.randomUUID(), action: 'inspect', file: job.file }); job.state = 'ready'; }
      catch (error) { job.state = 'error'; job.error = errorMessage(error); }
      finally { inspecting = false; renderQueue(); }
    }
    if (job.info) await startBatch([job]);
  }
});
document.addEventListener('visibilitychange', () => {
  if (processing && document.visibilityState === 'visible') void acquireWakeLock();
});
window.addEventListener('beforeunload', event => {
  if (processing || jobs.some(j => j.results.some(r => !r.original))) { event.preventDefault(); event.returnValue = ''; }
});
setInterval(() => { if (processing) updateOverall(); }, 1000);
renderSummary();
