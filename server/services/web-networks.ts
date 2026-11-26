import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { privateIPv4 } from './web-cert';
import type { WebNetwork } from '../../shared/protocol';

const run = promisify(execFile);
// Get the connected Windows network identity as well as the adapter and address.
const inventory = String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$profiles=[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]::GetConnectionProfiles()
$adapters=[Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()
$rows=foreach ($profile in $profiles) {
  if ($profile.GetNetworkConnectivityLevel() -eq 'None' -or !$profile.NetworkAdapter) { continue }
  $adapterId=$profile.NetworkAdapter.NetworkAdapterId
  $networkId=$profile.NetworkAdapter.NetworkItem.NetworkId
  if (!$networkId -or $networkId -eq [guid]::Empty) { continue }
  foreach ($nic in $adapters) {
    if ($nic.OperationalStatus -ne 'Up' -or $nic.Id.Trim('{}') -ne $adapterId.ToString()) { continue }
    foreach ($ip in $nic.GetIPProperties().UnicastAddresses) {
      if ($ip.Address.AddressFamily -ne 'InterNetwork') { continue }
      $address=$ip.Address.ToString()
      @{ id=("{0}/{1}/{2}" -f $networkId,$adapterId,$address); name=$profile.ProfileName; address=$address }
    }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress`;
export async function webNetworks(): Promise<WebNetwork[]> {
  if (process.platform !== 'win32') return [];
  const shell = path.join((process.env.SystemRoot ?? process.env.SYSTEMROOT)!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(inventory, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 10000, maxBuffer: 65536,
  });
  return (JSON.parse(stdout) as WebNetwork[]).filter(n => privateIPv4(n.address) && typeof n.id === 'string' && typeof n.name === 'string');
}
