import { appDetailsHeaderClasses, callable, definePlugin, IconsModule } from '@steambrew/client';

const INTERVAL_MS = 8000;
const FADE_MS = 1200;
const ZOOM_TO: number = 1.12;
const ZOOM_SECONDS = 25;
const TICK_MS = 300;
const REFETCH_AFTER_MS = 60_000;

const PLUGIN_NAME = 'MemorableScreenshots';
const CACHE_URL_BASE = 'https://steamloopback.host/MemorableScreenshots';

const CLASSIC_KEY = 'MemorableScreenshots.classicMode';
let classicMemory = false;

const readClassic = (): boolean => {
	try {
		return localStorage.getItem(CLASSIC_KEY) === '1';
	} catch {
		return classicMemory;
	}
};

const writeClassic = (on: boolean) => {
	classicMemory = on;
	try {
		localStorage.setItem(CLASSIC_KEY, on ? '1' : '0');
	} catch {}
};

const log = (...args: any[]) => console.log('[MemorableScreenshots]', ...args);
let lastStatus = '';
const status = (msg: string) => {
	if (msg !== lastStatus) {
		lastStatus = msg;
		log(msg);
	}
};

const getScreenshotsCallable = callable<[{ appid: number }], string>('get_screenshots');

async function getScreenshots(appid: number): Promise<any> {
	let raw: any;
	try {
		raw = await getScreenshotsCallable({ appid });
	} catch (e) {
		log('callable failed, trying Millennium.callServerMethod', e);
		raw = await (window as any).Millennium.callServerMethod(PLUGIN_NAME, 'get_screenshots', { appid });
	}
	if (typeof raw === 'string') return JSON.parse(raw);
	return raw;
}

let hookedDoc: Document | undefined;

function onWindowCreated(ctx: any) {
	try {
		const win: Window | undefined = ctx?.m_popup ?? ctx?.window;
		const name: string = ctx?.m_strName ?? (win as any)?.name ?? '';
		if (win?.document && /SP Desktop/i.test(name)) hookedDoc = win.document;
	} catch {}
}

function getMainDocument(): Document | undefined {
	try {
		if (hookedDoc?.defaultView && !hookedDoc.defaultView.closed) return hookedDoc;
		const pm = (window as any).g_PopupManager;
		const popup = pm?.GetExistingPopup?.('SP Desktop_uid0');
		const doc: Document | undefined = popup?.window?.document ?? popup?.m_popup?.document;
		if (doc?.defaultView && !doc.defaultView.closed) return doc;
	} catch {}
	return undefined;
}

const cls = (name: string): string | undefined => (appDetailsHeaderClasses as any)?.[name];

function findHeroImages(doc: Document): HTMLImageElement[] {
	const notOurs = (img: HTMLImageElement) => !img.dataset.sbgLayer && !/logo/i.test(img.src);

	const capsule = cls('TopCapsule');
	if (capsule) {
		const root = doc.querySelector('.' + capsule);
		if (root) {
			const logoClasses = [cls('TitleLogo'), cls('TitleImageContainer'), cls('SVGTitle')].filter(Boolean) as string[];
			const found = Array.from(root.querySelectorAll('img')).filter(
				(img) => notOurs(img) && !logoClasses.some((c) => img.closest('.' + c)),
			);
			if (found.length) return found;
		}
	}

	return Array.from(doc.querySelectorAll('img')).filter(
		(img) => notOurs(img) && /library_hero|_hero\.|\/hero/i.test(img.src) && img.offsetWidth > 300,
	);
}

function detectAppId(heroSrc: string | undefined, doc?: Document): number | undefined {
	const routeRe = /\/library\/app\/(\d+)/;
	try {
		const m = doc?.defaultView?.location?.href?.match(routeRe);
		if (m) return Number(m[1]);
	} catch {}
	try {
		const w: any = window;
		const path: string | undefined = w.SteamUIStore?.MainWindowBrowserManager?.m_lastLocation?.pathname;
		const m = path?.match(routeRe);
		if (m) return Number(m[1]);
	} catch {}
	if (heroSrc) {
		const patterns = [/\/assets\/(\d+)[_/]/, /\/apps\/(\d+)\//, /\/library_assets\/(\d+)\//, /(\d{3,})[_/](?:library_hero|header|hero)/];
		for (const p of patterns) {
			const m = heroSrc.match(p);
			if (m) return Number(m[1]);
		}
	}
	return undefined;
}

interface Target {
	orig: HTMLImageElement;
	base: HTMLImageElement;
	top: HTMLImageElement;
	shown: boolean;
}

const SYNCED_PROPS = [
	'filter',
	'mask-image',
	'mask-size',
	'mask-position',
	'mask-repeat',
	'-webkit-mask-image',
	'-webkit-mask-size',
	'-webkit-mask-position',
	'-webkit-mask-repeat',
];

const HIDE_ATTR = 'data-sbg-hide';
const ZOOM_MS = Math.max(ZOOM_SECONDS * 1000, INTERVAL_MS + FADE_MS * 2 + 2000);
const OUT_DELAY = 0.3;

function ensureStyle(doc: Document) {
	if (doc.getElementById('sbg-style')) return;
	const st = doc.createElement('style');
	st.id = 'sbg-style';
	const delay = Math.round(FADE_MS * OUT_DELAY);
	st.textContent =
		`img[${HIDE_ATTR}="1"]{opacity:0 !important;}` +
		`img[${HIDE_ATTR}="fade"]{opacity:0 !important;transition:opacity ${FADE_MS - delay}ms linear ${delay}ms !important;}` +
		`img[${HIDE_ATTR}="show"]{transition:opacity ${FADE_MS}ms ease-out !important;}`;
	(doc.head ?? doc.documentElement).appendChild(st);
}

function pinLayer(el: HTMLImageElement, orig: HTMLImageElement): void {
	try {
		const view = orig.ownerDocument.defaultView!;
		const cs = view.getComputedStyle(orig);
		if (cs.position === 'absolute' || cs.position === 'fixed') return;
		const parent = orig.parentElement;
		if (parent && view.getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
		const s = el.style;
		s.setProperty('position', 'absolute', 'important');
		s.setProperty('top', orig.offsetTop + 'px', 'important');
		s.setProperty('left', orig.offsetLeft + 'px', 'important');
		s.setProperty('width', orig.offsetWidth + 'px', 'important');
		s.setProperty('height', orig.offsetHeight + 'px', 'important');
		s.setProperty('object-fit', cs.objectFit || 'cover', 'important');
		el.dataset.sbgPinned = '1';
	} catch {}
}

function makeLayer(orig: HTMLImageElement): HTMLImageElement {
	const el = orig.cloneNode(false) as HTMLImageElement;
	el.removeAttribute('srcset');
	el.removeAttribute('src');
	el.removeAttribute(HIDE_ATTR);
	el.dataset.sbgLayer = '1';
	el.alt = '';
	const s = el.style;
	s.setProperty('display', 'block', 'important');
	s.setProperty('visibility', 'visible', 'important');
	s.setProperty('opacity', '0', 'important');
	s.setProperty('pointer-events', 'none', 'important');
	s.setProperty('transition', 'none', 'important');
	s.setProperty('will-change', 'opacity', 'important');

	pinLayer(el, orig);
	return el;
}

const preload = (url: string) =>
	new Promise<boolean>((resolve) => {
		const img = new Image();
		img.onload = () => resolve(true);
		img.onerror = () => resolve(false);
		img.src = url;
	});

const nextFrame = (win: Window) => new Promise<void>((r) => win.requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const decode = (el: HTMLImageElement) => (el.decode ? el.decode().catch(() => {}) : Promise.resolve());

function transitionDone(el: HTMLElement, fallbackMs: number): Promise<void> {
	return new Promise<void>((resolve) => {
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			el.removeEventListener('transitionend', onEnd);
			el.removeEventListener('transitioncancel', finish);
			resolve();
		};
		const onEnd = (e: Event) => {
			if ((e as TransitionEvent).propertyName === 'opacity') finish();
		};
		el.addEventListener('transitionend', onEnd);
		el.addEventListener('transitioncancel', finish);
		setTimeout(finish, fallbackMs);
	});
}

class Cycle {
	readonly appid: number;
	readonly classic: boolean;
	private urls: string[];
	private targets: Target[] = [];
	private index = -1;
	private currentUrl: string | undefined;
	private timer: number | undefined;
	private stopped = false;
	private finished = false;
	private busy = false;
	private zoomOrigin = 0;
	private zooms = new WeakMap<HTMLElement, Animation>();
	private resizeObserver: ResizeObserver | undefined;
	private styleObserver: MutationObserver | undefined;
	private scrollDoc: Document | undefined;
	private onScroll = () => this.syncStyle();

	constructor(appid: number, urls: string[], heroes: HTMLImageElement[], classic: boolean) {
		this.appid = appid;
		this.classic = classic;
		this.urls = urls;
		if (urls.length) {
			this.targets = heroes.map((orig) => this.makeTarget(orig));
			this.syncStyle();
		}
	}

	private zoom(el: HTMLImageElement, elapsed = 0) {
		this.stopZoom(el);
		if (ZOOM_TO === 1 || this.classic) return;
		try {
			const steps = 12;
			const frames: Keyframe[] = [];
			for (let i = 0; i <= steps; i++) {
				const f = i / steps;
				const sc = 1 + (ZOOM_TO - 1) * f;
				const inset = ((1 - 1 / sc) / 2) * 100;
				frames.push({ offset: f, transform: `scale(${sc})`, clipPath: `inset(${inset.toFixed(3)}%)` });
			}
			const anim = el.animate(frames, { duration: ZOOM_MS, easing: 'linear', fill: 'forwards' });
			anim.currentTime = Math.max(0, elapsed);
			this.zooms.set(el, anim);
		} catch {}
	}

	private stopZoom(el: HTMLElement) {
		try {
			this.zooms.get(el)?.cancel();
		} catch {}
		this.zooms.delete(el);
	}

	syncGeometry() {
		if (this.finished) return;
		this.syncStyle();
		for (const t of this.targets) {
			if (!t.orig.isConnected) continue;
			if (t.base.dataset.sbgPinned) pinLayer(t.base, t.orig);
			if (t.top.dataset.sbgPinned) pinLayer(t.top, t.orig);
		}
	}

	private observe(orig: HTMLImageElement) {
		try {
			const RO = (orig.ownerDocument.defaultView as any)?.ResizeObserver ?? (window as any).ResizeObserver;
			if (!RO) return;
			this.resizeObserver ??= new RO(() => this.syncGeometry());
			this.resizeObserver!.observe(orig);
			if (orig.parentElement) this.resizeObserver!.observe(orig.parentElement);

			const MO = (orig.ownerDocument.defaultView as any)?.MutationObserver ?? MutationObserver;
			this.styleObserver ??= new MO(() => this.syncStyle());
			this.styleObserver!.observe(orig, { attributes: true, attributeFilter: ['style', 'class'] });

			if (!this.scrollDoc) {
				this.scrollDoc = orig.ownerDocument;
				this.scrollDoc.addEventListener('scroll', this.onScroll, true);
			}
		} catch {}
	}

	private unobserve() {
		this.resizeObserver?.disconnect();
		this.styleObserver?.disconnect();
		this.scrollDoc?.removeEventListener('scroll', this.onScroll, true);
		this.scrollDoc = undefined;
	}

	syncStyle() {
		if (this.finished) return;
		for (const t of this.targets) {
			if (!t.orig.isConnected) continue;
			const computed = t.orig.ownerDocument.defaultView!.getComputedStyle(t.orig);
			for (const prop of SYNCED_PROPS) {
				const value = computed.getPropertyValue(prop);
				if (!value) continue;
				for (const el of [t.base, t.top]) {
					if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value, 'important');
				}
			}
		}
	}

	private removeLayers() {
		for (const t of this.targets) {
			this.stopZoom(t.base);
			this.stopZoom(t.top);
			t.base.remove();
			t.top.remove();
		}
	}

	private makeTarget(orig: HTMLImageElement): Target {
		ensureStyle(orig.ownerDocument);
		this.observe(orig);
		const t: Target = { orig, base: makeLayer(orig), top: makeLayer(orig), shown: false };
		this.attach(t);
		return t;
	}

	private attach(t: Target) {
		if (t.base.previousElementSibling !== t.orig) t.orig.after(t.base);
		if (t.top.previousElementSibling !== t.base) t.base.after(t.top);
	}

	private setOpacity(el: HTMLImageElement, value: string, transition = 'none') {
		el.style.setProperty('transition', transition, 'important');
		el.style.setProperty('opacity', value, 'important');
	}

	private showInstantly(t: Target, url: string) {
		this.attach(t);
		this.setOpacity(t.top, '0');
		t.base.src = url;
		this.setOpacity(t.base, '1');
		this.zoom(t.base, performance.now() - this.zoomOrigin);
		t.orig.setAttribute(HIDE_ATTR, '1');
		t.shown = true;
	}

	maintain(heroes: HTMLImageElement[]) {
		if (this.stopped || this.finished || this.busy || !this.urls.length) return;

		const same = heroes.length === this.targets.length && heroes.every((h, i) => h === this.targets[i].orig);
		if (!same) {
			this.unobserve();
			this.removeLayers();
			this.targets = heroes.map((orig) => this.makeTarget(orig));
			this.syncStyle();
			if (this.currentUrl) for (const t of this.targets) this.showInstantly(t, this.currentUrl);
			return;
		}

		for (const t of this.targets) {
			if (!t.shown || !this.currentUrl) continue;
			if (!t.base.isConnected || !t.top.isConnected || t.base.parentElement !== t.orig.parentElement) this.attach(t);
			if (t.base.getAttribute('src') !== this.currentUrl) t.base.src = this.currentUrl;
			if (t.base.style.getPropertyValue('opacity') !== '1') t.base.style.setProperty('opacity', '1', 'important');
			if (t.orig.getAttribute(HIDE_ATTR) !== '1') t.orig.setAttribute(HIDE_ATTR, '1');
		}
	}

	async start() {
		if (!this.urls.length) return;
		await this.advance();
		if (!this.classic && !this.stopped && !this.finished) {
			this.timer = window.setInterval(() => void this.advance(), INTERVAL_MS);
		}
	}

	stop() {
		this.stopped = true;
		this.unobserve();
		if (this.timer !== undefined) window.clearInterval(this.timer);
		this.removeLayers();
		for (const t of this.targets) t.orig.removeAttribute(HIDE_ATTR);
	}

	private async finish() {
		if (this.timer !== undefined) window.clearInterval(this.timer);
		this.timer = undefined;
		const targets = this.targets;
		if (this.currentUrl) {
			const outDelay = Math.round(FADE_MS * OUT_DELAY);
			const done = Promise.all(targets.map((t) => transitionDone(t.base, FADE_MS + 600)));
			for (const t of targets) {
				this.setOpacity(t.base, '0', `opacity ${FADE_MS - outDelay}ms linear ${outDelay}ms`);
				t.orig.setAttribute(HIDE_ATTR, 'show');
			}
			await done;
			if (this.stopped) return;
		}
		this.finished = true;
		this.unobserve();
		this.removeLayers();
		for (const t of targets) t.orig.removeAttribute(HIDE_ATTR);
	}

	private async advance() {
		if (this.busy || this.stopped || this.finished || this.targets.length === 0 || !this.targets.every((t) => t.orig.isConnected)) return;
		this.busy = true;
		try {
			let url: string | undefined;
			while (this.index + 1 < this.urls.length) {
				this.index++;
				const candidate = this.urls[this.index];
				if (await preload(candidate)) {
					url = candidate;
					break;
				}
			}
			if (this.stopped) return;
			if (!url) {
				if (this.classic) for (const t of this.targets) t.orig.removeAttribute(HIDE_ATTR);
				else await this.finish();
				return;
			}

			if (this.classic) {
				for (const t of this.targets) t.base.src = url;
				await Promise.all(this.targets.map((t) => decode(t.base)));
				if (this.stopped) return;
				for (const t of this.targets) this.showInstantly(t, url);
				this.currentUrl = url;
				return;
			}

			const win = this.targets[0].orig.ownerDocument.defaultView!;
			const targets = this.targets;

			for (const t of targets) {
				this.attach(t);
				this.setOpacity(t.top, '0');
				t.top.src = url;
			}
			await Promise.all(targets.map((t) => decode(t.top)));
			if (this.stopped) return;
			for (const t of targets) this.setOpacity(t.top, '0.01');
			await nextFrame(win);
			await nextFrame(win);
			await sleep(60);
			if (this.stopped) return;

			const outDelay = Math.round(FADE_MS * OUT_DELAY);
			const topFade = `opacity ${FADE_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`;
			const outFade = `opacity ${FADE_MS - outDelay}ms linear ${outDelay}ms`;
			const waits: Promise<void>[] = [];
			for (const t of targets) {
				waits.push(transitionDone(t.top, FADE_MS + 3000));
				waits.push(transitionDone(t.shown ? t.base : t.orig, FADE_MS + 600));
			}
			const done = Promise.all(waits);
			this.zoomOrigin = performance.now();
			for (const t of targets) {
				this.zoom(t.top, 0);
				this.setOpacity(t.top, '1', topFade);
				if (t.shown) this.setOpacity(t.base, '0', outFade);
				else t.orig.setAttribute(HIDE_ATTR, 'fade');
			}
			await done;
			if (this.stopped) return;
			await nextFrame(win);

			for (const t of targets) {
				this.setOpacity(t.base, '0');
				t.base.src = url;
			}
			await Promise.all(targets.map((t) => decode(t.base)));
			if (this.stopped) return;
			const zoomElapsed = performance.now() - this.zoomOrigin;
			for (const t of targets) {
				this.zoom(t.base, zoomElapsed);
				this.setOpacity(t.base, '1');
				this.setOpacity(t.top, '0');
				this.stopZoom(t.top);
				t.orig.setAttribute(HIDE_ATTR, '1');
				t.shown = true;
			}
			this.currentUrl = url;
		} finally {
			this.busy = false;
		}
	}
}

interface CacheEntry {
	at: number;
	files: string[];
}
const cache = new Map<number, CacheEntry>();
let current: Cycle | undefined;
let starting = 0;
let tickTimer: number | undefined;
const nextPick = new Map<number, { file: string; img: HTMLImageElement }>();
let watchedDoc: Document | undefined;
let docObserver: MutationObserver | undefined;
let lastTickAt = 0;
let tickScheduled = false;

function runTick() {
	lastTickAt = Date.now();
	void tick().catch((e) => log('tick error', e));
}

function scheduleTick() {
	const wait = 30 - (Date.now() - lastTickAt);
	if (wait <= 0) return runTick();
	if (tickScheduled) return;
	tickScheduled = true;
	setTimeout(() => {
		tickScheduled = false;
		runTick();
	}, wait);
}

function watchDocument(doc: Document) {
	if (watchedDoc === doc) return;
	docObserver?.disconnect();
	watchedDoc = doc;
	const MO = (doc.defaultView as any)?.MutationObserver ?? MutationObserver;
	docObserver = new MO(scheduleTick);
	docObserver!.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
}

function prefetchNext(appid: number, files: string[]) {
	if (files.length < 2) return;
	const used = nextPick.get(appid);
	const file = files[Math.floor(Math.random() * files.length)];
	if (used?.file === file) return;
	const img = new Image();
	img.src = urlFor(appid, file);
	nextPick.set(appid, { file, img });
}

function hideOriginals(doc: Document, heroes: HTMLImageElement[]) {
	ensureStyle(doc);
	for (const h of heroes) h.setAttribute(HIDE_ATTR, '1');
}

async function loadFiles(appid: number): Promise<string[]> {
	const hit = cache.get(appid);
	if (hit && Date.now() - hit.at < REFETCH_AFTER_MS) return hit.files;
	try {
		const res = await getScreenshots(appid);
		if (res && res.ok === false) log('backend error:', res.error);
		const files: string[] = Array.isArray(res?.files) ? res.files : [];
		cache.set(appid, { at: Date.now(), files });
		return files;
	} catch (e) {
		log('backend call failed', e);
		return [];
	}
}

const urlFor = (appid: number, file: string) => `${CACHE_URL_BASE}/${appid}/${encodeURIComponent(file)}`;

function stopCurrent() {
	starting++;
	current?.stop();
	current = undefined;
}

let missingTicks = 0;
let pendingAppId: number | undefined;

async function tick() {
	const doc = getMainDocument();
	if (!doc) return status('main window not found yet');
	watchDocument(doc);

	let heroes = findHeroImages(doc);
	if (heroes.length === 0) {
		if (++missingTicks >= 6 && current) stopCurrent();
		return status('no hero image on this page (not a game page, or selectors need updating)');
	}
	missingTicks = 0;

	const appid = detectAppId(heroes[0].src, doc);
	if (!appid) return status('hero found but could not detect appid: ' + heroes[0].src);

	const classic = readClassic();
	if (current && current.appid === appid && current.classic === classic) {
		current.syncGeometry();
		current.maintain(heroes);
		return;
	}
	if (pendingAppId === appid) return;
	if (current) stopCurrent();

	if (classic) {
		const known = cache.get(appid);
		if (!known || known.files.length) hideOriginals(doc, heroes);
	}

	pendingAppId = appid;
	const token = ++starting;
	let files: string[];
	try {
		files = await loadFiles(appid);
	} finally {
		if (pendingAppId === appid) pendingAppId = undefined;
	}
	if (token !== starting) return;

	const fresh = findHeroImages(doc);
	if (fresh.length) heroes = fresh;

	if (files.length === 0) {
		for (const h of heroes) h.removeAttribute(HIDE_ATTR);
		log(`app ${appid}: no screenshots, keeping default background`);
		current = new Cycle(appid, [], heroes, classic);
		return;
	}

	const queued = nextPick.get(appid);
	nextPick.delete(appid);
	const picked = queued && files.includes(queued.file) ? queued.file : files[Math.floor(Math.random() * files.length)];
	const pool = classic ? [picked] : files;
	log(`app ${appid}: ${classic ? 'classic mode' : `cycling ${files.length} screenshot(s)`}`);
	const cycle = new Cycle(
		appid,
		pool.map((f) => urlFor(appid, f)),
		heroes,
		classic,
	);
	current = cycle;
	await cycle.start();
	if (classic) prefetchNext(appid, files);
}

function SettingsPanel() {
	const { useState } = (window as any).SP_REACT;
	const [classic, setClassic] = useState(readClassic());
	const toggle = () => {
		writeClassic(!classic);
		setClassic(!classic);
	};
	return (
		<div style={{ padding: '16px 24px', color: '#dcdedf' }}>
			<label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', fontSize: '16px' }}>
				<input type="checkbox" checked={classic} onChange={toggle} style={{ width: '18px', height: '18px' }} />
				Classic Mode
			</label>
			<div style={{ marginTop: '8px', fontSize: '13px', opacity: 0.7 }}>
				Shows a random screenshot and doesn't cycle between them.
			</div>
		</div>
	);
}

export default definePlugin(() => {
	try {
		(window as any).Millennium?.AddWindowCreateHook?.(onWindowCreated);
	} catch {}

	tickTimer = window.setInterval(() => void tick().catch((e) => log('tick error', e)), TICK_MS);
	log('started');

	return {
		title: 'Memorable Screenshots',
		icon: <IconsModule.Settings />,
		content: <SettingsPanel />,
		onDismount() {
			if (tickTimer !== undefined) window.clearInterval(tickTimer);
			stopCurrent();
		},
	};
});
