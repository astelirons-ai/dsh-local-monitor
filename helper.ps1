#Requires -Version 5.1
<#
  dsh-local-monitor - host-side sensor collector.

  Runs as a long-lived child of the DSH Host process and prints one compact JSON
  object per line on stdout (one line per sample). Sources:

    * GPU  : GPU-Z shared memory ("GPUZShMem") - the same live numbers the GPU-Z
             Sensors tab shows: GPU temperature, GPU clock, dedicated VRAM used,
             VRAM size, load, power, fan. GPU-Z must be running.
    * CPU  : Windows sensor sources - temperature from the thermal zone
             (WMI perf class, then the ACPI WMI class), live clock from the
             processor performance data, load from Win32_Processor.
    * MEM  : GlobalMemoryStatusEx (physical memory in use).

  ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#>

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$parentPid = 0
$maxSamples = 0
for ($i = 0; $i -lt $args.Count - 1; $i++) {
  if ($args[$i] -eq '-ParentPid') { [void][int]::TryParse([string]$args[$i + 1], [ref]$parentPid) }
  if ($args[$i] -eq '-MaxSamples') { [void][int]::TryParse([string]$args[$i + 1], [ref]$maxSamples) }
}

$intervalMs = 1000
$slowEvery = 2
$tick = 0
$acpiDead = $false
$perfThermalDead = $false
$lastError = $null
$diag = @()

$cpuName = ''
$baseMhz = 0
$cachedTemp = $null
$cachedTempSource = $null
$cachedZones = @()
$cachedMhz = $null
$cachedPerfPct = $null
$cachedLoad = $null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshSensors
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr OpenFileMapping(uint access, bool inherit, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr MapViewOfFile(IntPtr handle, uint access, uint offsetHigh, uint offsetLow, UIntPtr bytes);

    [DllImport("kernel32.dll")]
    public static extern bool UnmapViewOfFile(IntPtr pointer);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX buffer);
}
'@

function Note([string]$message) {
  $script:lastError = $message
  $script:diag = @($script:diag + $message) | Select-Object -Last 6
}

# ---------------------------------------------------------------- GPU-Z shmem

$GPUZ_HEADER = 12
$GPUZ_RECORDS = 128
$GPUZ_DATA_SIZE = 1024
$GPUZ_SENSOR_SIZE = 540
$GPUZ_TOTAL = $GPUZ_HEADER + ($GPUZ_RECORDS * $GPUZ_DATA_SIZE) + ($GPUZ_RECORDS * $GPUZ_SENSOR_SIZE)
$buffer = New-Object byte[] $GPUZ_TOTAL

function Get-FixedString([byte[]]$bytes, [int]$offset, [int]$maxBytes) {
  $end = $offset
  $limit = $offset + $maxBytes
  while ($end + 1 -lt $limit) {
    if ($bytes[$end] -eq 0 -and $bytes[$end + 1] -eq 0) { break }
    $end += 2
  }
  if ($end -le $offset) { return '' }
  return [System.Text.Encoding]::Unicode.GetString($bytes, $offset, $end - $offset)
}

function Convert-Number($value) {
  if ($null -eq $value) { return $null }
  try { $d = [double]$value } catch { return $null }
  if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return $null }
  return [Math]::Round($d, 2)
}

function Get-GpuZSample {
  $handle = [DshSensors]::OpenFileMapping(0x0004, $false, 'GPUZShMem')
  if ($handle -eq [IntPtr]::Zero) {
    return @{ ok = $false; error = 'GPU-Z is not running (shared memory GPUZShMem not found)' }
  }
  try {
    $view = [DshSensors]::MapViewOfFile($handle, 0x0004, 0, 0, [UIntPtr]::Zero)
    if ($view -eq [IntPtr]::Zero) {
      return @{ ok = $false; error = 'GPU-Z shared memory could not be mapped' }
    }
    try {
      # GPU-Z raises a busy flag while it rewrites the block; retry a few times.
      $attempt = 0
      while ($attempt -lt 20) {
        [System.Runtime.InteropServices.Marshal]::Copy($view, $buffer, 0, $GPUZ_TOTAL)
        if ([BitConverter]::ToInt32($buffer, 4) -eq 0) { break }
        $attempt++
        [System.Threading.Thread]::Sleep(1)
      }
    } finally {
      [void][DshSensors]::UnmapViewOfFile($view)
    }
  } finally {
    [void][DshSensors]::CloseHandle($handle)
  }

  $lastUpdate = [BitConverter]::ToUInt32($buffer, 8)
  $ageMs = ([Environment]::TickCount - [long]$lastUpdate) -band 0x7FFFFFFF

  $data = @{}
  for ($i = 0; $i -lt $GPUZ_RECORDS; $i++) {
    $offset = $GPUZ_HEADER + ($i * $GPUZ_DATA_SIZE)
    $key = Get-FixedString $buffer $offset 512
    if (-not $key) { continue }
    if ($data.ContainsKey($key)) { continue }
    $data[$key] = Get-FixedString $buffer ($offset + 512) 512
  }

  $sensors = @{}
  $sensorBase = $GPUZ_HEADER + ($GPUZ_RECORDS * $GPUZ_DATA_SIZE)
  for ($i = 0; $i -lt $GPUZ_RECORDS; $i++) {
    $offset = $sensorBase + ($i * $GPUZ_SENSOR_SIZE)
    $name = Get-FixedString $buffer $offset 512
    if (-not $name) { continue }
    $sensors[$name] = @{
      value = [BitConverter]::ToDouble($buffer, $offset + 532)
      unit  = (Get-FixedString $buffer ($offset + 512) 16)
    }
  }

  $readSensor = {
    param([string]$sensorName)
    if (-not $sensors.ContainsKey($sensorName)) { return $null }
    return (Convert-Number $sensors[$sensorName].value)
  }

  $vramTotal = $null
  if ($data.ContainsKey('MemSize')) { $vramTotal = Convert-Number $data['MemSize'] }

  return @{
    ok          = $true
    name        = $data['CardName']
    chip        = $data['GPUName']
    driver      = $data['DriverVersion']
    vramTotalMB = $vramTotal
    vramUsedMB  = (& $readSensor 'Memory Used (Dedicated)')
    temp        = (& $readSensor 'GPU Temperature')
    hotSpot     = (& $readSensor 'GPU Temperature (Hot Spot)')
    memTemp     = (& $readSensor 'Memory Temperature')
    clock       = (& $readSensor 'GPU Clock')
    memClock    = (& $readSensor 'Memory Clock')
    load        = (& $readSensor 'GPU Load')
    power       = (& $readSensor 'Board Power Draw')
    voltage     = (& $readSensor 'GPU Voltage')
    fanPercent  = (& $readSensor 'Fan Speed (%)')
    fanRpm      = (& $readSensor 'Fan Speed (RPM)')
    cpuTemp     = (& $readSensor 'CPU Temperature')
    sysMemUsedMB = (& $readSensor 'System Memory Used')
    sensorAgeMs = [Math]::Max(0, $ageMs)
  }
}

# ---------------------------------------------------------------- CPU sensors

function Get-CpuStatic {
  if ($script:cpuName) { return }
  try {
    $cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1
    if ($cpu) {
      $script:cpuName = ([string]$cpu.Name).Trim()
      $script:baseMhz = [int]$cpu.MaxClockSpeed
    }
  } catch {
    Note ('Win32_Processor: ' + $_.Exception.Message)
  }
  if (-not $script:baseMhz) {
    try {
      $mhz = (Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0' -ErrorAction Stop).'~MHz'
      if ($mhz) { $script:baseMhz = [int]$mhz }
    } catch {}
  }
  if (-not $script:cpuName) {
    try {
      $script:cpuName = ([string](Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0' -ErrorAction Stop).ProcessorNameString).Trim()
    } catch {}
  }
}

function Normalize-Temp([double]$value) {
  if ($value -le 0 -or $value -ge 125) { return $null }
  return [Math]::Round($value, 1)
}

function Get-CpuTemperature {
  $best = $null
  $source = $null
  $detail = @()

  if (-not $script:perfThermalDead) {
    try {
      $zones = Get-CimInstance -ClassName 'Win32_PerfFormattedData_Counters_ThermalZoneInformation' -ErrorAction Stop
      foreach ($zone in $zones) {
        if ($null -eq $zone.Temperature) { continue }
        $celsius = [double]$zone.Temperature - 273.15
        $detail += @{ src = 'perf'; name = [string]$zone.Name; raw = [double]$zone.Temperature; c = [Math]::Round($celsius, 1) }
        $valid = Normalize-Temp $celsius
        if ($null -ne $valid -and ($null -eq $best -or $valid -gt $best)) {
          $best = $valid
          $source = 'perf'
        }
      }
    } catch {
      $script:perfThermalDead = $true
      Note ('thermal perf data: ' + $_.Exception.Message)
    }
  }

  if ($null -eq $best -and -not $script:acpiDead) {
    try {
      $zones = Get-CimInstance -Namespace 'root/wmi' -ClassName 'MSAcpi_ThermalZoneTemperature' -ErrorAction Stop
      foreach ($zone in $zones) {
        if ($null -eq $zone.CurrentTemperature) { continue }
        $celsius = ([double]$zone.CurrentTemperature / 10.0) - 273.15
        $detail += @{ src = 'acpi'; name = [string]$zone.InstanceName; raw = [double]$zone.CurrentTemperature; c = [Math]::Round($celsius, 1) }
        $valid = Normalize-Temp $celsius
        if ($null -ne $valid -and ($null -eq $best -or $valid -gt $best)) {
          $best = $valid
          $source = 'acpi'
        }
      }
    } catch {
      $script:acpiDead = $true
      Note ('ACPI thermal zone: ' + $_.Exception.Message)
    }
  }

  return @{ temp = $best; source = $source; zones = $detail }
}

function Get-CpuClock {
  $mhz = $null
  $pct = $null
  $load = $null
  try {
    $perf = Get-CimInstance -ClassName 'Win32_PerfFormattedData_Counters_ProcessorInformation' -Filter "Name='_Total'" -ErrorAction Stop |
      Select-Object -First 1
    if ($perf) {
      if ($null -ne $perf.PercentProcessorPerformance) {
        $pct = [double]$perf.PercentProcessorPerformance
        if ($pct -gt 0 -and $script:baseMhz -gt 0) {
          $mhz = [Math]::Round(($script:baseMhz * $pct) / 100.0, 0)
        }
      }
      if ($null -ne $perf.PercentProcessorTime) { $load = [int]$perf.PercentProcessorTime }
    }
  } catch {
    Note ('processor perf data: ' + $_.Exception.Message)
  }
  if ($null -eq $mhz) {
    try {
      $cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1
      if ($cpu -and $cpu.CurrentClockSpeed) { $mhz = [int]$cpu.CurrentClockSpeed }
    } catch {}
  }
  if ($null -eq $mhz -and $script:baseMhz -gt 0) { $mhz = $script:baseMhz }
  return @{ mhz = $mhz; percent = if ($null -ne $pct) { [Math]::Round($pct, 0) } else { $null }; load = $load }
}

function Get-CpuLoad {
  try {
    $cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1
    if ($cpu -and $null -ne $cpu.LoadPercentage) { return [int]$cpu.LoadPercentage }
  } catch {}
  return $null
}

function Get-CpuSample {
  if ((($script:tick - 1) % $script:slowEvery) -eq 0 -or $null -eq $script:cachedMhz) {
    Get-CpuStatic
    $thermal = Get-CpuTemperature
    $clock = Get-CpuClock
    $script:cachedTemp = $thermal.temp
    $script:cachedTempSource = $thermal.source
    $script:cachedZones = $thermal.zones
    $script:cachedMhz = $clock.mhz
    $script:cachedPerfPct = $clock.percent
    if ($null -ne $clock.load) { $script:cachedLoad = $clock.load } else { $script:cachedLoad = Get-CpuLoad }
  }
  return @{
    ok         = $true
    name       = $script:cpuName
    temp       = $script:cachedTemp
    tempSource = $script:cachedTempSource
    zones      = $script:cachedZones
    mhz        = $script:cachedMhz
    perfPct    = $script:cachedPerfPct
    baseMhz    = $script:baseMhz
    load       = $script:cachedLoad
  }
}

# ---------------------------------------------------------------- memory

function Get-MemorySample {
  $status = New-Object DshSensors+MEMORYSTATUSEX
  $status.dwLength = [System.Runtime.InteropServices.Marshal]::SizeOf($status)
  if (-not [DshSensors]::GlobalMemoryStatusEx([ref]$status)) {
    return @{ ok = $false; totalBytes = $null; usedBytes = $null; pct = $null }
  }
  $total = [double]$status.ullTotalPhys
  $used = $total - [double]$status.ullAvailPhys
  return @{
    ok         = $true
    totalBytes = [long]$total
    usedBytes  = [long]$used
    pct        = if ($total -gt 0) { [Math]::Round(($used / $total) * 100, 1) } else { $null }
  }
}

# ---------------------------------------------------------------- main loop

while ($true) {
  $started = [DateTime]::UtcNow
  $script:tick++

  $gpu = $null
  try { $gpu = Get-GpuZSample } catch { Note ('GPU-Z: ' + $_.Exception.Message); $gpu = @{ ok = $false; error = $_.Exception.Message } }

  $cpu = $null
  try { $cpu = Get-CpuSample } catch { Note ('CPU: ' + $_.Exception.Message); $cpu = @{ ok = $false; error = $_.Exception.Message } }

  # GPU-Z exposes a "CPU Temperature" sensor on some platforms; it reads the die
  # directly, so prefer it over the ACPI/chassis zone when GPU-Z publishes it.
  if ($cpu -and $cpu.ok -and $gpu -and $gpu.ok -and $null -ne $gpu.cpuTemp) {
    $cpu.temp = $gpu.cpuTemp
    $cpu.tempSource = 'gpu-z'
  }

  $memory = $null
  try { $memory = Get-MemorySample } catch { $memory = @{ ok = $false } }

  $payload = [ordered]@{
    ts    = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    gpu   = $gpu
    cpu   = $cpu
    mem   = $memory
    error = $script:lastError
    diag  = if ($script:diag.Count -gt 0) { $script:diag } else { $null }
  }
  $script:lastError = $null

  try {
    $json = ConvertTo-Json -InputObject $payload -Depth 6 -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  } catch {
    [Console]::Error.WriteLine('json: ' + $_.Exception.Message)
    [Console]::Error.Flush()
  }

  if ($parentPid -gt 0) {
    try { [void][System.Diagnostics.Process]::GetProcessById($parentPid) }
    catch { break }
  }

  $elapsed = ([DateTime]::UtcNow - $started).TotalMilliseconds
  $wait = [Math]::Max(150, $intervalMs - $elapsed)
  if ($maxSamples -gt 0 -and $script:tick -ge $maxSamples) { break }
  Start-Sleep -Milliseconds ([int]$wait)
}
