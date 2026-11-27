import { WEB_SHIPS } from '../../shared/protocol';

/**
 * Whether web access is in this run: the one function every part of the bridge asks (the listener, its
 * methods, the hello that tells the window). `WEB_SHIPS` (false until web access is cleared to ship), or
 * the owner's own switch for one run of the released app: `Sable.exe --web`, or `SABLE_WEB=1` in its
 * environment. Nothing else turns it on; without either the web methods answer off and the window shows
 * nothing of it. Read at each call (a test may set the environment).
 */
export function webOn(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  return WEB_SHIPS || env.SABLE_WEB === '1' || argv.includes('--web');
}
