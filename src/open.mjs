// Open a URL in the user's default browser. Best effort: failure to open must never stop the relay.
import { spawn } from 'node:child_process';

// Only auto-open for an interactive human: not under CI, not when output is piped, not when asked not to.
export function shouldOpen({ noOpen = false, env = process.env, isTTY = process.stdout.isTTY } = {}) {
  if (noOpen) return false;
  if (env.WITNESSLOOP_NO_OPEN === '1' || env.CI) return false;
  return !!isTTY;
}

export function openCommand(url, platform = process.platform) {
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

export function openUrl(url, { platform = process.platform, run = spawn } = {}) {
  const { cmd, args } = openCommand(url, platform);
  try {
    const child = run(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
