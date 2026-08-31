export interface InstallChoice { outcome: 'accepted' | 'dismissed'; platform?: string }
export interface NativeInstallPrompt {
  preventDefault(): void;
  prompt(): Promise<InstallChoice | void>;
  userChoice?: Promise<InstallChoice>;
}
export interface InstallWork { busy: boolean; filesSelected: boolean; temporaryResults: boolean }
export type InstallResult = 'busy' | 'confirm' | 'manual' | 'installed' | 'accepted' | 'dismissed' | 'requested' | 'failed';

// No storage flag: uninstalling the app must not permanently hide its install button.
export class InstallModel {
  private pending: NativeInstallPrompt | undefined;
  private inPrompt = false;
  private accepted = false;
  private installed = false;
  private standalone = false;
  private onChange: () => void;

  constructor(onChange: () => void = () => {}) { this.onChange = onChange; }
  get prompting(): boolean { return this.inPrompt; }
  get snapshot() {
    return { nativeAvailable: !!this.pending, prompting: this.inPrompt, accepted: this.accepted, hidden: this.installed || this.standalone };
  }
  button(work: InstallWork) {
    return {
      hidden: this.snapshot.hidden,
      disabled: work.busy || this.inPrompt,
      label: this.inPrompt ? '설치 확인 중' : this.pending ? '앱 설치' : this.accepted ? '설치 확인' : '설치 방법',
    };
  }
  capture(event: NativeInstallPrompt): void {
    event.preventDefault(); // Wait for a deliberate click; never interrupt video processing.
    if (this.snapshot.hidden) return;
    this.pending = event;
    this.accepted = false;
    this.onChange();
  }
  setStandalone(value: boolean): void {
    if (this.standalone === value) return;
    this.standalone = value;
    if (value) { this.pending = undefined; this.accepted = false; }
    this.onChange();
  }
  markInstalled(): void {
    this.installed = true;
    this.accepted = false;
    this.pending = undefined;
    this.onChange();
  }
  async request(work: InstallWork, acknowledged = false): Promise<InstallResult> {
    if (work.busy || this.inPrompt) return 'busy';
    if (this.snapshot.hidden) return 'installed';
    if ((work.filesSelected || work.temporaryResults) && !acknowledged) return 'confirm';
    const event = this.pending;
    if (!event) return 'manual';
    this.pending = undefined; // A native event is single-use, including cancellation or failure.
    this.inPrompt = true;
    this.accepted = false;
    try {
      this.onChange();
      // Invoke in the click's user activation, before any await or asynchronous work.
      const result = await event.prompt();
      const choice = result ?? await event.userChoice;
      if (choice?.outcome === 'accepted') {
        if (!this.snapshot.hidden && !this.pending) this.accepted = true;
        return 'accepted'; // Acceptance alone is not evidence that installation finished.
      }
      return choice?.outcome === 'dismissed' ? 'dismissed' : 'requested';
    } catch { return 'failed'; }
    finally { this.inPrompt = false; this.onChange(); }
  }
}

export type InstallPlatform = 'ios' | 'samsung' | 'android' | 'mac' | 'desktop';
export function installPlatform(userAgent: string, touchPoints = 0): InstallPlatform {
  // Detection selects help text only. Native installation is always capability-driven.
  if (/iPad|iPhone|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touchPoints > 1)) return 'ios';
  if (/Android/i.test(userAgent)) return /SamsungBrowser/i.test(userAgent) ? 'samsung' : 'android';
  return /Macintosh|Mac OS X/i.test(userAgent) ? 'mac' : 'desktop';
}
export const installGuides: Record<InstallPlatform, { title: string; steps: string[] }> = {
  ios: { title: 'iPhone · iPad', steps: [
    '아래 주소를 Safari에서 열어 주세요. 앱 안에서 보고 있다면 주소를 복사해 Safari에 붙여 넣으세요.',
    'Safari의 공유 메뉴에서 “홈 화면에 추가”를 선택하세요.',
    '“웹 앱으로 열기”가 보이면 켜고 “추가”를 누르세요. 메뉴 위치는 iOS 버전에 따라 달라요.',
  ] },
  samsung: { title: '삼성 인터넷', steps: [
    '브라우저 메뉴에서 “현재 페이지 추가” → “홈 화면”을 찾아보세요.',
    '설치 또는 추가 안내를 확인하세요. 버전에 따라 메뉴 이름이 달라요.',
    '설치 항목이 없다면 아래 주소를 Chrome에서 열고 “앱 설치” 또는 “홈 화면에 추가”를 확인하세요.',
  ] },
  android: { title: 'Android', steps: [
    '아래 주소를 Chrome 또는 삼성 인터넷의 일반 탭에서 열어 주세요.',
    'Chrome 메뉴의 “앱 설치” 또는 “홈 화면에 추가”를 선택하세요. 삼성 인터넷은 “현재 페이지 추가” → “홈 화면”을 확인하세요.',
    '설치 안내를 확인하세요. 시크릿 모드나 관리되는 기기는 설치가 제한될 수 있어요.',
  ] },
  mac: { title: 'Mac', steps: [
    'Chrome·Edge에서 주소창의 설치 아이콘이나 메뉴의 앱 설치 항목을 확인하세요.',
    '지원되는 Safari에서는 “파일” → “Dock에 추가”를 사용할 수 있어요.',
    '이미 설치했다면 Dock이나 응용 프로그램에서 Video Splitter 아이콘을 찾아보세요.',
  ] },
  desktop: { title: '컴퓨터', steps: [
    '아래 주소를 Chrome 또는 Edge에서 열어 주세요.',
    '주소창의 설치 아이콘이나 브라우저 메뉴의 앱 설치 항목을 확인하세요.',
    '이미 설치했다면 시작 메뉴나 앱 목록에서 Video Splitter 아이콘을 찾아보세요.',
  ] },
};
export function installAddress(pageUrl: string, base = './'): string {
  const url = new URL(base, pageUrl);
  url.search = ''; url.hash = '';
  return url.href;
}
