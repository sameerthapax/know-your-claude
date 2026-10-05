# brain-bar sound player: mixes quiet looping music with short effects.
# The mod writes numbered commands to commands.txt in -Dir:
#   "<n> sfx <name>"   play <name>.wav once, over anything else playing
#   "<n> music start"  start the looping music.wav, quietly
#   "<n> music stop"   stop the music
#   "<n> quit"         stop everything and exit
# It exits by itself when:
#   - a newer player starts (player.pid holds the newest player's process id)
#   - alive.txt goes 6 seconds without being touched (the mod touches it every
#     2 seconds while a test is open, so a lost "quit" still ends the music)
#   - 15 minutes pass without a command
param([string]$Dir)

Add-Type -AssemblyName PresentationCore
$commands = Join-Path $Dir 'commands.txt'
$log = Join-Path $Dir 'player.log'
$pidFile = Join-Path $Dir 'player.pid'
$alive = Join-Path $Dir 'alive.txt'
$startedAt = [DateTime]::Now
Set-Content $pidFile $PID
$musicVolume = 0.06
$sfxVolume = 0.55

# Ignore commands written before this player started
$last = -1
if (Test-Path $commands) {
  foreach ($line in (Get-Content $commands -ErrorAction SilentlyContinue)) {
    $n = 0
    if ([int]::TryParse(($line -split ' ')[0], [ref]$n) -and $n -gt $last) { $last = $n }
  }
}

$music = $null
$effects = New-Object System.Collections.ArrayList
$lastCommandAt = [DateTime]::Now
$loops = 0
"started pid=$PID $(Get-Date -Format o) last=$last" | Set-Content $log

function Stop-All([string]$why) {
  if ($music) { $music.Stop(); $music.Close() }
  foreach ($p in $effects) { $p.Stop(); $p.Close() }
  "$why $(Get-Date -Format o)" | Add-Content $log
  exit
}

function New-Player([string]$name, [double]$volume) {
  $p = New-Object System.Windows.Media.MediaPlayer
  $p.Volume = $volume
  $p.Open([uri](Join-Path $Dir "$name.wav"))
  $p.Play()
  return $p
}

while ($true) {
  if (Test-Path $commands) {
    foreach ($line in (Get-Content $commands -ErrorAction SilentlyContinue)) {
      $parts = $line -split ' ', 3
      $n = 0
      if (-not [int]::TryParse($parts[0], [ref]$n) -or $n -le $last) { continue }
      $last = $n
      $lastCommandAt = [DateTime]::Now
      "cmd $line" | Add-Content $log
      switch ($parts[1]) {
        'sfx' { [void]$effects.Add((New-Player $parts[2] $sfxVolume)) }
        'music' {
          if ($parts[2] -eq 'start' -and -not $music) { $music = New-Player 'music' $musicVolume }
          elseif ($parts[2] -eq 'stop' -and $music) { $music.Stop(); $music.Close(); $music = $null }
        }
        'status' {
          $at = if ($music) { "$($music.Position) of $($music.NaturalDuration)" } else { 'none' }
          "status music=$at effects=$($effects.Count)" | Add-Content $log
        }
        'quit' {
          if ($music) { $music.Stop(); $music.Close() }
          Start-Sleep -Milliseconds 2500   # let a last effect finish
          "quit $(Get-Date -Format o)" | Add-Content $log
          exit
        }
      }
    }
  }

  # Loop the music when it reaches its end
  if ($music -and $music.NaturalDuration.HasTimeSpan -and $music.Position -ge $music.NaturalDuration.TimeSpan) {
    $music.Position = [TimeSpan]::Zero
    $music.Play()
  }

  # Close effects that have finished
  for ($i = $effects.Count - 1; $i -ge 0; $i--) {
    $p = $effects[$i]
    if ($p.NaturalDuration.HasTimeSpan -and $p.Position -ge $p.NaturalDuration.TimeSpan) { $p.Close(); $effects.RemoveAt($i) }
  }

  # About twice a second: am I still the newest player, and is the mod still there?
  $loops++
  if ($loops % 15 -eq 0) {
    $newest = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ("$newest".Trim() -ne "$PID") { Stop-All 'replaced by a newer player' }
    $since = if (Test-Path $alive) { (Get-Item $alive).LastWriteTime } else { $startedAt }
    if (([DateTime]::Now - $since).TotalSeconds -gt 6) { Stop-All 'no heartbeat from the mod' }
  }
  if (([DateTime]::Now - $lastCommandAt).TotalMinutes -gt 15) { Stop-All 'idle exit' }
  Start-Sleep -Milliseconds 30
}
