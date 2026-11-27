import path from 'node:path';
import { privateIPv4 } from './web-cert';
import { runOff } from './web-run';
import type { WebNetwork } from '../../shared/protocol';

/**
 * The Wi-Fi and Ethernet networks this computer is connected to, one row per IPv4 address: physical
 * adapters only (`MSFT_NetAdapter.HardwareInterface`: no Hyper-V, WSL, VPN or Tailscale adapter), with
 * Windows' own network profile (`MSFT_NetConnectionProfile`: its id names the network, so another Wi-Fi
 * on the same adapter and address is another network; its category says whether the person made it
 * private). A Wi-Fi reads by its name (the profile's, which is the network's SSID), an Ethernet by
 * its adapter's ("Ethernet"), the names Windows' own network settings show. One PowerShell run of
 * about 1 to 2.5 s, never on the bridge's thread (asked once per 30 or 60 s at most: web-look.ts).
 */
const inventory = String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$adapters=@{}
foreach ($a in Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapter -Filter 'HardwareInterface = TRUE') { $adapters[[int]$a.InterfaceIndex]=$a }
$nics=@{}
foreach ($nic in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) { if ($nic.OperationalStatus -eq 'Up') { $nics[$nic.Id.Trim('{}').ToLower()]=$nic } }
$rows=foreach ($p in Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetConnectionProfile) {
  $a=$adapters[[int]$p.InterfaceIndex]
  if (!$a -or ($a.InterfaceType -ne 71 -and $a.InterfaceType -ne 6) -or !$p.InstanceID) { continue }
  $guid=$a.InterfaceGuid.Trim('{}').ToLower()
  $nic=$nics[$guid]
  if (!$nic) { continue }
  $wifi=$a.InterfaceType -eq 71
  foreach ($ip in $nic.GetIPProperties().UnicastAddresses) {
    if ($ip.Address.AddressFamily -ne 'InterNetwork') { continue }
    $address=$ip.Address.ToString()
    @{ id=('{0}/{1}/{2}' -f $p.InstanceID.Trim('{}').ToLower(),$guid,$address); name=$(if ($wifi) { [string]$p.Name } else { [string]$nic.Name }); address=$address; kind=$(if ($wifi) { 'wifi' } else { 'ethernet' }); private=($p.NetworkCategory -ne 0) }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress`;

/** A connected network as the inventory reads it: `private` false is Windows' Public profile. */
export interface ReadNetwork extends WebNetwork { private?: boolean }

export async function webNetworks(): Promise<ReadNetwork[]> {
  if (process.platform !== 'win32') return [];
  const shell = path.join((process.env.SystemRoot ?? process.env.SYSTEMROOT)!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  // Started from a worker: a process start holds the thread it starts from (web-run.ts).
  const out = await runOff(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(inventory, 'utf16le').toString('base64')],
    process.env, { timeout: 15_000, maxBuffer: 65536 });
  return readRows(JSON.parse(out.toString('utf8')));
}

/** Rows of the expected shape only (whatever else the run printed is dropped). */
export function readRows(rows: unknown): ReadNetwork[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((n): n is ReadNetwork => !!n && typeof n.id === 'string' && typeof n.name === 'string' && typeof n.address === 'string' && privateIPv4(n.address))
    .map(n => ({ id: n.id, name: n.name.trim() || (n.kind === 'wifi' ? 'Wi-Fi' : 'Ethernet'), address: n.address,
      ...(n.kind === 'wifi' || n.kind === 'ethernet' ? { kind: n.kind } : {}), ...(n.private === false ? { private: false } : {}) }));
}

/**
 * What can be served on: private networks (a row without the flag is one, as a test's), one row per
 * network and address, and never an address two networks claim. The public ones are named apart, so
 * Settings can say which network to make private.
 */
export function servable(rows: ReadNetwork[]): { networks: WebNetwork[]; publicNames: string[] } {
  const usable = rows.filter(n => n.private !== false && privateIPv4(n.address));
  const networks = usable.filter((n, i) => usable.findIndex(r => r.id === n.id) === i && !usable.some(r => r.address === n.address && r.id !== n.id))
    .map(n => ({ id: n.id, name: n.name, address: n.address, ...(n.kind ? { kind: n.kind } : {}) }));
  const publicNames = [...new Set(rows.filter(n => n.private === false).map(n => n.name))];
  return { networks, publicNames };
}
