// Dev auto-reload: when this unpacked extension's files change on disk, reload the
// extension and then the open BGA tables so the new content scripts take effect.
// Only active for unpacked ("development") installs.

const FILES = ['manifest.json', 'src/background.js', 'src/inject.js', 'src/content.js'];
const BGA_TABS = ['https://boardgamearena.com/*', 'https://*.boardgamearena.com/*'];

// Unpacked extensions serve their files straight from disk, so this sees edits immediately.
const fingerprint = async () => {
  const texts = await Promise.all(
    FILES.map((f) => fetch(chrome.runtime.getURL(f), { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')))
  );
  return texts.join('\u0000');
};

const isDev = async () => (await chrome.management.getSelf()).installType === 'development';

const setBaseline = async () => {
  if (await isDev()) await chrome.storage.session.set({ baseline: await fingerprint() });
};

let checking = false;
const checkForChanges = async () => {
  if (checking) return;
  checking = true;
  try {
    const { baseline } = await chrome.storage.session.get('baseline');
    if (baseline == null) return setBaseline();
    if ((await fingerprint()) !== baseline) {
      console.log('[agr-rec] source changed, reloading extension');
      chrome.runtime.reload();
    }
  } catch (e) {
    console.warn('[agr-rec] change check failed', e);
  } finally {
    checking = false;
  }
};

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await setBaseline();
  if (reason !== 'update' || !(await isDev())) return;
  // Old content scripts are orphaned after a reload; refresh game tables so they get the new ones.
  const tabs = await chrome.tabs.query({ url: BGA_TABS });
  for (const tab of tabs) {
    if (/[?&]table=\d+/.test(tab.url || '') || /\/archive\/replay\//.test(tab.url || '')) chrome.tabs.reload(tab.id);
  }
});

chrome.runtime.onStartup.addListener(setBaseline);

// content.js pings while a game is open; each ping also keeps this worker awake.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'agr-dev-check') isDev().then((dev) => dev && checkForChanges());
});
