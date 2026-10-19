param(
  [Parameter(Mandatory=$true, Position=0)][string]$Executable,
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments
)

$ErrorActionPreference = 'Stop'
# Every child inherits the same eight logical CPUs, including native helpers.
$CurrentProcess = [System.Diagnostics.Process]::GetCurrentProcess()
$AvailableCpus = $CurrentProcess.ProcessorAffinity.ToInt64()
$CpuMask = [long]0
$CpuCount = 0
for ($Bit = 0; $Bit -lt 63 -and $CpuCount -lt 8; $Bit++) {
  $CandidateCpu = ([long]1 -shl $Bit)
  if (($AvailableCpus -band $CandidateCpu) -ne 0) {
    $CpuMask = $CpuMask -bor $CandidateCpu
    $CpuCount++
  }
}
$CurrentProcess.ProcessorAffinity = [IntPtr]$CpuMask
$env:GOMAXPROCS = '8'
$env:CMAKE_BUILD_PARALLEL_LEVEL = '8'
$env:npm_config_jobs = '8'
$env:OMP_NUM_THREADS = '8'
$env:OPENBLAS_NUM_THREADS = '8'
$env:MKL_NUM_THREADS = '8'
& $Executable @Arguments
exit $LASTEXITCODE
